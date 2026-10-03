#!/usr/bin/env node
// Single-run lock for run-daily.sh, so overlapping runs (launchd + manual)
// never share queue state. A lock whose owner pid is gone is reclaimed.
//
//   node custom/immigration/runlock.mjs acquire <lockdir> <pid>   exit 0 = acquired, 3 = held
//   node custom/immigration/runlock.mjs release <lockdir> <pid>

import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lockIsStale } from './lib.mjs';

const [cmd, dir, pidArg] = process.argv.slice(2);
const pid = Number(pidArg);
if (!['acquire', 'release'].includes(cmd) || !dir || !Number.isInteger(pid) || pid <= 1) {
  process.stderr.write('usage: runlock.mjs acquire|release <lockdir> <pid>\n');
  process.exit(2);
}
const ownerFile = `${dir}/owner.json`;
const readOwner = () => { try { return JSON.parse(readFileSync(ownerFile, 'utf8')); } catch { return null; } };
const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Process start time identifies the owner across pid reuse.
const startTimeOf = (p) => {
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(p)], { encoding: 'utf8' }).trim() || null; } catch { return null; }
};
const dirAgeMs = () => { try { return Date.now() - statSync(dir).mtimeMs; } catch { return 0; } };

if (cmd === 'release') {
  if (readOwner()?.pid === pid) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    mkdirSync(dir);
    const tmp = `${ownerFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, start: startTimeOf(pid), started_at: new Date().toISOString() }) + '\n');
    renameSync(tmp, ownerFile);
    process.exit(0);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const owner = readOwner();
    if (!lockIsStale(owner, { isAlive, startTimeOf, dirAgeMs: dirAgeMs() })) {
      process.stderr.write(owner
        ? `run-daily already running (pid ${owner.pid}, since ${owner.started_at})\n`
        : 'run-daily lock is being created by another process\n');
      process.exit(3);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
process.stderr.write('could not acquire run lock\n');
process.exit(3);
