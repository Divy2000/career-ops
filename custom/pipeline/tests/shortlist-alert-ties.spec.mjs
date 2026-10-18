import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';
import { localToday } from '../../../lib/local-today.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHORTLIST = path.join(REPO, 'custom', 'pipeline', 'shortlist.mjs');

// One ranked pipeline row for the company, a fresh 'strong' tier cache entry (no network lookup) and the given alert rows.
function alertWorld(company, alertRows) {
  const root = tempDir('shortlist-ties-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | ${company} | Backend Engineer | Remote | rank: 4.2/5 — fit\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const tier = { tier: 'strong', matched: 'X', checked: localToday() };
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ [company]: tier }));
  fs.writeFileSync(
    path.join(root, 'data', 'immigration', 'company-alerts.tsv'),
    `date\tcompany\tslug\tstatus\theadline\turl\n${alertRows.map(([date, slug, status]) => `${date}\t${company}\t${slug}\t${status}\t${company} ${status} sponsorship\thttps://news.example/${slug}`).join('\n')}\n`,
  );
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, md: fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8') };
}

test('a same-day resume written after a pause under another slug spelling keeps the company shortlisted (R23-scripts-a-L3-01)', () => {
  const r = alertWorld('AT&T', [['2026-10-11', 'at-t', 'paused'], ['2026-10-11', 'at-and-t', 'resumed']]);
  assert.match(r.stdout, /shortlist: 1 kept, 0 excluded/, r.md);
  assert.match(r.md, /strong; resumed 2026-10-11/);
});

test('a same-day stop written after a resume under another slug spelling excludes the company (R23-scripts-a-L3-01)', () => {
  const r = alertWorld('AT&T', [['2026-10-11', 'at-t', 'resumed'], ['2026-10-11', 'at-and-t', 'stopped']]);
  assert.match(r.stdout, /shortlist: 0 kept, 1 excluded/, r.md);
});

test('an older line under a later-written slug never beats a newer date (R23-scripts-a-L3-01)', () => {
  const r = alertWorld('AT&T', [['2026-10-11', 'at-t', 'resumed'], ['2026-10-01', 'at-and-t', 'paused']]);
  assert.match(r.stdout, /shortlist: 1 kept, 0 excluded/, r.md);
});
