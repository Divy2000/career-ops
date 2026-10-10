// One AI policy pass at a time across the Control Center and the scheduled daily job: a pass takes the queued items by
// creating data/immigration/.policy-pass.claim, and both sides honour it (SW8-server-01 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claimFile, readClaim, releaseClaim, retagClaim, tryClaim } from '../policy-claim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, '..', 'policy-claim.mjs')).href;

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-claim-'));
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

/** A bash running a script named run-daily.sh, as launchd starts the job; stopped by the returned function. */
function fakeDailyJob() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-claim-job-'));
  const script = path.join(dir, 'run-daily.sh');
  fs.writeFileSync(script, 'sleep 30\n');
  const job = spawn('/bin/bash', [script], { stdio: 'ignore' });
  return { pid: job.pid, stop: () => job.kill('SIGKILL') };
}

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
