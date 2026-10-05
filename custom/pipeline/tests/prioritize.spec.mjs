import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PRIORITIZE = path.join(REPO, 'custom', 'pipeline', 'prioritize.mjs');

test('prioritize puts the rows the scanner first saw on the local today first, also when the UTC date is already another day', () => {
  const { zone, localToday } = zoneOffUtcDay();
  const root = tempDir('prioritize-');
  fs.mkdirSync(path.join(root, 'data'));
  const backlog = '- [ ] https://jobs.example.com/backlog | Backlog Co | Data Analyst | Remote';
  const fresh = '- [ ] https://jobs.example.com/fresh | Fresh Co | Data Analyst | Remote';
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${backlog}\n${fresh}\n`);
  // scan.mjs stamps first-seen with the local date.
  fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://jobs.example.com/backlog\t2001-01-01\tx\tData Analyst\tBacklog Co\tadded\nhttps://jobs.example.com/fresh\t${localToday}\tx\tData Analyst\tFresh Co\tadded\n`);
  const r = spawnSync(process.execPath, [PRIORITIZE], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, TZ: zone, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`\\(1 first seen ${localToday}\\)`));
  const pending = fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- [ ] '));
  assert.deepEqual(pending, [fresh, backlog]);
});

test('prioritize runs on a root with no scan history yet (URLs added by hand), with no first-seen dates', () => {
  const root = tempDir('prioritize-');
  fs.mkdirSync(path.join(root, 'data'));
  const rows = ['- [ ] https://jobs.example.com/a | A Co | Data Analyst | Remote', '- [ ] https://jobs.example.com/b | B Co | Backend Engineer | Remote'];
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${rows.join('\n')}\n`);
  const r = spawnSync(process.execPath, [PRIORITIZE, '--today', '2026-10-05'], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /prioritized 2 pending rows \(0 first seen 2026-10-05\)/);
  const pending = fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- [ ] '));
  assert.deepEqual([...pending].sort(), [...rows].sort());
  assert.equal(fs.existsSync(path.join(root, 'data', 'scan-history.tsv')), false);
});

test('prioritize treats a root with no data/pipeline.md yet (a first scan that added nothing) as an empty pipeline', () => {
  const root = tempDir('prioritize-');
  fs.mkdirSync(path.join(root, 'data'));
  const r = spawnSync(process.execPath, [PRIORITIZE, '--today', '2026-10-05'], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /prioritized 0 pending rows/);
  assert.doesNotMatch(r.stdout, /backup/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'pipeline.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'pipeline.md.bak')), false);
});

test('a job the scanner skipped or cooled down first and added today counts as first seen today, not as backlog (SW-libs-02)', () => {
  const root = tempDir('prioritize-');
  fs.mkdirSync(path.join(root, 'data'));
  const backlog = '- [ ] https://jobs.example.com/backlog | Backlog Co | Data Analyst | Remote';
  const widened = '- [ ] https://jobs.example.com/widened | Widened Co | Data Analyst | Remote';
  const cooled = '- [ ] https://jobs.example.com/cooled | Cooled Co | Data Analyst | Remote';
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${backlog}\n${widened}\n${cooled}\n`);
  // scan.mjs writes a skipped_location or cooldown row that never pins the URL, then an added row once the job enters the pipeline.
  const history = [
    'url\tfirst_seen\tportal\ttitle\tcompany\tstatus',
    'https://jobs.example.com/backlog\t2026-09-01\tx\tData Analyst\tBacklog Co\tadded',
    'https://jobs.example.com/widened\t2026-09-01\tx\tData Analyst\tWidened Co\tskipped_location',
    'https://jobs.example.com/cooled\t2026-09-02\tx\tData Analyst\tCooled Co\tcooldown:cooled-co:2026-09-30',
    'https://jobs.example.com/widened\t2026-10-05\tx\tData Analyst\tWidened Co\tadded',
    'https://jobs.example.com/cooled\t2026-10-05\tx\tData Analyst\tCooled Co\tadded',
  ];
  fs.writeFileSync(path.join(root, 'data', 'scan-history.tsv'), `${history.join('\n')}\n`);
  const r = spawnSync(process.execPath, [PRIORITIZE, '--today', '2026-10-05'], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(2 first seen 2026-10-05\)/);
  const pending = fs.readFileSync(path.join(root, 'data', 'pipeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- [ ] '));
  assert.equal(pending.at(-1), backlog);
});
