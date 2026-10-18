// One AI policy pass at a time across the Control Center and the scheduled daily job: a pass takes the queued items by
// creating data/immigration/.policy-pass.claim, and both sides honour it (SW8-server-01 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
// A fake for withRecordedSpawns (below): ps cannot be spawned at all.
const PS_FAILS = `if (/(^|\\/)ps$/.test(file)) throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' });`;

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
    // ps that cannot run proves nothing about the job: it keeps the claim. ps is called by absolute path, so a PATH
    // without it would not stop it; the spawn itself fails instead (R32-tests-custom-L1-01).
    const { calls, out } = withRecordedSpawns(`(c) => c.tryClaim(${JSON.stringify(r)}, { owner: 'session:s-new', batch: null }).ok`, { fake: PS_FAILS });
    assert.equal(out, false);
    assert.ok(calls.some((call) => call.file === '/bin/ps'), 'the check never reached ps');
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
  const { out } = withRecordedSpawns(`(c) => c.tryClaim(${JSON.stringify(r)}, { owner: 'session:s-taker', batch: null })`, { fake: PS_FAILS });
  assert.deepEqual(out, { ok: true });
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
  plant(r, { owner: 'starting:reused', batch: null, at: new Date().toISOString(), pid: process.pid, pidStart: 0 });
  assert.deepEqual(tryClaim(r, { owner: 'starting:next', batch: null }), { ok: true });
});

test('a start taken in one time zone holds against a claimant in another (R28-tests-custom-L1-01)', async () => {
  const r = root();
  // The Control Center server runs in the user's shell TZ, the launchd daily job in the system zone.
  const holderCode = `const { tryClaim } = await import(${JSON.stringify(MODULE)}); process.stdout.write(String(tryClaim(${JSON.stringify(r)}, { owner: 'starting:cc', batch: null }).ok)); process.stdin.resume();`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode], { env: { ...process.env, TZ: 'Pacific/Kiritimati' } });
  try {
    const out = await new Promise((resolve, reject) => {
      holder.stdout.once('data', (d) => resolve(String(d)));
      holder.on('error', reject);
      holder.on('close', () => resolve(''));
    });
    assert.equal(out, 'true');
    const contendCode = `const { tryClaim } = await import(${JSON.stringify(MODULE)}); process.stdout.write(JSON.stringify(tryClaim(${JSON.stringify(r)}, { owner: 'daily:1', batch: null })));`;
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', contendCode], { env: { ...process.env, TZ: 'Pacific/Pago_Pago' }, encoding: 'utf8' });
    assert.equal(contender.status, 0, contender.stderr);
    const answer = JSON.parse(contender.stdout);
    assert.equal(answer.ok, false);
    assert.equal(answer.holder.owner, 'starting:cc');
    assert.equal(typeof readClaim(r).pidStart, 'number');
  } finally {
    holder.stdin.end();
  }
});

test('a start claim in the earlier format whose text does not parse holds on its live pid only while recent (R28-tests-custom-L1-01)', () => {
  const r = root();
  plant(r, { owner: 'starting:legacy', batch: null, at: new Date().toISOString(), pid: process.pid, pidStart: 'gestern' });
  assert.equal(tryClaim(r, { owner: 'daily:1', batch: null }).ok, false);
  plant(r, { owner: 'starting:legacy', batch: null, at: new Date(Date.now() - 60 * 60_000).toISOString(), pid: process.pid, pidStart: 'gestern' });
  assert.deepEqual(tryClaim(r, { owner: 'daily:1', batch: null }), { ok: true });
});

test('a start claim in the earlier format on a reused pid is taken over, recent or not (R28-tests-custom-L1-01 review)', () => {
  const r = root();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  plant(r, { owner: 'starting:legacy', batch: null, at: old, pid: process.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
  assert.deepEqual(tryClaim(r, { owner: 'daily:1', batch: null }), { ok: true });
  plant(r, { owner: 'starting:legacy', batch: null, at: new Date().toISOString(), pid: process.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
  assert.deepEqual(tryClaim(r, { owner: 'daily:1', batch: null }), { ok: true });
  // The same format naming this process's start as ps prints it here still holds past the recent window.
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  plant(r, { owner: 'starting:legacy', batch: null, at: old, pid: process.pid, pidStart: lstart });
  assert.equal(tryClaim(r, { owner: 'daily:1', batch: null }).ok, false);
});

test('a start claim in the earlier format written in another zone holds while its process runs, past the recent window (R28-tests-custom-L1-01 review 2)', () => {
  const r = root();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: zone } }).trim();
    plant(r, { owner: 'starting:legacy', batch: null, at: old, pid: process.pid, pidStart: lstart });
    assert.equal(tryClaim(r, { owner: 'daily:1', batch: null }).ok, false, zone);
  }
});

test('a start claim in the earlier format holds when ps cannot run, however old (R28-tests-custom-L1-01 review 2)', () => {
  const r = root();
  plant(r, { owner: 'starting:legacy', batch: null, at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), pid: process.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
  // ps is called by absolute path (R31-srv-core-L2-01), so a PATH without it no longer stops it: the spawn fails instead.
  const { out } = withRecordedSpawns(`(c) => c.tryClaim(${JSON.stringify(r)}, { owner: 'daily:1', batch: null }).ok`, { fake: PS_FAILS });
  assert.equal(out, false);
});

test('a start claim naming its live process by epoch start time holds when ps cannot run, though its start time names another start (R32-tests-custom-L1-01)', () => {
  const r = root();
  // With ps running, a start time of 0 is proof the pid was reused (the R31-srv-core-L2-01 test below sees it say no).
  plant(r, { owner: 'starting:x', batch: null, at: new Date().toISOString(), pid: process.pid, pidStart: 0 });
  const { calls, out } = withRecordedSpawns(`(c) => c.tryClaim(${JSON.stringify(r)}, { owner: 'daily:1', batch: null }).ok`, { fake: PS_FAILS });
  assert.equal(out, false);
  assert.ok(calls.some((call) => call.file === '/bin/ps'), 'the check never reached ps');
});

test('a start claim in the earlier format is taken over once a day old, even when its text names this process (R28-tests-custom-L1-01 review 3)', () => {
  const r = root();
  // A zone offset that matches by chance (a reused pid started a whole quarter-hour away) must not hold for good.
  const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'Pacific/Kiritimati' } }).trim();
  plant(r, { owner: 'starting:legacy', batch: null, at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), pid: process.pid, pidStart: lstart });
  assert.deepEqual(tryClaim(r, { owner: 'daily:1', batch: null }), { ok: true });
});

/**
 * Starts `count` claimants in `dataRoot` and resolves their answers. Each runs `prelude`, loads policy-claim.mjs, writes
 * ready-<pid> and waits for a go file the parent writes only once every claimant is ready, so all of them claim in the
 * same instant however slowly each one boots (R30-tests-custom-L1-01). Each claimant stays alive until all have
 * answered: a start's claim holds only while its process runs.
 */
async function claimAtOnce(dataRoot, { count = 8, prelude = '' } = {}) {
  const go = path.join(dataRoot, 'go');
  const readyDir = path.join(dataRoot, 'ready');
  fs.mkdirSync(readyDir);
  const code = `const fs = (await import('node:fs')).default; ${prelude} const { tryClaim } = await import(${JSON.stringify(MODULE)}); fs.writeFileSync(${JSON.stringify(readyDir)} + '/ready-' + process.pid, ''); while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((res) => setTimeout(res, 1)); process.stdout.write(String(tryClaim(${JSON.stringify(dataRoot)}, { owner: 'starting:' + process.pid, batch: null }).ok)); process.stdin.resume();`;
  const children = [];
  try {
    let exited = 0;
    const outs = Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
      children.push(child);
      child.stdout.once('data', (d) => resolve(String(d)));
      child.on('error', reject);
      child.on('close', () => { exited++; resolve(''); });
    })));
    while (fs.readdirSync(readyDir).length < count) {
      if (exited) {
        // The rest are still polling for go, where closing stdin does not reach them.
        for (const child of children) child.kill();
        throw new Error(`a claimant exited before it was ready (${fs.readdirSync(readyDir).length}/${count} ready)`);
      }
      await new Promise((res) => setTimeout(res, 5));
    }
    fs.writeFileSync(go, '');
    return await outs;
  } finally {
    for (const child of children) child.stdin.end();
  }
}

test('many processes claiming at once: exactly one gets it', async () => {
  const outs = await claimAtOnce(root());
  assert.equal(outs.filter((o) => o === 'true').length, 1, outs.join(','));
});

test('many processes finding a crashed claimant\'s stale lock at once: exactly one breaks it and gets the claim (R19-scripts-a-L1-02)', async () => {
  for (let round = 0; round < 5; round++) {
    const r = root();
    // A claimant killed inside the lock left it behind, long enough ago to be broken.
    const lock = `${claimFile(r)}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    // Every claimant judges the old lock stale in the same poll, and each is descheduled for a moment between that
    // verdict and its removal of the lock, the window in which another claimant can break the same lock and take a new one.
    const prelude = `const rm = fs.rmSync; fs.rmSync = (p, o) => { if (String(p).endsWith('.lock')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); return rm(p, o); };`;
    const answers = await claimAtOnce(r, { prelude });
    assert.equal(answers.filter((o) => o === 'true').length, 1, `round ${round}: ${answers.join(',')}`);
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

/**
 * A second process that took the claim lock and is stuck inside it: the session it judges has a FIFO for meta.json, so
 * reading it blocks until killed. Resolves once the child has marked the lock as its own.
 */
async function childInsideLock(dataRoot) {
  const dir = path.join(dataRoot, 'data', 'control-center', 'sessions', 's-stuck');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('/usr/bin/mkfifo', [path.join(dir, 'meta.json')]);
  plant(dataRoot, { owner: 'session:s-stuck', batch: null, at: new Date().toISOString() });
  const code = `const { tryClaim } = await import(${JSON.stringify(MODULE)}); tryClaim(${JSON.stringify(dataRoot)}, { owner: 'daily:1', batch: null });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const owner = path.join(`${claimFile(dataRoot)}.lock`, 'owner');
  for (let i = 0; !(fs.existsSync(owner) && fs.readFileSync(owner, 'utf8')); i++) {
    if (i > 2000 || child.exitCode !== null) {
      child.kill('SIGKILL');
      throw new Error('the child never took the claim lock');
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  return { child, exited, unstick: () => { fs.rmSync(path.join(dir, 'meta.json')); session(dataRoot, 's-stuck', 'done'); } };
}

test('Given a claimant killed while holding the claim lock, the next claim breaks the lock at once instead of waiting for it to age (R35-scripts-a-L1-01)', async () => {
  const r = root();
  const { child, exited, unstick } = await childInsideLock(r);
  try {
    child.kill('SIGKILL');
    await exited;
    unstick();
    const t0 = Date.now();
    assert.deepEqual(tryClaim(r, { owner: 'session:s-new', batch: null }), { ok: true });
    assert.ok(Date.now() - t0 < 2000, `the claim waited ${Date.now() - t0} ms`);
    assert.equal(fs.existsSync(`${claimFile(r)}.lock`), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('Given a live claimant holding the claim lock, another claim still waits and is refused rather than breaking it (R35-scripts-a-L1-01)', async () => {
  const r = root();
  const { child, exited } = await childInsideLock(r);
  try {
    assert.throws(() => tryClaim(r, { owner: 'session:s-new', batch: null }), /is held by another claimant/);
    assert.equal(child.exitCode, null, 'the holder ended early');
    assert.equal(fs.existsSync(path.join(`${claimFile(r)}.lock`, 'owner')), true, 'the live holder\'s lock was broken');
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
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

test('given a claim whose rename into place fails and whose temp cleanup also fails, when tryClaim runs, then the rename error is thrown and the cleanup failure is only noted (R28-scripts-a-L1-01)', () => {
  const r = root();
  const code = `const fs = (await import('node:fs')).default;
const realRename = fs.renameSync, realRm = fs.rmSync;
fs.renameSync = (from, to) => { if (String(from).includes('.policy-pass.claim.tmp-')) { const err = new Error('i/o error'); err.code = 'EIO'; throw err; } return realRename(from, to); };
fs.rmSync = (target, opts) => { if (String(target).includes('.policy-pass.claim.tmp-')) { const err = new Error('permission denied'); err.code = 'EACCES'; throw err; } return realRm(target, opts); };
const { tryClaim } = await import(${JSON.stringify(MODULE)});
try { tryClaim(${JSON.stringify(r)}, { owner: 'session:s-1', batch: null }); process.stdout.write('no error'); } catch (err) { process.stdout.write(err.message); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'i/o error');
  assert.match(child.stderr, /could not remove the temp file .*\.policy-pass\.claim\.tmp-\d+: permission denied/);
  assert.equal(readClaim(r), null);
});

/**
 * Runs `body` in a child that loads policy-claim.mjs with execFileSync wrapped: each call's file and environment is
 * recorded, and `fake` (when given) answers instead of the real spawn. Resolves the recorded calls and the body's output.
 */

function withRecordedSpawns(body, { fake = '', env = {} } = {}) {
  const code = `const { createRequire, syncBuiltinESMExports } = await import('node:module');
const cp = createRequire(import.meta.url)('node:child_process');
const real = cp.execFileSync; const calls = [];
cp.execFileSync = (file, args, opts) => { calls.push({ file, args, env: opts?.env ?? null }); ${fake} return real(file, args, opts); };
syncBuiltinESMExports();
const claim = await import(${JSON.stringify(MODULE)});
const out = await (${body})(claim);
process.stdout.write(JSON.stringify({ calls, out }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('given server secrets in the environment, when a claim owner is checked, then ps runs as /bin/ps with only a minimal environment (R31-srv-core-L2-01)', () => {
  const r = root();
  const secrets = { CC_TOKEN: 'tok-secret', CC_SESSION_SECRET: 'cookie-secret', ANTHROPIC_API_KEY: 'sk-secret' };
  const body = `async (c) => {
    const r = ${JSON.stringify(r)};
    (await import('node:fs')).default.writeFileSync(r + '/data/immigration/.run-daily.pid', String(process.pid));
    return [
      c.ownerLive(r, { owner: 'daily:' + process.pid }),
      c.ownerLive(r, { owner: 'starting:x', at: new Date().toISOString(), pid: process.pid, pidStart: 0 }),
    ];
  }`;
  const { calls, out } = withRecordedSpawns(body, { env: secrets });
  // This node process is neither bash running run-daily.sh nor started at the epoch: both checks reached ps and said no.
  assert.deepEqual(out, [false, false]);
  const ps = calls.filter((call) => /(^|\/)ps$/.test(call.file));
  assert.equal(ps.length, 2, JSON.stringify(calls));
  for (const call of ps) {
    assert.equal(call.file, '/bin/ps');
    assert.ok(call.env, `${call.args.join(' ')} inherited the full environment`);
    assert.deepEqual(Object.keys(call.env).sort(), ['LC_ALL', 'PATH', 'TZ'], call.args.join(' '));
  }
});
