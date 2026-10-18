// The invariants in custom/install/install.invariants.md, part 2: the ones only whole installer runs show (every exit
// path releases what the run holds; headless onboarding changes nothing before its last refusal). Split from
// install-invariants.spec.mjs so node --test runs the two in parallel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { INSTALL_SH } from './harness.mjs';
import { fresh, md } from './install-fixtures.mjs';

const dailyLock = (D) => path.join(D, 'data', 'immigration', '.run-daily.lockf');
const lockFree = (D) => spawnSync('/usr/bin/lockf', ['-k', '-t', '0', dailyLock(D), '/usr/bin/true']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A running daily job: holds the lock in its own process group, touching `ready` once it has it. */
function holdDailyLock(w, D) {
  const ready = path.join(w.T, 'holder-ready');
  const holder = spawn('/bin/sh', ['-c', `/usr/bin/lockf -k -t 0 "${dailyLock(D)}" /bin/sh -c 'touch "${ready}"; sleep 60'`], { stdio: 'ignore', detached: true });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
  assert.ok(fs.existsSync(ready), 'the holder never took the lock');
  return { stop: () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ } } };
}

/** Starts the installer in its own process group and TMPDIR, sends `signal` to the group once `ready(out)` holds. */
async function signalledRun(w, args, { env, signal, ready }) {
  const tmp = path.join(w.T, 'run-tmp');
  fs.mkdirSync(tmp);
  let out = '';
  const child = spawn('bash', [INSTALL_SH, ...args], { env: { ...w.env(), ...env, TMPDIR: tmp }, cwd: w.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ended = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  const deadline = Date.now() + 60_000;
  while (!ready(out) && child.exitCode === null && Date.now() < deadline) await sleep(50);
  assert.ok(ready(out) && child.exitCode === null, `the installer never reached the interruption point:\n${out}`);
  process.kill(-child.pid, signal);
  const end = await ended;
  return { end, out, tmp };
}

// ---------------------------------------------------------------- invariants 2 and 4: every exit releases everything

for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGQUIT', 131], ['SIGTERM', 143]]) {
  test(`${signal} while the installer waits for the daily lock exits ${code}, leaves no temp file and no waiter that later takes the lock (R31-scripts-b-L1-01, R32-scripts-b-L1-02)`, async () => {
    const { w, D, args } = fresh();
    w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
    const job = holdDailyLock(w, D);
    let r;
    try {
      r = await signalledRun(w, args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '60' }, signal, ready: (out) => /The daily job is running; waiting up to 60s/.test(out) });
    } finally {
      job.stop();
    }
    assert.deepEqual(fs.readdirSync(r.tmp), [], `${signal}: ${r.out}`);
    assert.equal(r.end.code, code, `${signal}: ${JSON.stringify(r.end)}\n${r.out}`);
    // A waiter still queued would take the lock within lockf's retry interval once the job is gone.
    const pidFile = path.join(D, 'data', 'immigration', '.live-update.pid');
    for (const until = Date.now() + 1500; Date.now() < until; await sleep(50)) assert.equal(fs.existsSync(pidFile), false, `${signal}: the lock was taken for a gone installer`);
    assert.ok(lockFree(D), `${signal}: the daily lock is free`);
  });
}

test('an installer that fails while holding the daily lock has released it, and removed .live-update.pid, by the time it has exited (R32-scripts-b-L1-02)', () => {
  // Several runs, since a holder that only polls for the installer can win the race now and then.
  for (let i = 0; i < 3; i++) {
    const { w, D, args } = fresh();
    w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
    const r = w.run(args(), { env: { FAKE_NPM_EXIT: '1' } });
    const pidFile = fs.existsSync(path.join(D, 'data', 'immigration', '.live-update.pid'));
    const free = lockFree(D);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /error: npm .* failed in /);
    assert.equal(pidFile, false, `run ${i}: .live-update.pid outlived the installer`);
    assert.equal(free, true, `run ${i}: the daily lock outlived the installer`);
  }
});

// ---------------------------------------------------------------- invariant 8: no headless side effect before a refusal

const REFUSALS = [
  ['no Keychain item', { keychain: false }],
  ['an unreadable token', { env: { FAKE_SECURITY_READ_EXIT: '36' } }],
  ['an empty token', { env: { FAKE_SECURITY_TOKEN: '  ' } }],
  ['a Claude Code below the floor', { env: { FAKE_CLAUDE_VERSION: '2.1.287' }, versions: ['2.1.287', '2.1.289'] }],
  ['an unapproved Claude Code', { env: { FAKE_CLAUDE_VERSION: '2.1.300' } }],
  ['an unreadable contract', { versions: null }],
  ['a Claude Code updated in place before the run', { env: { FAKE_CLAUDE_LATER_VERSION: '2.1.300', FAKE_CLAUDE_LATER_AFTER: '2' } }],
];

test('every headless refusal leaves an earlier run\'s drafts where "Resume from drafts" reads them and creates no draft folder (R33-scripts-b-L1-01)', () => {
  for (const [why, { keychain = true, env = {}, versions = ['2.1.289'] }] of REFUSALS) {
    const { w, D } = fresh({ keychain });
    const contract = path.join(w.fakeSrc, 'custom/control-center/server/core/contract.json');
    if (versions) fs.writeFileSync(contract, JSON.stringify({ claude: { approvedVersions: versions } }));
    else fs.rmSync(contract);
    const data = path.join(w.T, 'mydata');
    const draft = path.join(data, 'data', 'install', 'onboarding-draft');
    fs.mkdirSync(draft, { recursive: true });
    fs.writeFileSync(path.join(draft, 'article-digest.md'), '# from an earlier run\n');
    const resume = md(w, 'resume.md', '# Me\n');
    const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env });
    assert.equal(r.status, 3, `${why}: ${r.out}`);
    assert.equal(w.claudeArgv()?.[0] === '-p', false, `${why}: claude ran`);
    assert.deepEqual(fs.readdirSync(path.dirname(draft)).filter((n) => n.startsWith('onboarding-draft')), ['onboarding-draft'], why);
    assert.deepEqual(fs.readdirSync(draft), ['article-digest.md'], why);
  }
});
