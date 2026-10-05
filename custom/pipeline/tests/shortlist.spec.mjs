import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHORTLIST = path.join(REPO, 'custom', 'pipeline', 'shortlist.mjs');

test('the shortlist is dated by the local day, also when the UTC date is already another day', () => {
  const { zone, localToday } = zoneOffUtcDay();
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  // Ranked below the cut, so no sponsorship lookup runs.
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | rank: 1.0/5 - weak fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, TZ: zone, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8').split('\n')[0], `# Shortlist - ${localToday}`);
});

test('the shortlist is written on a root with no data/immigration folder (the daily job never ran)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | rank: 1.0/5 - weak fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
});
