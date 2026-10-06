import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseReport, readReport, listReportFiles, parseScore, splitSections, isReservedReportFile } from '../../server/domains/reports.js';
import { readTracker, postedFromNotes, pdfPresent } from '../../server/domains/tracker.js';
import { parsePipeline, parseRankCell, readPipeline, seniorityOf, sourceOf } from '../../server/domains/pipeline.js';
import { parseShortlist, readShortlist } from '../../server/domains/shortlist.js';
import { parseFollowups, parseNextOverrides } from '../../server/domains/followups.js';
import { parseTsv, readText } from '../../server/domains/files.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { copyFixtureRoot } from '../helpers/app.js';

const EM_DASH = String.fromCharCode(0x2014);
const root = copyFixtureRoot();

describe('files', () => {
  it('distinguishes a missing file from a readable one', () => {
    expect(readText(path.join(root, 'nope.md'))).toEqual({ kind: 'missing', path: path.join(root, 'nope.md') });
    const r = readText(path.join(root, 'cv.md'));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });
  it('parses TSV by header and tolerates short rows', () => {
    expect(parseTsv('a\tb\n1\t2\n3\n')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '' }]);
  });
});

describe('reports', () => {
  it('lists numbered reports and ignores RESERVED placeholders', () => {
    const files = listReportFiles(root);
    expect([...files.keys()]).toEqual([1, 2, 3, 4, 6, 7]);
    expect(isReservedReportFile('005-RESERVED.md')).toBe(true);
    expect(readReport(root, 5)).toMatchObject({ kind: 'reserved', file: '005-RESERVED.md' });
  });

  it('parses the header, Machine Summary and the Block A table oferta writes', () => {
    const r = readReport(root, 1);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.report).toMatchObject({
      company: 'Acme Robotics',
      role: 'Senior Backend Engineer',
      score: 4.3,
      legitimacy: 'High Confidence',
      archetype: 'Backend Platform Engineer',
      finalDecision: 'Apply',
      discardReasons: [],
      remote: 'hybrid (Austin, TX, 3 days on site)',
      comp: '$170k-$195k',
    });
    expect(r.report.tldr).toMatch(/^Senior backend role/);
    expect(r.report.via).toBeNull();
    expect(r.report.sections.map((s) => s.letter)).toEqual([null, 'A', 'B', 'C', 'D', 'E', 'F', 'G', null, null, null, null, null]);
  });

  it('keeps an archived JD whose text has its own ## headings as one section, after every section of the report template (SW5-tests-12)', () => {
    const r = readReport(root, 1);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.report.sections.map((s) => s.heading)).toEqual([
      'Machine Summary', 'A) Role Summary', 'B) Match with CV', 'C) Level and Strategy', 'D) Comp and Demand', 'E) Customization Plan', 'F) Interview Plan', 'G) Posting Legitimacy',
      'Risk Summary', 'Score Evidence', 'Keywords extracted', 'Keyword Coverage', 'Job Description (archived verbatim)',
    ]);
    const jd = r.report.sections.at(-1)!.content;
    expect(jd.startsWith('Posted: 2026-09-15')).toBe(true);
    expect(jd).toContain('## Responsibilities');
    expect(jd).toContain('## Requirements');
    expect(jd.endsWith('Reports to the Director of Platform Engineering.')).toBe(true);
    // A report section after the JD still starts its own section.
    const after = splitSections('## Job Description (archived verbatim)\nPosted: today\n\n## About us\nWe build.\n\n## Cover Letter Draft\nDear team');
    expect(after.sections.map((s) => s.heading)).toEqual(['Job Description (archived verbatim)', 'Cover Letter Draft']);
    expect(after.sections[0]!.content).toBe('Posted: today\n\n## About us\nWe build.');
  });

  it('keeps a JD heading that only starts like a report section inside the archived JD, while a template heading with its own note still ends it (SW5-tests-12 review)', () => {
    const { sections } = splitSections('## Job Description (archived verbatim)\nPosted: today\n\n## Risk Summary and Mitigations\nOwn the risk register.\n\n## Step 0 of onboarding\nShadow.\n\n## Liveness gate (URL inputs)\nLive.\n\n## Risk Summary\nNone.');
    expect(sections.map((s) => s.heading)).toEqual(['Job Description (archived verbatim)', 'Liveness gate (URL inputs)', 'Risk Summary']);
    expect(sections[0]!.content).toContain('## Risk Summary and Mitigations\nOwn the risk register.');
    expect(sections[0]!.content).toContain('## Step 0 of onboarding');
  });

  it('keeps a report\'s **URL:** only when it is a real http(s) URL, cleaned the way merge-tracker.mjs cleans it (SW2-server-06)', () => {
    const url = (value: string) => parseReport(`# Evaluation: Acme - Eng\n\n**URL:** ${value}\n**Score:** 4/5\n`, '010-acme.md', 10).url;
    // N/A is legitimate for recruiter-sourced roles (merge-tracker.mjs resolveReportUrl).
    expect(url('N/A')).toBeNull();
    expect(url('-')).toBeNull();
    expect(url('javascript:alert(1)')).toBeNull();
    expect(url('<https://jobs.example.com/acme/1>')).toBe('https://jobs.example.com/acme/1');
    expect(url('https://jobs.example.com/acme/2).')).toBe('https://jobs.example.com/acme/2');
    expect(url('https://jobs.example.com/acme/3')).toBe('https://jobs.example.com/acme/3');
  });

  it('still reads a Block A written as bullets, and its Comp line when the Machine Summary has no advertised_comp', () => {
    const md = '# Evaluation: Acme - Eng\n\n**Score:** 4/5\n\n## A) Role Summary\n- Remote: full remote\n- Comp: $150k\n- TL;DR: Good fit.\n';
    expect(parseReport(md, '010-acme.md', 10)).toMatchObject({ remote: 'full remote', comp: '$150k', tldr: 'Good fit.' });
  });

  it('an empty Block A bullet stays empty instead of taking the next line (R8-07)', () => {
    const md = '# Evaluation: Acme - Eng\n\n**Score:** 4/5\n\n## A) Role Summary\n- Remote:\n- Comp: $150k\n';
    expect(parseReport(md, '010-acme.md', 10)).toMatchObject({ remote: null, comp: '$150k' });
  });

  it('splits the title once, at the em dash or " -- " the templates write, so a role with " - " in it stays whole (R8-18)', () => {
    const doc = (title: string) => `# ${title}\n\n**Score:** 4/5\n\n## A) Role Summary\n`;
    expect(parseReport(doc('Bewertung: Acme -- Software Engineer - Platform'), '011-acme.md', 11)).toMatchObject({ company: 'Acme', role: 'Software Engineer - Platform' });
    expect(parseReport(doc(`Evaluation: Acme ${EM_DASH} Software Engineer - Platform`), '011-acme.md', 11)).toMatchObject({ company: 'Acme', role: 'Software Engineer - Platform' });
    expect(parseReport(doc(`Evaluation: Acme - Labs ${EM_DASH} Engineer -- Data`), '011-acme.md', 11)).toMatchObject({ company: 'Acme - Labs', role: 'Engineer -- Data' });
    // The templates write `{Company} <em dash> {Role}`, so a company name with " - " in it keeps its dash.
    expect(parseReport(doc(`Evaluation: Deloitte - US ${EM_DASH} Senior Engineer`), '011-acme.md', 11)).toMatchObject({ company: 'Deloitte - US', role: 'Senior Engineer' });
    // A hand-written title with only a plain dash still splits there.
    expect(parseReport(doc('Evaluation: Acme - Engineer'), '011-acme.md', 11)).toMatchObject({ company: 'Acme', role: 'Engineer' });
  });

  it('reads discard reasons and the cover letter PDF path', () => {
    const skip = readReport(root, 4);
    // The report writer emits codes (batch-prompt.md: salary_too_low, ...); the parser keeps them as written.
    expect(skip.kind === 'ok' && skip.report.discardReasons).toEqual(['salary_too_low', 'staffing_agency']);
    const cover = readReport(root, 3);
    expect(cover.kind === 'ok' && cover.report.coverPdf).toBe('output/globex-payments-cover.pdf');
  });

  it('reports a malformed file with a reason, and a missing number as missing', () => {
    expect(readReport(root, 7)).toMatchObject({ kind: 'malformed', file: '007-broken.md', line: 1 });
    expect(readReport(root, 99)).toEqual({ kind: 'missing', num: 99 });
  });

  it('flags invalid Machine Summary YAML with a line number', () => {
    const md = `# Evaluation: X ${EM_DASH} Y\n\n**Score:** 4/5\n\n## Machine Summary\n\`\`\`yaml\nscore: [unclosed\n\`\`\`\n`;
    expect(() => parseReport(md, 'x.md', 9)).toThrow(/Machine Summary YAML is invalid/);
  });

  it('treats the em dash and dash sentinels as no score', () => {
    expect(parseScore(EM_DASH)).toBeNull();
    expect(parseScore('-')).toBeNull();
    expect(parseScore('4.5/5')).toBe(4.5);
    expect(parseScore('4/5')).toBe(4);
  });

  it('splits sections without being fooled by headings inside fences', () => {
    const { intro, sections } = splitSections('intro\n```\n## not a heading\n```\n## A) Role\nbody');
    expect(intro).toContain('intro');
    expect(sections).toEqual([{ heading: 'A) Role', letter: 'A', content: 'body' }]);
  });
});

describe('tracker', () => {
  it('reads rows through the core parser and joins report summaries, posted dates and last contact', async () => {
    const t = await readTracker(DEFAULT_CODE_ROOT, root);
    expect(t.kind).toBe('ok');
    if (t.kind !== 'ok') return;
    expect(t.rows).toHaveLength(6);
    const acme = t.rows.find((r) => r.num === 1)!;
    expect(acme).toMatchObject({ company: 'Acme Robotics', score: 4.3, status: 'Applied', pdf: true, report: 1, posted: '2026-09-15', lastContact: '2026-09-28', reportState: 'ok' });
    expect(acme.summary?.archetype).toBe('Backend Platform Engineer');
    const umbrella = t.rows.find((r) => r.num === 5)!;
    expect(umbrella).toMatchObject({ score: null, scoreRaw: EM_DASH, pdf: false, report: null, reportState: 'none', lastContact: null });
  });

  it('reads a status by its states.yml label, any case, bold or alias, and keeps an unknown one as written (SW-web-a-02)', async () => {
    const r = copyFixtureRoot();
    const row = (n: number, status: string) => `| ${n} | 2026-09-2${n} | Co ${n} | - | Engineer | 4.0/5 | ${status} | - | - | |`;
    const statuses = ['applied', 'aplicado', '**Skip**', 'evaluada', 'Mystery'];
    fs.writeFileSync(path.join(r, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n${statuses.map((s, i) => row(i + 1, s)).join('\n')}\n`);
    const t = await readTracker(DEFAULT_CODE_ROOT, r);
    expect(t.kind === 'ok' && t.rows.map((x) => x.status)).toEqual(['Applied', 'Applied', 'SKIP', 'Evaluated', 'Mystery']);
  });

  it('on a tracker with a URL column, an empty or non-URL cell falls back to the report\'s posting URL, and a real one is cleaned (SW3-server-02)', async () => {
    const r = copyFixtureRoot();
    // merge-tracker.mjs --backfill-urls adds the column; a later addition with no url writes an empty cell.
    const row = (n: number, url: string) => `| ${n} | 2026-09-2${n} | Acme Robotics | - | Engineer | 4.0/5 | Applied | - | [1](../reports/001-acme-robotics.md) | | ${url} |`;
    fs.writeFileSync(
      path.join(r, 'data', 'applications.md'),
      `# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes | URL |\n|---|---|---|---|---|---|---|---|---|---|---|\n${[row(1, ''), row(2, 'N/A'), row(3, EM_DASH), row(4, '<https://boards.example.com/acme/9>'), row(5, 'https://boards.example.com/acme/10')].join('\n')}\n`,
    );
    const t = await readTracker(DEFAULT_CODE_ROOT, r);
    expect(t.kind === 'ok' && t.rows.map((x) => x.url)).toEqual([
      'https://jobs.example.com/acme/123',
      'https://jobs.example.com/acme/123',
      'https://jobs.example.com/acme/123',
      'https://boards.example.com/acme/9',
      'https://boards.example.com/acme/10',
    ]);
  });

  it('returns missing for an absent tracker and malformed for a tracker without a table', async () => {
    const empty = copyFixtureRoot();
    fs.rmSync(path.join(empty, 'data', 'applications.md'));
    expect((await readTracker(DEFAULT_CODE_ROOT, empty)).kind).toBe('missing');
    fs.writeFileSync(path.join(empty, 'data', 'applications.md'), '# Tracker\n\nno table here\n');
    expect(await readTracker(DEFAULT_CODE_ROOT, empty)).toMatchObject({ kind: 'malformed' });
  });

  it('treats a header-only tracker as a valid empty tracker, not a malformed one', async () => {
    const empty = copyFixtureRoot();
    fs.writeFileSync(path.join(empty, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    expect(await readTracker(DEFAULT_CODE_ROOT, empty)).toMatchObject({ kind: 'ok', rows: [] });
  });

  it.each([
    ['a "num" first column', '| num | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|-----|------|---------|------|-------|--------|-----|--------|-------|\n'],
    ['a header that does not start with the number column', '| Company | Role | # | Date | Score | Status | PDF | Report | Notes |\n|---------|------|---|------|-------|--------|-----|--------|-------|\n'],
  ])('treats a header-only tracker with %s as empty, not malformed', async (_name, table) => {
    const empty = copyFixtureRoot();
    fs.writeFileSync(path.join(empty, 'data', 'applications.md'), `# Applications Tracker\n\n${table}`);
    expect(await readTracker(DEFAULT_CODE_ROOT, empty)).toMatchObject({ kind: 'ok', rows: [] });
  });

  it('still reports malformed when the table has data lines but none parse', async () => {
    const bad = copyFixtureRoot();
    fs.writeFileSync(path.join(bad, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| x | y |\n');
    expect(await readTracker(DEFAULT_CODE_ROOT, bad)).toMatchObject({ kind: 'malformed' });
  });

  it('helper parsers handle sentinels', () => {
    expect(postedFromNotes('posted: 2026-09-15; Req #1')).toBe('2026-09-15');
    expect(postedFromNotes('nothing')).toBeNull();
    expect(pdfPresent(EM_DASH)).toBe(false);
    expect(pdfPresent('-')).toBe(false);
    expect(pdfPresent('✅')).toBe(true);
  });

  it('reads merge-tracker.mjs\'s no-PDF marker as no PDF (SW-tests-19)', () => {
    // merge-tracker.mjs writes ❌ for a row without a PDF and flips it to ✅ once pdf-index.tsv has one.
    expect(pdfPresent('❌')).toBe(false);
  });
});

describe('pipeline', () => {
  it('reads scan.mjs\'s Spanish section headings, Pendientes and Procesadas (SW-tests-19)', () => {
    const rows = parsePipeline('# Pipeline\n\n## Pendientes\n\n- [ ] https://jobs.example.com/a | A Co | Role\n\n## Procesadas\n\n- [x] https://jobs.example.com/b | B Co | Role\n');
    expect(rows.map((r) => [r.url, r.section])).toEqual([
      ['https://jobs.example.com/a', 'pending'],
      ['https://jobs.example.com/b', 'done'],
    ]);
  });

  it('parses checkbox rows with labels, sections and rank reasons containing the em dash', () => {
    const rows = parsePipeline(fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8'));
    expect(rows).toHaveLength(9);
    const acme = rows[0]!;
    expect(acme).toMatchObject({ company: 'Acme Robotics', location: 'Austin, TX', rank: 4.4, rankReason: 'strong backend match, sponsors visas', postedAt: '2026-09-15', done: false, section: 'pending', seniority: 'senior' });
    expect(rows.find((r) => r.company === 'Initech Cloud')).toMatchObject({ done: true, rank: null, section: 'pending' });
    // The Processed row is in the shape the app writes when it moves an evaluated posting (#NNN | URL | ...).
    expect(rows.find((r) => r.company === 'Old Corp')).toMatchObject({ url: 'https://jobs.example.com/oldcorp/1', role: 'Engineer', location: null, section: 'done', done: true });
    expect(rows.some((r) => r.url === 'not a checkbox line')).toBe(false);
    // Every row shape pipeline mode and the liveness sweep write (SW5-tests-02).
    expect(rows.find((r) => r.url === 'https://www.linkedin.com/jobs/view/4100000001')).toMatchObject({ needsJd: true, done: false, note: 'Error: login required', section: 'pending' });
    expect(rows.find((r) => r.company === 'Kramerica Industries')).toMatchObject({ role: 'Import Analyst', done: true, needsJd: false, section: 'done' });
    expect(rows.find((r) => r.url === 'https://jobs.example.com/pendant/3')).toMatchObject({ company: '', done: true, section: 'done', note: 'skipped (pre-screen mismatch: requires on-site in Palo Alto)' });
  });

  it('reads every documented Processed row shape: #NNN, a report link, a #-- pre-screen skip and a struck-out expired row (SW5-server-01)', () => {
    const rows = parsePipeline([
      '## Processed',
      '- [x] #042 | https://jobs.example.com/acme/42 | Acme | Backend Engineer | 4.2/5 | PDF ❌',
      '- [x] [043](reports/043-globex-2026-10-01.md) | https://jobs.example.com/globex/43 | Globex | SRE | 3.9/5 | PDF ✅',
      '- [x] #-- | https://jobs.example.com/skip/1 | skipped (pre-screen mismatch: no visa)',
      `- [x] ~~https://jobs.example.com/gone/7 | Gone Inc | PM~~ ${String.fromCharCode(0x2014)} posting expired (liveness sweep)`,
      '- [x] https://jobs.example.com/plain/8 | Plain | Dev | Remote',
      '- [x] ~~Dead Co | Role~~ - oferta nieaktywna',
      '',
    ].join('\n'));
    expect(rows.map((r) => [r.url, r.company, r.role, r.location, r.compensation, r.done, r.section])).toEqual([
      ['https://jobs.example.com/acme/42', 'Acme', 'Backend Engineer', null, null, true, 'done'],
      ['https://jobs.example.com/globex/43', 'Globex', 'SRE', null, null, true, 'done'],
      ['https://jobs.example.com/skip/1', '', '', null, null, true, 'done'],
      ['https://jobs.example.com/gone/7', 'Gone Inc', 'PM', null, null, true, 'done'],
      ['https://jobs.example.com/plain/8', 'Plain', 'Dev', 'Remote', null, true, 'done'],
    ]);
    expect(rows[2]!.note).toBe('skipped (pre-screen mismatch: no visa)');
    expect(rows.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it('keeps a pending row whose posting is a local:jds/ reference, as archive-posting and the Apify provider write it (SW8-web-a-03)', () => {
    const rows = parsePipeline('## Pending\n\n- [ ] local:jds/2026-10-06_acme_pm.pdf | Acme | PM\n- [ ] local:jds/apify-acme-staff.md | Acme | Staff Engineer | Remote\n- [ ] local:jds/../cv.md | Evil | Role\n- [ ] local:/etc/passwd | Evil | Role\n- [ ] local:reports/001-x.md | Evil | Role\n');
    expect(rows.map((r) => r.url)).toEqual(['local:jds/2026-10-06_acme_pm.pdf', 'local:jds/apify-acme-staff.md']);
    expect(rows[0]).toMatchObject({ company: 'Acme', role: 'PM', section: 'pending', done: false, line: 3 });
    expect(rows[1]).toMatchObject({ company: 'Acme', role: 'Staff Engineer', location: 'Remote' });
    expect(sourceOf('local:jds/apify-acme-staff.md', null)).toBe('local');
  });

  it('reads a [!] row pipeline mode wrote for a URL it could not fetch as open and needing the JD, with its error as the note (SW5-tests-02)', () => {
    const dash = String.fromCharCode(0x2014);
    const rows = parsePipeline(['## Pending', `- [!] https://private.example/job/1 ${dash} Error: login required`, '- [!] https://jobs.example.com/acme/9 | Acme | Backend Engineer', ''].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ url: 'https://private.example/job/1', company: '', role: '', done: false, needsJd: true, note: 'Error: login required', section: 'pending', line: 2 });
    expect(rows[1]).toMatchObject({ url: 'https://jobs.example.com/acme/9', company: 'Acme', role: 'Backend Engineer', done: false, needsJd: true, note: null });
    expect(parsePipeline('## Pending\n- [ ] https://jobs.example.com/a | A\n- [x] https://jobs.example.com/b | B\n').map((r) => r.needsJd)).toEqual([false, false]);
  });

  it('reads the error after the -- that localized pipeline modes write on a [!] row (modes/es/pipeline.md)', () => {
    const rows = parsePipeline('## Pending\n- [!] https://private.example/job -- Error: requiere inicio de sesión\n');
    expect(rows[0]).toMatchObject({ url: 'https://private.example/job', needsJd: true, note: 'Error: requiere inicio de sesión' });
  });

  it('keeps a bare pasted URL row and a URL row with only labeled segments, with company and role empty', () => {
    const rows = parsePipeline('## Pending\n\n- [ ] https://jobs.example.com/posting/123\n- [ ] https://jobs.example.com/posting/124 | posted: 2026-06-18 | note: from a friend\n- [ ] https://jobs.example.com/posting/125 | Acme\n- [ ] not a url\n');
    expect(rows.map((r) => r.url)).toEqual(['https://jobs.example.com/posting/123', 'https://jobs.example.com/posting/124', 'https://jobs.example.com/posting/125']);
    expect(rows[0]).toMatchObject({ company: '', role: '', location: null, postedAt: null, section: 'pending', done: false, seniority: null, line: 3 });
    expect(rows[1]).toMatchObject({ company: '', role: '', location: null, postedAt: '2026-06-18', note: 'from a friend' });
    expect(rows[2]).toMatchObject({ company: 'Acme', role: '' });
  });

  it('reads a word-colon cell in the company or role column as text, not as a label', () => {
    const [row] = parsePipeline('## Pending\n- [ ] https://a.example/1 | Remote: EMEA Inc | Engineer: Backend\n');
    expect(row).toMatchObject({ company: 'Remote: EMEA Inc', role: 'Engineer: Backend' });
  });

  it('reads company or title text that starts with a label word as text unless it is exactly the segment a writer emits', () => {
    const parse = (cells: string) => parsePipeline(`## Pending\n- [ ] https://a.example/1 | ${cells}\n`)[0]!;
    expect(parse('Rank: Senior Engineer | Acme')).toMatchObject({ company: 'Rank: Senior Engineer', role: 'Acme', rank: null });
    expect(parse('Acme | rank: 4 engineers wanted')).toMatchObject({ company: 'Acme', role: 'rank: 4 engineers wanted', rank: null });
    expect(parse('Posted: Daily Co | Backend Engineer')).toMatchObject({ company: 'Posted: Daily Co', role: 'Backend Engineer', postedAt: null });
    expect(parse('Acme | posted: soon')).toMatchObject({ company: 'Acme', role: 'posted: soon', postedAt: null });
    expect(parse('Trust: Banking Inc | Analyst')).toMatchObject({ company: 'Trust: Banking Inc', role: 'Analyst' });
    expect(parse('trust: high | Analyst')).toMatchObject({ company: 'trust: high', role: 'Analyst' });
    expect(parse('Note: Labs | Engineer')).toMatchObject({ company: 'Note: Labs', role: 'Engineer', note: null });
    // What scan.mjs and rank-pipeline.mjs write on a bare URL row stays metadata.
    expect(parse(`posted: 2026-06-18 | trust: 60 missing_apply_url,suspicious_domain | rank: 3.2/5 ${String.fromCharCode(0x2014)} solid match`)).toMatchObject({ company: '', role: '', postedAt: '2026-06-18', rank: 3.2, rankReason: 'solid match' });
    expect(parse('trust: 80 | note: curated shortlist')).toMatchObject({ company: '', role: '', note: 'curated shortlist' });
  });

  it('joins first-seen and source from scan history and distinguishes a missing file', () => {
    const p = readPipeline(root);
    expect(p.kind).toBe('ok');
    if (p.kind !== 'ok') return;
    expect(p.rows[0]).toMatchObject({ firstSeen: '2026-09-15', source: 'greenhouse' });
    expect(p.rows.find((r) => r.company === 'Globex Payments')).toMatchObject({ firstSeen: null, source: 'careers.example.com' });
    const empty = copyFixtureRoot();
    fs.rmSync(path.join(empty, 'data', 'pipeline.md'));
    expect(readPipeline(empty).kind).toBe('missing');
  });

  it('classifies rank cells, seniority and ATS sources', () => {
    expect(parseRankCell(`3.2/5 ${EM_DASH} reason here`)).toEqual({ rank: 3.2, reason: 'reason here' });
    expect(parseRankCell('4/5')).toEqual({ rank: 4, reason: null });
    expect(parseRankCell('pending')).toEqual({ rank: null, reason: 'pending' });
    expect(seniorityOf('Staff Software Engineer')).toBe('staff');
    expect(seniorityOf('Backend Engineer II')).toBe('mid');
    expect(seniorityOf('Engineer')).toBeNull();
    expect(sourceOf('https://boards.greenhouse.io/x/jobs/1', null)).toBe('greenhouse');
    expect(sourceOf('https://x.ashbyhq.com/y', 'ashby-full')).toBe('ashby');
    expect(sourceOf('nonsense', null)).toBe('other');
  });
});

describe('shortlist', () => {
  it('parses the date, ranked rows with links and the excluded bullets shortlist.mjs writes', () => {
    const s = readShortlist(root);
    expect(s.kind).toBe('ok');
    if (s.kind !== 'ok') return;
    expect(s.date).toBe('2026-10-03');
    expect(s.rows).toHaveLength(3);
    expect(s.rows[0]).toMatchObject({ rank: 1, score: 5.3, relevance: 4.8, sponsor: 'strong; resumed 2026-09-25', sponsorTier: 'strong', sponsorNote: 'resumed 2026-09-25', company: 'Globex Payments', role: 'Staff Software Engineer', url: 'https://careers.example.com/globex/777', posted: '2026-09-24' });
    expect(s.rows[2]).toMatchObject({ posted: null, sponsor: 'unknown' });
    expect(s.excluded).toEqual([
      { company: 'Initech Cloud', role: 'Backend Engineer II', url: 'https://jobs.example.com/initech/9', alert: 'paused', date: '2026-09-29', headline: 'Initech pauses visa sponsorship for new hires' },
    ]);
  });
  it('reads the "- none" line of an empty excluded section as no rows', () => {
    expect(parseShortlist('# Shortlist - 2026-10-03\n\n## Excluded by sponsorship alerts (0)\n\n- none\n').excluded).toEqual([]);
  });
  it('keeps a company whose name has a dash and a headline with a colon', () => {
    const md = '## Excluded by sponsorship alerts (1)\n\n- Hewlett - Packard - [SRE](https://x.example/1) - stopped (2026-09-01): Update: H-1B paused\n';
    expect(parseShortlist(md).excluded).toEqual([{ company: 'Hewlett - Packard', role: 'SRE', url: 'https://x.example/1', alert: 'stopped', date: '2026-09-01', headline: 'Update: H-1B paused' }]);
  });
  it('handles an empty document', () => {
    expect(parseShortlist('')).toEqual({ date: null, summary: null, rows: [], excluded: [] });
  });
});

describe('follow-ups file', () => {
  it('parses table rows and pin directives', () => {
    const text = fs.readFileSync(path.join(root, 'data', 'follow-ups.md'), 'utf8');
    const entries = parseFollowups(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ num: 1, appNum: 1, date: '2026-09-28', channel: 'Email' });
    const pins = parseNextOverrides(text);
    expect(pins.get(1)).toEqual({ appNum: 1, date: '2026-10-10', setOn: '2026-10-01' });
  });
});
