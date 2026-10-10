// Contract tests: the app parses files other scripts write. Each test runs (or reads) the real writer, so a
// format change upstream fails here instead of silently emptying a page.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { applyInboxSkip } from '../../server/domains/inboxSkip.js';
import { parseShortlist, readShortlist } from '../../server/domains/shortlist.js';
import { parseReport } from '../../server/domains/reports.js';
import { parseContacts, readInterviews } from '../../server/domains/contacts.js';
import { USER_FILES } from '../../server/routes/files.js';
import { parsePipeline, readPipeline, readScanHistory } from '../../server/domains/pipeline.js';
import { activePin, parseFollowups, parseNextOverrides } from '../../server/domains/followups.js';
import { pathToFileURL } from 'node:url';
import { localDate } from '../../shared/local-date.js';
import { tempDir } from '../helpers/tmp.js';

// rank-pipeline.mjs annotates a row as `rank: 4.2/5 <em dash> reason`.
const rankCell = (score: string, reason: string) => `rank: ${score}/5 ${String.fromCharCode(0x2014)} ${reason}`;

describe('custom/pipeline/shortlist.mjs output', () => {
  it('lists a company with an excluding alert under Excluded, as the app reads it', () => {
    const root = tempDir('cc-shortlist-contract-');
    const today = localDate();
    fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'pipeline.md'),
      `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/initech/9 | Initech Cloud | Backend Engineer II | Remote | ${rankCell('4.2', 'strong fit')}\n- [ ] https://jobs.example.com/acme/1 | Acme Robotics | Platform Engineer | Remote | ${rankCell('4.0', 'good fit')}\n`,
    );
    fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
    // Fresh tier cache entries, so the run looks nothing up over the network.
    const tier = { tier: 'strong', matched: 'X', checked: today };
    fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Initech Cloud': tier, 'Acme Robotics': tier }));
    fs.writeFileSync(path.join(root, 'data', 'immigration', 'company-alerts.tsv'), `date\tcompany\tslug\tstatus\theadline\turl\n2026-09-29\tInitech Cloud\tinitech-cloud\tpaused\tInitech pauses visa sponsorship\thttps://news.example/1\n`);
    const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'custom', 'pipeline', 'shortlist.mjs')], {
      cwd: DEFAULT_CODE_ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const s = readShortlist(root);
    expect(s.kind).toBe('ok');
    if (s.kind !== 'ok') return;
    expect(s.rows.map((row) => row.company)).toEqual(['Acme Robotics']);
    expect(s.excluded).toEqual([
      { company: 'Initech Cloud', role: 'Backend Engineer II', url: 'https://jobs.example.com/initech/9', alert: 'paused', date: '2026-09-29', headline: 'Initech pauses visa sponsorship' },
    ]);
  });
});

describe('custom/pipeline/shortlist.mjs sponsor label (SW-libs-07)', () => {
  it('splits a shortlisted company\'s DOL tier from its non-blocking alert note, so the tier keeps its color', () => {
    const root = tempDir('cc-shortlist-contract-');
    const today = localDate();
    fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/acme/1 | Acme Robotics | Platform Engineer | Remote | ${rankCell('4.0', 'good fit')}\n- [ ] https://jobs.example.com/globex/2 | Globex Payments | Backend Engineer | Remote | ${rankCell('3.8', 'fit')}\n`);
    fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
    fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Acme Robotics': { tier: 'strong', matched: 'X', checked: today }, 'Globex Payments': { tier: 'moderate', matched: 'Y', checked: today } }));
    fs.writeFileSync(path.join(root, 'data', 'immigration', 'company-alerts.tsv'), `date\tcompany\tslug\tstatus\theadline\turl\n2026-10-01\tAcme Robotics\tacme-robotics\tresumed\tAcme resumes sponsorship\thttps://news.example/2\n`);
    const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'custom', 'pipeline', 'shortlist.mjs')], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const s = readShortlist(root);
    if (s.kind !== 'ok') throw new Error(s.kind);
    expect(s.rows.map((row) => [row.company, row.sponsor, row.sponsorTier, row.sponsorNote])).toEqual([
      ['Acme Robotics', 'strong; resumed 2026-10-01', 'strong', 'resumed 2026-10-01'],
      ['Globex Payments', 'moderate', 'moderate', null],
    ]);
  });
});

describe('oferta report format (modes/oferta.md, examples/sample-report.md)', () => {
  it('the template still asks for a Block A table', () => {
    const mode = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'modes', 'oferta.md'), 'utf8');
    expect(mode).toMatch(/## Block A[^\n]*Role Summary\n\nTable with:/);
  });

  it('the sample report yields its TL;DR and Remote rows', () => {
    const md = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'examples', 'sample-report.md'), 'utf8');
    const r = parseReport(md, '001-acme-ai.md', 1);
    expect(r.tldr).toBe('Senior AI eng to build and scale LLM infrastructure for enterprise customers');
    expect(r.remote).toBe('Full remote (US timezone overlap)');
  });

  it('comp is the Machine Summary advertised_comp the batch prompt defines', () => {
    const prompt = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'batch', 'batch-prompt.md'), 'utf8');
    expect(prompt).toMatch(/^advertised_comp: /m);
    const md = '# Evaluation: Acme - Eng\n\n**Score:** 4/5\n\n## Machine Summary\n```yaml\nadvertised_comp: "80-90k EUR"\n```\n\n## A) Role Summary\n\n| Field | Value |\n|---|---|\n| **Remote** | Hybrid |\n';
    expect(parseReport(md, '002-acme.md', 2).comp).toBe('80-90k EUR');
  });
});

/** Every report template a mode defines: an H1 with placeholders whose next line is a dated `**...:**` header field. */
function reportTemplates(): Array<{ file: string; header: string }> {
  const out: Array<{ file: string; header: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((line, i) => {
          const next = lines.slice(i + 1).find((l) => l.trim() !== '') ?? '';
          if (!/^# .*\{/.test(line) || !/^\*\*.*\{YYYY-MM-DD\}/.test(next)) return;
          const end = lines.findIndex((l, j) => j > i && (l.startsWith('---') || l.startsWith('## ')));
          out.push({ file: path.relative(DEFAULT_CODE_ROOT, p), header: lines.slice(i, end).join('\n') });
        });
      }
    }
  };
  walk(path.join(DEFAULT_CODE_ROOT, 'modes'));
  return out;
}

describe('localized report templates (modes/<lang>/)', () => {
  const templates = reportTemplates();
  it('finds the English and the localized templates', () => {
    expect(templates.map((t) => t.file)).toEqual(expect.arrayContaining(['modes/oferta.md', 'modes/de/angebot.md', 'modes/fr/offre.md', 'modes/it/annuncio.md', 'modes/zh/oferta.md']));
  });
  for (const t of templates) {
    it(`a report written from ${t.file} parses, score included`, () => {
      const filled = t.header
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{X(?:\.X)?\/5\}|\{X(?:\.X)?\}\/5/g, '4.2/5')
        .replace(/\{YYYY-MM-DD\}/g, '2026-10-01')
        .replace(/\{[^}]*\}/g, 'Acme');
      const r = parseReport(`${filled}\n\n---\n\n## A) Role Summary\n`, '010-acme.md', 10);
      expect(r.score).toBe(4.2);
      expect(r.company).toBe('Acme');
      expect(r.role).toBe('Acme');
      if (/^\*\*Date\s*:\*\*/m.test(t.header)) expect(r.date).toBe('2026-10-01');
    });

    it(`a header line ${t.file} leaves empty (URL for a pasted JD) stays empty instead of taking the next line (R8-07)`, () => {
      const filled = t.header
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{X(?:\.X)?\/5\}|\{X(?:\.X)?\}\/5/g, '4.2/5')
        .replace(/\{YYYY-MM-DD\}/g, '2026-10-01')
        .replace(/\{[^}]*\}/g, String.fromCharCode(0x2014))
        .replace(/^\*\*URL(\s*):\*\*.*$/m, '**URL$1:**');
      expect(filled, t.file).toMatch(/^\*\*URL\s*:\*\*$/m);
      const r = parseReport(`${filled}\n\n---\n\n## A) Role Summary\n`, '010-acme.md', 10);
      expect(r.url).toBeNull();
      expect(r.via).toBeNull();
    });

    it(`every header field a report from ${t.file} carries reaches the parsed report (date and archetype included)`, () => {
      // Each placeholder gets its own value, so a header line the parser drops cannot hide behind another's.
      let n = 0;
      const filled = t.header
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{X(?:\.X)?\/5\}|\{X(?:\.X)?\}\/5/g, '4.2/5')
        .replace(/\{YYYY-MM-DD\}/g, '2026-10-01')
        .replace(/\{[^}]*\}/g, () => `value-${++n}`)
        // The URL line holds a posting URL in a real report; the parser keeps only a real http(s) URL (SW2-server-06).
        .replace(/^(\*\*URL\s*:\*\*\s*)(value-\d+)/m, '$1https://jobs.example.com/$2');
      const r = parseReport(`${filled}\n\n---\n\n## A) Role Summary\n`, '010-acme.md', 10);
      const parsed = [r.date, r.url, r.via, r.archetype, r.legitimacy, r.workAuth, r.pdf];
      const lines = filled.split('\n').filter((l) => /^\*\*[^*]+\*\*/.test(l));
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) {
        const m = line.match(/^\*\*([^*]+?)\s*:\*\*\s*(.*)$/)!;
        const value = m[2]!.trim();
        if (value === '' || value.includes('4.2/5')) continue;
        expect(parsed, `${t.file}: **${m[1]}:** ${value}`).toContain(value);
      }
      expect(r.date).toBe('2026-10-01');
      expect(r.archetype).toMatch(/^value-\d+$/);
    });
  }
});

describe('active-interviews.md location (process-quality.mjs, rejection-latency.mjs, tracker-sync-check.mjs)', () => {
  // The table process-quality.mjs documents: | Company | Role | Round | Date/Time | Interviewer | Status | Notes |
  const TABLE = '# Active interviews\n\n| Company | Role | Round | Date/Time | Interviewer | Status | Notes |\n|---|---|---|---|---|---|---|\n| Globex | Platform Engineer | Onsite | 2026-10-08 | Panel | Scheduled | |\n';
  const scriptRows = (root: string): number => {
    const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'process-quality.mjs')], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout).metadata.totalRows;
  };

  for (const [layout, rel] of [
    ['data/ (the documented place)', 'data/active-interviews.md'],
    ['the root (the scripts\' fallback)', 'active-interviews.md'],
    ['interview-prep/ (no script reads it)', 'interview-prep/active-interviews.md'],
  ] as const) {
    it(`the Interviews page shows the file in ${layout} exactly when the scripts read it`, () => {
      const root = tempDir('cc-interviews-contract-');
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), TABLE);
      const scriptsRead = scriptRows(root) > 0;
      const active = readInterviews(root).active;
      expect(active.kind === 'ok').toBe(scriptsRead);
      if (active.kind === 'ok') expect(active.path).toBe(rel);
    });
  }

  it('the data/ copy wins over the root copy, as in the scripts', () => {
    const root = tempDir('cc-interviews-contract-');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'active-interviews.md'), TABLE);
    fs.writeFileSync(path.join(root, 'active-interviews.md'), '# old copy\n');
    expect(readInterviews(root).active).toMatchObject({ kind: 'ok', path: 'data/active-interviews.md', text: TABLE });
  });

  it('a missing file is reported at the documented path, and the editable file is that path', () => {
    expect(readInterviews(tempDir('cc-interviews-contract-')).active).toEqual({ kind: 'missing', path: 'data/active-interviews.md' });
    expect(USER_FILES.activeInterviews).toBe('data/active-interviews.md');
  });
});

describe('pipeline.md rows (scan.mjs formatPipelineOffer)', () => {
  // scan.mjs is a writer and never loads into the app, so its formatter runs in a child.
  function format(offers: unknown[]): string[] {
    const code = `const { formatPipelineOffer } = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan.mjs')).href)}); process.stdout.write(JSON.stringify(${JSON.stringify(offers)}.map(formatPipelineOffer)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: tempDir('cc-format-offer-'), NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as string[];
  }

  it('a URL the writer escapes ([, ] and |) reads back as the posting URL, joins its scan-history row, and Skip still finds its row (SW3-libs-04)', () => {
    const raw = 'https://jobs.example.com/apply?ids[]=7&team=a|b';
    const [line] = format([{ url: raw, company: 'Acme Robotics', title: 'Platform Engineer' }]);
    expect(line).toContain('ids\\[\\]=7&team=a%7Cb');
    const root = tempDir('cc-escaped-url-');
    fs.mkdirSync(path.join(root, 'data'));
    const pipeline = `# Pipeline\n\n## Pending\n\n${line}\n`;
    fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), pipeline);
    // scan-history.tsv keeps the raw URL (scan.mjs appendToScanHistory).
    fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n${raw}\t2026-10-01\tgreenhouse\tPlatform Engineer\tAcme Robotics\tadded\n`);
    const read = readPipeline(root);
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.rows.map((r) => [r.url, r.firstSeen, r.source])).toEqual([['https://jobs.example.com/apply?ids[]=7&team=a%7Cb', '2026-10-01', 'greenhouse']]);
    expect(applyInboxSkip(pipeline, read.rows[0]!.url, true)).toMatchObject({ ok: true, matched: 1, changed: 1 });
  });

  it('a shortlist link to an escaped URL reads back as the posting URL (SW3-libs-04)', () => {
    const md = '# Shortlist - 2026-10-05\n\n| # | Score | Rank | Sponsor | Company | Role | Location | Posted | Why |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 4.5 | 4.0 | strong | Acme Robotics | [Platform Engineer](https://jobs.example.com/apply?ids\\[\\]=7&team=a%7Cb) | Remote | - | fit |\n';
    expect(parseShortlist(md).rows[0]!.url).toBe('https://jobs.example.com/apply?ids[]=7&team=a%7Cb');
  });

  it('company, role, location and rank reason that the writers escaped read back as written: brackets and backslashes, no escapes (SW5-libs-01)', () => {
    const [line] = format([{ url: 'https://x.example/9', company: 'Acme [EU]', title: 'Senior Engineer [Platform]', location: 'Berlin \\ Remote' }]);
    expect(line).toContain('Acme \\[EU\\]');
    // rank-pipeline.mjs appends the rank segment with the reason escaped the same way.
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'rank-pipeline.mjs')).href)}); process.stdout.write(m.appendRankAnnotation(${JSON.stringify(line)}, 4.2, 'strong [backend] fit'));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: tempDir('cc-rank-format-'), NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const [row] = parsePipeline(`## Pending\n\n${r.stdout}\n`);
    expect(row).toMatchObject({ company: 'Acme [EU]', role: 'Senior Engineer [Platform]', location: 'Berlin \\ Remote', rank: 4.2, rankReason: 'strong [backend] fit' });
  });

  it('a shortlist row and an excluded bullet copied from escaped pipeline cells read back unescaped (SW5-libs-01)', () => {
    const md = '# Shortlist - 2026-10-05\n\n| # | Score | Rank | Sponsor | Company | Role | Location | Posted | Why |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 4.5 | 4.0 | strong | Acme \\[EU\\] | [Senior Engineer \\[Platform\\]](https://x.example/9) | Berlin \\\\ Remote | - | strong \\[backend\\] fit |\n\n## Excluded\n\n- Globex \\[US\\] - [Staff \\[Infra\\]](https://x.example/10) - paused (2026-10-01): pauses \\[all\\] sponsorship\n';
    const read = parseShortlist(md);
    expect(read.rows[0]).toMatchObject({ company: 'Acme [EU]', role: 'Senior Engineer [Platform]', location: 'Berlin \\ Remote', why: 'strong [backend] fit' });
    expect(read.excluded[0]).toMatchObject({ company: 'Globex [US]', role: 'Staff [Infra]', headline: 'pauses [all] sponsorship' });
  });

  it('a location with a colon stays the location, and the compensation after it stays the compensation (R8-16)', () => {
    const lines = format([
      { url: 'https://x.example/1', company: 'Acme', title: 'SWE', location: 'Remote: US', salary: { min: 120000, max: 160000, currency: 'USD' } },
      { url: 'https://x.example/2', company: 'Acme', title: 'SWE', location: 'Hybrid: Berlin', postedAt: Date.parse('2026-09-30T00:00:00Z') },
    ]);
    const rows = parsePipeline(`## Pending\n\n${lines.join('\n')}\n`);
    expect(rows[0]).toMatchObject({ location: 'Remote: US', compensation: '120000-160000 USD' });
    expect(rows[1]).toMatchObject({ location: 'Hybrid: Berlin', compensation: null, postedAt: '2026-09-30' });
  });
});

describe('scan-history.tsv (scan.mjs appendToScanHistory)', () => {
  /** The file scan.mjs writes on a fresh root, through its own writer in a child (scan.mjs never loads into the app). */
  function writtenByScan(): { root: string; text: string } {
    const root = tempDir('cc-scan-history-contract-');
    fs.mkdirSync(path.join(root, 'data'));
    const offer = { url: 'https://jobs.example.com/acme/1', source: 'greenhouse-api', title: 'Backend Engineer', company: 'Acme', location: 'Remote', postedAt: Date.parse('2026-09-30T12:00:00Z') };
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan.mjs')).href)}); await m.appendToScanHistory([${JSON.stringify(offer)}], '2026-10-01');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    return { root, text: fs.readFileSync(path.join(root, 'data', 'scan-history.tsv'), 'utf8') };
  }
  const expected = { url: 'https://jobs.example.com/acme/1', firstSeen: '2026-10-01', portal: 'greenhouse-api', title: 'Backend Engineer', company: 'Acme', status: 'added', location: 'Remote', postedAt: '2026-09-30' };

  it('reads the file a scan writes', () => {
    const { root } = writtenByScan();
    expect(readScanHistory(root)).toEqual([expected]);
  });

  it('reads a legacy file with no header row by column position (scan.mjs never rewrites it)', () => {
    const { root, text } = writtenByScan();
    fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), text.split('\n').slice(1).join('\n'));
    expect(readScanHistory(root)).toEqual([expected]);
  });

  it('reads columns by position under an older 7-column header, so posted_at from later appended rows is kept (R12-srv-dom-b-L2-01)', () => {
    const root = tempDir('cc-scan-history-contract-');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(
      path.join(root, 'data', 'scan-history.tsv'),
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\nhttps://jobs.example.com/new\t2026-10-01\tgreenhouse-api\tEngineer\tNewCo\tadded\tRemote\tfp1\t2026-09-30\t0.9\t\tnewco\n',
    );
    expect(readScanHistory(root)).toEqual([{ url: 'https://jobs.example.com/new', firstSeen: '2026-10-01', portal: 'greenhouse-api', title: 'Engineer', company: 'NewCo', status: 'added', location: 'Remote', postedAt: '2026-09-30' }]);
  });

  it('reads a legacy 7-column file with no header', () => {
    const root = tempDir('cc-scan-history-contract-');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), 'https://jobs.example.com/old\t2026-09-01\tlever\tEngineer\tOldCo\tadded\tBerlin\n');
    expect(readScanHistory(root)).toEqual([{ url: 'https://jobs.example.com/old', firstSeen: '2026-09-01', portal: 'lever', title: 'Engineer', company: 'OldCo', status: 'added', location: 'Berlin', postedAt: '' }]);
  });
});

describe('localized pipeline.md headings (every modes/*/pipeline.md, R13-feat-b-L3-01)', () => {
  const modeFiles = [path.join(DEFAULT_CODE_ROOT, 'modes', 'pipeline.md'), ...fs.readdirSync(path.join(DEFAULT_CODE_ROOT, 'modes'), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(DEFAULT_CODE_ROOT, 'modes', d.name, 'pipeline.md'))).map((d) => path.join(DEFAULT_CODE_ROOT, 'modes', d.name, 'pipeline.md'))];
  /** The two section headings a mode's format block writes, in order: Pending first, Processed second. */
  const headingsOf = (file: string): string[] => {
    let fenced = false;
    const out: string[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith('```')) fenced = !fenced;
      else if (fenced && line.startsWith('## ')) out.push(line.slice(3).trim());
    }
    return out;
  };

  it('finds the format headings of every shipped mode', () => {
    expect(modeFiles.length).toBeGreaterThan(10);
    for (const f of modeFiles) expect(headingsOf(f), f).toHaveLength(2);
  });

  for (const file of modeFiles) {
    it(`reads the Pending and Processed sections ${path.relative(DEFAULT_CODE_ROOT, file)} writes, and Skip finds its pending rows`, () => {
      const [pending, processed] = headingsOf(file);
      const md = `# Pipeline\n\n## ${pending}\n\n- [ ] https://jobs.example.com/1 | Acme | Eng\n\n## ${processed}\n\n- [x] #143 | https://jobs.example.com/2 | Acme | AI PM | 4.2/5 | PDF ✅\n`;
      expect(parsePipeline(md).map((r) => r.section)).toEqual(['pending', 'done']);
      expect(applyInboxSkip(md, 'https://jobs.example.com/1', true)).toMatchObject({ ok: true, matched: 1, changed: 1 });
      expect(applyInboxSkip(md, 'https://jobs.example.com/2', false)).toEqual({ ok: false, error: 'unmatched' });
    });
  }
});

describe('follow-up pins (followup-cadence.mjs resolveNextOverride)', () => {
  it('the Timeline keeps or drops a pin exactly as the cadence does', () => {
    const pin = { appNum: 1, date: '2026-10-10', setOn: '2026-10-01' };
    const cases: Array<string | null> = [null, '2026-09-28', '2026-10-01', '2026-10-02'];
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'followup-cadence.mjs')).href)});
const pin = { appNum: 1, date: '2026-10-10', setDate: '2026-10-01' };
process.stdout.write(JSON.stringify(${JSON.stringify(cases)}.map((last) => m.resolveNextOverride(pin, last))));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const cadence = JSON.parse(r.stdout) as Array<string | null>;
    const ours = cases.map((last) => activePin(pin, last === null ? [] : [{ date: last }, { date: '2026-09-01' }])?.date ?? null);
    expect(ours).toEqual(cadence);
    expect(cadence).toEqual(['2026-10-10', '2026-10-10', '2026-10-10', null]);
  });
});

describe('follow-up pins under a retirement (followup-cadence.mjs isRetired, R12-srv-dom-a-L2-03, R12-srv-dom-a-L3-02)', () => {
  it('the Timeline drops a pin the cadence ignores because a cleared #N retirement outranks it, and keeps it once a later follow-up revives the application', () => {
    const D = String.fromCharCode(0x2014);
    const base = ['# Follow-ups', '', '- next #42 2026-10-15 (set 2026-10-01)', `- cleared #42 2026-10-05 ${D} no contact on file`, '- next #7 2026-10-20 (set 2026-10-05)', '- cleared #7 2026-02-31'];
    const cases: Array<string | null> = [null, '2026-10-03', '2026-10-05', '2026-10-06'];
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'followup-cadence.mjs')).href)});
const text = ${JSON.stringify(base.join('\n'))};
const pins = m.parseNextOverrides(text), cleared = m.parseClearedDirectives(text);
process.stdout.write(JSON.stringify([42, 7].map((n) => ${JSON.stringify(cases)}.map((last) => (m.isRetired(cleared.get(n), last) ? null : m.resolveNextOverride(pins.get(n), last))))));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const cadence = JSON.parse(r.stdout) as Array<Array<string | null>>;
    const pins = parseNextOverrides(base.join('\n'));
    const ours = [42, 7].map((n) => cases.map((last) => activePin(pins.get(n) ?? null, last === null ? [] : [{ date: last }])?.date ?? null));
    expect(ours).toEqual(cadence);
    expect(cadence[0]).toEqual([null, null, null, null]);
    expect(cadence[1]).toEqual(['2026-10-20', '2026-10-20', '2026-10-20', null]);
  });
});

describe('follow-ups.md log lines (followup-cadence.mjs parseFollowups)', () => {
  it('the app reads the same follow-ups as the cadence, table rows and legacy bullets alike', () => {
    const D = String.fromCharCode(0x2014);
    const text = [
      '# Follow-ups',
      '',
      '| num | appNum | date | company | role | channel | contact | notes |',
      '|---|---|---|---|---|---|---|---|',
      '| 1 | 1 | 2026-09-28 | Acme Robotics | Senior Backend Engineer | Email | Pat Example | asked about timeline |',
      '| 2 | 3 | 2026-09-30 | Globex | Staff Engineer | LinkedIn | Sam | |',
      '| x | 3 | 2026-09-30 | Globex | Staff Engineer | LinkedIn | Sam | not a row |',
      `- 2026-10-02 \u00b7 #1 Acme Robotics ${D} nudged again`,
      '- 2026-10-03 \u00b7 #6 Vandelay Systems',
      `- 2026-10-04 \u00b7 Unattributed Co ${D} no app number`,
      `- next #1 2026-10-10 (set 2026-10-01) ${D} recruiter asked`,
      '',
    ].join('\n');
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'followup-cadence.mjs')).href)});
process.stdout.write(JSON.stringify(m.parseFollowups(${JSON.stringify(text)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const cadence = JSON.parse(r.stdout) as unknown[];
    expect(cadence).toHaveLength(4);
    expect(parseFollowups(text)).toEqual(cadence);
  });
});

describe('follow-up pin lines (followup-cadence.mjs parseNextOverrides)', () => {
  it('the app reads the same pins as the cadence: trailing reasons kept, junk suffixes and impossible dates refused', () => {
    const D = String.fromCharCode(0x2014);
    const lines = [
      `- next #1 2026-10-10 (set 2026-10-01) ${D} recruiter requested delay`,
      '- next #2 2026-10-11 (set 2026-10-02) \u2013 en dash reason',
      '- next #3 2026-10-12 - hyphen reason',
      '- next #4 2026-10-13',
      '- next #5 2026-10-14 (set 2026-10-03) and then some',
      '- next #6 2026-02-31 (set 2026-10-03)',
      '- NEXT #7 2026-10-15 (set 2026-10-04)',
      '- next #1 2026-10-20 (set 2026-10-05)',
    ];
    const text = `# Follow-ups\n\n${lines.join('\n')}\n`;
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'followup-cadence.mjs')).href)});
process.stdout.write(JSON.stringify([...m.parseNextOverrides(${JSON.stringify(text)}).values()].map((o) => ({ appNum: o.appNum, date: o.date, setOn: o.setDate }))));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const cadence = JSON.parse(r.stdout) as unknown[];
    expect(cadence).toContainEqual({ appNum: 1, date: '2026-10-20', setOn: '2026-10-05' });
    expect([...parseNextOverrides(text).values()]).toEqual(cadence);
  });
});

describe('data/contacts.tsv (contact-extract.mjs appendContact, read back like contacts.mjs parseContacts)', () => {
  it('shows a cell the writer formula-escaped as it was typed, folds a stray tab back into the notes and skips a short row (SW-server-04)', async () => {
    const file = path.join(tempDir('cc-contacts-contract-'), 'contacts.tsv');
    const { appendContact } = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'contact-extract.mjs')).href)) as { appendContact: (c: Record<string, string>, p: string) => Promise<number> };
    await appendContact({ name: 'Pat Example', company: 'Acme Robotics', type: 'recruiter', title: '-Lead recruiter', phone: '+49 123', email: 'pat@acme.example', linkedin: '', tracker: '1', notes: '=friendly' }, file);
    const written = fs.readFileSync(file, 'utf8');
    expect(written).toContain("\t'+49 123\t");
    fs.appendFileSync(file, 'Sam Other\tGlobex Payments\tpeer\tEngineer\t-\t-\t-\t-\tmet at meetup\tasked about visas\nShort\tRow\n');
    const { rows, skipped } = parseContacts(fs.readFileSync(file, 'utf8'));
    expect(rows.map((r) => [r.name, r.title, r.phone, r.notes])).toEqual([
      ['Pat Example', '-Lead recruiter', '+49 123', '=friendly'],
      ['Sam Other', 'Engineer', '', 'met at meetup asked about visas'],
    ]);
    expect(skipped).toBe(1);
  });
});
