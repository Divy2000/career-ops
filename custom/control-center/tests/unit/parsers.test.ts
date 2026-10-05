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
    expect(r.report.sections.map((s) => s.letter)).toEqual([null, 'A', 'B', 'C', 'D', 'G']);
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
    expect(skip.kind === 'ok' && skip.report.discardReasons).toEqual(['comp below floor', 'staffing agency']);
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
});

describe('pipeline', () => {
  it('parses checkbox rows with labels, sections and rank reasons containing the em dash', () => {
    const rows = parsePipeline(fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8'));
    expect(rows).toHaveLength(6);
    const acme = rows[0]!;
    expect(acme).toMatchObject({ company: 'Acme Robotics', location: 'Austin, TX', rank: 4.4, rankReason: 'strong backend match, sponsors visas', postedAt: '2026-09-15', done: false, section: 'pending', seniority: 'senior' });
    expect(rows.find((r) => r.company === 'Initech Cloud')).toMatchObject({ done: true, rank: null, section: 'pending' });
    expect(rows.find((r) => r.company === 'Old Corp')).toMatchObject({ section: 'done', done: true });
    expect(rows.some((r) => r.url === 'not a checkbox line')).toBe(false);
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
    expect(s.rows[0]).toMatchObject({ rank: 1, score: 5.3, relevance: 4.8, sponsor: 'strong', company: 'Globex Payments', role: 'Staff Software Engineer', url: 'https://careers.example.com/globex/777', posted: '2026-09-24' });
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
