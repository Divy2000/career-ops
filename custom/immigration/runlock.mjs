#!/usr/bin/env node
// Single-run lock for run-daily.sh, so overlapping runs (launchd + manual)
// never share queue state. A lock whose owner pid is gone is reclaimed.
//
//   node custom/immigration/runlock.mjs acquire <lockdir> <pid>   exit 0 = acquired, 3 = held
//   node custom/immigration/runlock.mjs release <lockdir> <pid>

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { lockIsStale } from './lib.mjs';

const [cmd, dir, pidArg] = process.argv.slice(2);
const pid = Number(pidArg);
if (!['acquire', 'release'].includes(cmd) || !dir || !Number.isInteger(pid)) {
  process.stderr.write('usage: runlock.mjs acquire|release <lockdir> <pid>\n');
  process.exit(2);
}
const ownerFile = `${dir}/owner.json`;
const readOwner = () => { try { return JSON.parse(readFileSync(ownerFile, 'utf8')); } catch { return null; } };
const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

if (cmd === 'release') {
  if (readOwner()?.pid === pid) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    mkdirSync(dir);
    writeFileSync(ownerFile, JSON.stringify({ pid, started_at: new Date().toISOString() }) + '\n');
    process.exit(0);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const owner = readOwner();
    if (!lockIsStale(owner, isAlive)) {
      process.stderr.write(`run-daily already running (pid ${owner.pid}, since ${owner.started_at})\n`);
      process.exit(3);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
process.stderr.write('could not acquire run lock\n');
process.exit(3);
