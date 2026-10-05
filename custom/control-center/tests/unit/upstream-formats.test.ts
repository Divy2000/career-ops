// Contract tests: the app parses files other scripts write. Each test runs (or reads) the real writer, so a
// format change upstream fails here instead of silently emptying a page.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { readShortlist } from '../../server/domains/shortlist.js';
import { parseReport } from '../../server/domains/reports.js';
import { readInterviews } from '../../server/domains/contacts.js';
import { USER_FILES } from '../../server/routes/files.js';
import { readScanHistory } from '../../server/domains/pipeline.js';
import { activePin } from '../../server/domains/followups.js';
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

  it('reads a legacy 7-column file with no header', () => {
    const root = tempDir('cc-scan-history-contract-');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), 'https://jobs.example.com/old\t2026-09-01\tlever\tEngineer\tOldCo\tadded\tBerlin\n');
    expect(readScanHistory(root)).toEqual([{ url: 'https://jobs.example.com/old', firstSeen: '2026-09-01', portal: 'lever', title: 'Engineer', company: 'OldCo', status: 'added', location: 'Berlin', postedAt: '' }]);
  });
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
