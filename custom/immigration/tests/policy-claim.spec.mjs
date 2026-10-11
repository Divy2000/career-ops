// One AI policy pass at a time across the Control Center and the scheduled daily job: a pass takes the queued items by
// creating data/immigration/.policy-pass.claim, and both sides honour it (SW8-server-01 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimFile, readClaim, releaseClaim, retagClaim, tryClaim } from '../policy-claim.mjs';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, '..', 'policy-claim.mjs')).href;

function root() {
  const dir = tempDir('policy-claim-');
  fs.mkdirSync(path.join(dir, 'data', 'immigration'), { recursive: true });
  return dir;
}
function session(dataRoot, id, status) {
  const dir = path.join(dataRoot, 'data', 'control-center', 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, mode: 'immigration-policy', status }));
}
function daily(dataRoot, pid) {
  fs.writeFileSync(path.join(dataRoot, 'data', 'immigration', '.run-daily.pid'), `${pid}\n`);
}
const plant = (dataRoot, claim) => fs.writeFileSync(claimFile(dataRoot), JSON.stringify(claim));

test('a free claim is taken, recorded with its owner, batch and time, and released only by its owner', () => {
  const r = root();
  assert.deepEqual(tryClaim(r, { owner: 'session:s-1', batch: 'data/immigration/batches/b1.json' }), { ok: true });
  const c = readClaim(r);
  assert.equal(c.owner, 'session:s-1');
  assert.equal(c.batch, 'data/immigration/batches/b1.json');
  assert.match(c.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(releaseClaim(r, 'session:s-2'), false);
  assert.ok(fs.existsSync(claimFile(r)));
  assert.equal(releaseClaim(r, 'session:s-1'), true);
  assert.equal(fs.existsSync(claimFile(r)), false);
});

test('a live owner keeps the claim: a running, queued or paused session, or the running daily job', () => {
  const r = root();
  for (const status of ['running', 'queued', 'awaiting_user']) {
    session(r, `s-${status}`, status);
    plant(r, { owner: `session:s-${status}`, batch: null, at: new Date().toISOString() });
    const refused = tryClaim(r, { owner: 'daily:1', batch: null });
    assert.equal(refused.ok, false, status);
    assert.equal(refused.holder.owner, `session:s-${status}`);
  }
  // The owner itself may claim again (a reply to a paused pass).
  assert.deepEqual(tryClaim(r, { owner: 'session:s-awaiting_user', batch: null }), { ok: true });
});

/**
 * A bash running a script named run-daily.sh, as launchd starts the job; stopped by the returned function. The job runs
 * in its own process group so stopping it also kills the sleep bash forks, not bash alone.
 */
function fakeDailyJob() {
  const dir = tempDir('policy-claim-job-');
  const script = path.join(dir, 'run-daily.sh');
  fs.writeFileSync(script, 'sleep 30\n');
  const job = spawn('/bin/bash', [script], { stdio: 'ignore', detached: true });
  return { pid: job.pid, stop: () => { try { process.kill(-job.pid, 'SIGKILL'); } catch { /* already gone */ } } };
}

test('the fake daily job leaves no process running once stopped', async () => {
  const job = fakeDailyJob();
  const childrenOf = (pid) => spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  let children = [];
  try {
    for (let i = 0; i < 100 && children.length === 0; i++) {
      spawnSync('sleep', ['0.02']);
      children = childrenOf(job.pid);
    }
    assert.notDeepEqual(children, [], 'the job never started its sleep');
  } finally {
    job.stop();
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const tree = [job.pid, ...children];
  // Awaited, so node reaps the stopped bash rather than leaving a zombie that still answers kill(pid, 0).
  for (let i = 0; i < 100 && tree.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(tree.filter(alive), [], 'the job left a process running');
});

test('the running daily job keeps the claim; its pid reused by another process does not (SW8-server-01 review)', () => {
  const r = root();
  const job = fakeDailyJob();
  try {
    for (let i = 0; i < 100 && !/run-daily\.sh/.test(spawnSync('ps', ['-o', 'command=', '-p', String(job.pid)], { encoding: 'utf8' }).stdout); i++) spawnSync('sleep', ['0.02']);
    daily(r, job.pid);
    plant(r, { owner: `daily:${job.pid}`, batch: null, at: new Date().toISOString() });
    assert.equal(tryClaim(r, { owner: 'session:s-new', batch: null }).ok, false);
    // ps that cannot run proves nothing about the job: it keeps the claim.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.equal(tryClaim(r, { owner: 'session:s-new', batch: null }).ok, false);
    } finally {
      process.env.PATH = savedPath;
    }
  } finally {
    job.stop();
  }
  // A live pid that .run-daily.pid names but that is not the job (the pid was reused): stale.
  daily(r, process.pid);
  plant(r, { owner: `daily:${process.pid}`, batch: null, at: new Date().toISOString() });
  assert.deepEqual(tryClaim(r, { owner: 'session:s-new', batch: null }), { ok: true });
});

test('a stale claim is taken over: its session is gone or final, its daily job pid is dead or not the job, or a start never finished', () => {
  const r = root();
  const stale = [
    { owner: 'session:s-gone' },
    ...['done', 'error', 'cancelled'].map((status) => (session(r, `s-${status}`, status), { owner: `session:s-${status}` })),
    { owner: 'daily:999999' },
    (daily(r, 1), { owner: `daily:${process.pid}` }),
    { owner: 'starting:abc', at: new Date(Date.now() - 10 * 60_000).toISOString() },
  ];
  for (const s of stale) {
    plant(r, { batch: null, at: new Date().toISOString(), ...s });
    assert.deepEqual(tryClaim(r, { owner: 'session:s-taker', batch: null }), { ok: true }, s.owner);
    assert.equal(readClaim(r).owner, 'session:s-taker');
    releaseClaim(r, 'session:s-taker');
  }
  // A claim that cannot be read is no claim anyone holds.
  fs.writeFileSync(claimFile(r), '{ not json');
  assert.deepEqual(tryClaim(r, { owner: 'session:s-taker', batch: null }), { ok: true });
});

test('a SIGKILLed daily job, whose dead pid .run-daily.pid still names, loses its claim even when ps cannot run (R21-tests-custom-L2-01)', () => {
  const r = root();
  // A pid that ran and has ended: the job killed before its EXIT trap removed .run-daily.pid.
  const dead = spawnSync('/usr/bin/true').pid;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  daily(r, dead);
  plant(r, { owner: `daily:${dead}`, batch: null, at: new Date().toISOString() });
  // Without ps, only the liveness check can tell the job is gone.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.deepEqual(tryClaim(r, { owner: 'session:s-taker', batch: null }), { ok: true });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(readClaim(r).owner, 'session:s-taker');
});

test('a cancelled session keeps the claim until its Claude run has ended (SW8-server-01 review)', () => {
  const r = root();
  const runDir = path.join(r, 'data', 'control-center', 'runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  const sessionDir = path.join(r, 'data', 'control-center', 'sessions', 's-cancelled');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({ id: 's-cancelled', status: 'cancelled', turns: [{ n: 1, runId: 'run-1' }] }));
  const held = () => {
    plant(r, { owner: 'session:s-cancelled', batch: null, at: new Date().toISOString() });
    return !tryClaim(r, { owner: 'daily:1', batch: null }).ok;
  };
  // Cancel asked, the process still running (SIGTERM ignored until the runner's SIGKILL).
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ id: 'run-1', status: 'running', endedAt: null }));
  assert.equal(held(), true, 'running');
  // The wrapper recorded the exit, before the runner finalized the record.
  fs.writeFileSync(path.join(runDir, 'exit.json'), JSON.stringify({ code: null, signal: 'SIGKILL', endedAt: new Date().toISOString() }));
  assert.equal(held(), false, 'exit recorded');
  fs.rmSync(path.join(runDir, 'exit.json'));
  // Finalized by the runner.
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ id: 'run-1', status: 'cancelled', endedAt: new Date().toISOString() }));
  assert.equal(held(), false, 'finalized');
  // No run record at all: nothing runs.
  fs.rmSync(runDir, { recursive: true });
  assert.equal(held(), false, 'no record');
});

test('a recent start keeps the claim until it is retagged with its session', () => {
  const r = root();
  assert.equal(tryClaim(r, { owner: 'starting:n1', batch: null }).ok, true);
  assert.equal(tryClaim(r, { owner: 'daily:1', batch: null }).ok, false);
  assert.equal(retagClaim(r, 'starting:other', 'session:s-x'), false);
  assert.equal(retagClaim(r, 'starting:n1', 'session:s-7'), true);
  assert.equal(readClaim(r).owner, 'session:s-7');
});

test('a start keeps the claim however long it waits (a Keychain prompt), while the process that took it runs (SW8 review 2)', () => {
  const r = root();
  assert.equal(tryClaim(r, { owner: 'starting:slow', batch: null }).ok, true);
  // Long past any fixed time limit: the start is still waiting on the token in this live process.
  plant(r, { ...readClaim(r), at: new Date(Date.now() - 60 * 60_000).toISOString() });
  const refused = tryClaim(r, { owner: 'starting:second', batch: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.holder.owner, 'starting:slow');
  assert.equal(tryClaim(r, { owner: 'daily:1', batch: null }).ok, false);
});

test('a start whose process has exited, or whose pid now names another process, is stale at once (SW8 review 2)', () => {
  const r = root();
  const code = `const { tryClaim } = await import(${JSON.stringify(MODULE)}); tryClaim(${JSON.stringify(r)}, { owner: 'starting:crashed', batch: null });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(child.status, 0, String(child.stderr));
  assert.equal(readClaim(r).owner, 'starting:crashed');
  assert.equal(readClaim(r).pid, child.pid);
  assert.deepEqual(tryClaim(r, { owner: 'starting:next', batch: null }), { ok: true });
  // This process's pid, but a process that started at another time: the pid was reused.
  plant(r, { owner: 'starting:reused', batch: null, at: new Date().toISOString(), pid: process.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
  assert.deepEqual(tryClaim(r, { owner: 'starting:next', batch: null }), { ok: true });
});

test('many processes claiming at once: exactly one gets it', async () => {
  const r = root();
  // Each claimant stays alive until all have answered: a start's claim holds only while its process runs.
  const code = `const { tryClaim } = await import(${JSON.stringify(MODULE)}); process.stdout.write(String(tryClaim(${JSON.stringify(r)}, { owner: 'starting:' + process.pid, batch: null }).ok)); process.stdin.resume();`;
  const children = [];
  try {
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
      children.push(child);
      child.stdout.once('data', (d) => resolve(String(d)));
      child.on('error', reject);
      child.on('close', () => resolve(''));
    })));
    assert.equal(outs.filter((o) => o === 'true').length, 1, outs.join(','));
  } finally {
    for (const child of children) child.stdin.end();
  }
});

test('many processes finding a crashed claimant\'s stale lock at once: exactly one breaks it and gets the claim (R19-scripts-a-L1-02)', async () => {
  for (let round = 0; round < 5; round++) {
    const r = root();
    // A claimant killed inside the lock left it behind, long enough ago to be broken.
    const lock = `${claimFile(r)}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const go = path.join(r, 'go');
    // Every claimant waits for the same instant, so they all judge the old lock stale in the same poll, and each is
    // descheduled for a moment between that verdict and its removal of the lock, the window in which another claimant
    // can break the same lock and take a new one.
    const code = `const fs = (await import('node:fs')).default; const rm = fs.rmSync; fs.rmSync = (p, o) => { if (String(p).endsWith('.lock')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); return rm(p, o); }; const { tryClaim } = await import(${JSON.stringify(MODULE)}); while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((res) => setTimeout(res, 1)); process.stdout.write(String(tryClaim(${JSON.stringify(r)}, { owner: 'starting:' + process.pid, batch: null }).ok)); process.stdin.resume();`;
    const children = [];
    try {
      const ready = [];
      const outs = Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
        children.push(child);
        ready.push(new Promise((res) => child.on('spawn', res)));
        child.stdout.once('data', (d) => resolve(String(d)));
        child.on('error', reject);
        child.on('close', () => resolve(''));
      })));
      await Promise.all(ready);
      await new Promise((res) => setTimeout(res, 300));
      fs.writeFileSync(go, '');
      const answers = await outs;
      assert.equal(answers.filter((o) => o === 'true').length, 1, `round ${round}: ${answers.join(',')}`);
    } finally {
      for (const child of children) child.stdin.end();
    }
  }
});

test('a recover guard left by a claimant killed while breaking a stale lock does not block claims for long (R19-scripts-a-L1-02 review)', () => {
  const r = root();
  const lock = `${claimFile(r)}.lock`;
  fs.mkdirSync(lock);
  fs.mkdirSync(`${lock}.recover`);
  const lockAge = new Date(Date.now() - 60_000);
  const guardAge = new Date(Date.now() - 8_000);
  fs.utimesSync(lock, lockAge, lockAge);
  fs.utimesSync(`${lock}.recover`, guardAge, guardAge);
  assert.deepEqual(tryClaim(r, { owner: 'session:s-1', batch: null }), { ok: true });
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(`${lock}.recover`), false);
});

test('a claimant whose lock was broken and taken by another while it held it leaves the other\'s lock in place (R19-scripts-a-L1-02 review)', () => {
  const r = root();
  const lock = `${claimFile(r)}.lock`;
  const read = fs.readFileSync;
  // While this claimant decides, another breaks its lock as stale and takes a new one at the same path.
  fs.readFileSync = (file, ...rest) => {
    if (file === claimFile(r)) {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    }
    return read(file, ...rest);
  };
  try {
    tryClaim(r, { owner: 'session:s-1', batch: null });
  } finally {
    fs.readFileSync = read;
  }
  assert.equal(fs.existsSync(lock), true, 'the other claimant\'s lock was removed');
});

test('a claimant that cannot mark the lock it took removes it, so the next claim is not blocked (R19-scripts-a-L1-02 review 2)', () => {
  const r = root();
  const lock = `${claimFile(r)}.lock`;
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...rest) => {
    if (file === path.join(lock, 'owner')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return write(file, ...rest);
  };
  try {
    assert.throws(() => tryClaim(r, { owner: 'session:s-1', batch: null }), /ENOSPC/);
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(fs.existsSync(lock), false, 'the lock was left behind');
  assert.deepEqual(tryClaim(r, { owner: 'session:s-1', batch: null }), { ok: true });
});

test('a fork takes the claim from the paused session it forks, never from another live owner', () => {
  const r = root();
  session(r, 's-src', 'awaiting_user');
  session(r, 's-other', 'running');
  plant(r, { owner: 'session:s-src', batch: 'b.json', at: new Date().toISOString() });
  assert.deepEqual(tryClaim(r, { owner: 'starting:fork', batch: 'b.json', takeFrom: 'session:s-src' }), { ok: true });
  assert.equal(readClaim(r).owner, 'starting:fork');
  plant(r, { owner: 'session:s-other', batch: null, at: new Date().toISOString() });
  assert.equal(tryClaim(r, { owner: 'starting:fork2', batch: null, takeFrom: 'session:s-src' }).ok, false);
});

test('given the claim cannot be renamed into place (ENOSPC), when a claim is taken, then it fails loudly and leaves no temp file beside the claim (R25-scripts-a-L1-01b)', (t) => {
  const r = root();
  const rename = fs.renameSync;
  t.after(() => { fs.renameSync = rename; });
  fs.renameSync = () => { const err = new Error('no space left on device'); err.code = 'ENOSPC'; throw err; };
  assert.throws(() => tryClaim(r, { owner: 'session:s-1' }), /no space left/);
  fs.renameSync = rename;
  const dir = path.dirname(claimFile(r));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  assert.equal(readClaim(r), null);
});
