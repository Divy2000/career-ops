import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PRIORITIZE = path.join(REPO, 'custom', 'pipeline', 'prioritize.mjs');

const dayIn = (timeZone, at) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

test('prioritize puts the rows the scanner first saw on the local today first, also when the UTC date is already another day', () => {
  // One of these zones is on another calendar day than UTC at any instant (UTC+14 from 10:00 UTC, UTC-11 before 11:00 UTC).
  const now = new Date();
  const utc = now.toISOString().slice(0, 10);
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => dayIn(z, now) !== utc);
  const localToday = dayIn(zone, now);
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
