// Contract tests: the app parses files other scripts write. Each test runs (or reads) the real writer, so a
// format change upstream fails here instead of silently emptying a page.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { readShortlist } from '../../server/domains/shortlist.js';
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
