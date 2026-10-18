// install.sh specs: launchd, the health checks and the Control Center start. Split from install.spec.mjs so the files run in parallel (shared setup in install-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// The real lock writer's start time, so a running-Control-Center lock carries what acquireInstanceLock writes.
import { processStartTime } from '../../control-center/supervisor/instance-lock.ts';
import { fresh, READY_FILES, read } from './install-fixtures.mjs';

// ---------------------------------------------------------------- launchd, health, start

test('launchd is skipped while onboarding is incomplete and the follow-up command is printed', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(w.calls('launchd-install').length, 0);
  assert.match(r.out, /custom\/launchd\/install\.sh' --jobs daily/);
  assert.equal(r.status, 3);
});

test('launchd is skipped while doctor still reports an unpersonalized file', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_UNPERSONALIZED: 'modes/_profile.md' } });
  assert.equal(w.calls('launchd-install').length, 0);
});

test('launchd is skipped while modes/_brief.md is still the template the install seeded, as the real doctor reports it (R11-tests-custom-L1-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const { 'modes/_brief.md': _brief, ...rest } = READY_FILES;
  w.makeCheckout(D, { files: rest });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(read(D, 'modes', '_brief.md'), read(D, 'modes', '_brief.template.md'), 'the install seeded _brief.md from its template');
  assert.equal(w.calls('launchd-install').length, 0, r.out);
  assert.match(r.out, /Onboarding is not finished \(still needed: modes\/_brief\.md\)/);
  assert.equal(r.status, 3, r.out);
});

test('launchd is skipped while modes/_brief.md, edited, still carries one of its template\'s placeholders, as the real doctor reports it', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  fs.writeFileSync(path.join(D, 'modes', '_brief.md'), `${read(D, 'modes', '_brief.template.md')}My own note\n`);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(w.calls('launchd-install').length, 0, r.out);
  assert.match(r.out, /Onboarding is not finished \(still needed: modes\/_brief\.md\)/);
});

test('a ready install gets the daily job only; --with-upstream-sync gets both', () => {
  const a = fresh({ keychain: true });
  a.w.makeCheckout(a.D, { files: READY_FILES });
  const r = a.w.run(['--dir', a.D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.deepEqual(a.w.calls('launchd-install'), ['launchd-install --jobs daily'], r.out);
  const b = fresh({ keychain: true });
  b.w.makeCheckout(b.D, { files: READY_FILES });
  b.w.run(['--dir', b.D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none', '--with-upstream-sync']);
  assert.deepEqual(b.w.calls('launchd-install'), ['launchd-install --jobs all']);
});

test('a daily job that is already installed is reinstalled for this checkout, which keeps its time and on/off state (SW3-scripts-02)', () => {
  for (const [extra, jobs] of [[[], 'daily'], [['--with-upstream-sync'], 'all']]) {
    const { w, D } = fresh({ keychain: true });
    w.makeCheckout(D, { files: READY_FILES });
    const agents = path.join(w.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'com.career-ops.immigration-watch.plist'), 'an install from another checkout');
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none', ...extra]);
    assert.deepEqual(w.calls('launchd-install'), [`launchd-install --jobs ${jobs}`], r.out);
    assert.match(r.out, /The daily job is already installed; reinstalling it for this checkout keeps its time and on\/off state from the Control Center\./);
    assert.equal(r.status, 0, r.out);
  }
});

test('a data root in a protected place gets the Full Disk Access note naming it, though the checkout is elsewhere (SW3-scripts-03, SW6-scripts-02)', () => {
  const places = [
    ['Documents', (home) => path.join(home, 'Documents', 'career-data')],
    ['Downloads', (home) => path.join(home, 'Downloads', 'career-data')],
    ['iCloud Drive', (home) => path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'career-data')],
  ];
  for (const [place, at] of places) {
    const { w, D } = fresh({ keychain: true });
    const data = at(w.home);
    w.makeCheckout(D);
    fs.mkdirSync(data, { recursive: true });
    for (const [rel, text] of Object.entries(READY_FILES)) {
      fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
      fs.writeFileSync(path.join(data, rel), text);
    }
    const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
    assert.deepEqual(w.calls('launchd-install'), ['launchd-install --jobs daily'], r.out);
    assert.ok(r.out.includes(`Note: the data root is under ${place}; give /bin/bash Full Disk Access (System Settings > Privacy & Security) so launchd can write it.`), `${place}:\n${r.out}`);
    assert.doesNotMatch(r.out, /the checkout is under (Desktop|Documents|Downloads|iCloud Drive)/, place);
  }
});

test('a checkout reached through a symlink into Documents gets the checkout note (SW6-scripts-02)', () => {
  const { w } = fresh({ keychain: true });
  const real = path.join(w.home, 'Documents', 'career-ops');
  w.makeCheckout(real, { files: READY_FILES });
  const link = path.join(w.T, 'career-ops-link');
  fs.symlinkSync(real, link);
  const r = w.run(['--dir', link, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.deepEqual(w.calls('launchd-install'), ['launchd-install --jobs daily'], r.out);
  assert.match(r.out, /Note: the checkout is under Documents; give \/bin\/bash Full Disk Access \(System Settings > Privacy & Security\) so launchd can read it\./);
});

test('a job running right now makes the launchd step a pending action to re-run once it finishes, not a failure (SW5-scripts-02)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_LAUNCHD_EXIT: '4' } });
  assert.deepEqual(w.calls('launchd-install'), ['launchd-install --jobs daily']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /A launchd job is running right now, so it was left as it was\. Once it finishes, run: bash .*custom\/launchd\/install\.sh' --jobs daily/);
  assert.doesNotMatch(r.out, /The launchd install failed/);
});

test('--no-launchd and a missing Keychain item both skip the job', () => {
  const a = fresh({ keychain: true });
  a.w.makeCheckout(a.D, { files: READY_FILES });
  a.w.run(a.args());
  assert.equal(a.w.calls('launchd-install').length, 0);
  const b = fresh({ keychain: false });
  b.w.makeCheckout(b.D, { files: READY_FILES });
  b.w.run(['--dir', b.D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(b.w.calls('launchd-install').length, 0);
});

test('a ready install runs the health checks and a clean run exits 0; the Control Center starts last unless --no-start', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  const log = w.log();
  assert.ok(log.includes('doctor '), log.join('\n'));
  assert.ok(log.includes(`npm --prefix custom/control-center run preflight (cwd=${D})`), log.join('\n'));
  assert.equal(log[log.length - 1], 'cc ', log.join('\n'));
  assert.equal(r.status, 0, r.out);
});

test('the Control Center is not started while the Keychain token is missing', () => {
  const { w, D } = fresh({ keychain: false });
  w.makeCheckout(D, { files: READY_FILES });
  w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(w.calls('cc').length, 0);
});

test('a re-run with the Control Center already running skips its npm ci and does not start a second instance (R17-scripts-b-L1-02)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must not run under a running Control Center');
    assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
    assert.match(r.out, /already running/);
    assert.equal(r.status, 3, `the skipped npm ci is unfinished work, so the run ends with pending actions (R27-scripts-b-L1-01)\n${r.out}`);
    assert.match(r.out, /Done, with pending actions:\n(?:.*\n)*?\s+\d+\. The Control Center was running, so its dependencies were not reinstalled: stop it, run npm --prefix .*custom\/control-center'? ci, then start it again/);
    assert.doesNotMatch(r.out, /^Done\.$/m);
    assert.match(r.out, /npm --prefix custom\/control-center ci/, 'the skip message names the npm ci command, not a restart');
    assert.doesNotMatch(r.out, /restart it to pick up changes/, 'a restart does not install dependencies');
  } finally {
    child.kill('SIGKILL');
  }
});

test('given a running Control Center\'s lock carries its real start time, as acquireInstanceLock writes it, a re-run treats it as running: no npm ci, no second instance (R27-tests-custom-L2-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = processStartTime(child.pid);
  assert.equal(typeof start, 'number', `the writer must read a start, or the lock is the legacy null format: ${start}`);
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.equal(r.status, 3, `the skipped npm ci is a pending action\n${r.out}`);
    assert.match(r.out, /\d+\. The Control Center was running, so its dependencies were not reinstalled: stop it/);
    assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), `npm ci must not run under a running Control Center\n${r.out}`);
    assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
    assert.match(r.out, /already running/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a re-run that moves the data root with --data-root still sees the Control Center running on the old root: no npm ci under it, no second instance (R20-scripts-b-L1-02)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--data-root', path.join(w.T, 'co-data'), '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), `npm ci must not run under a running Control Center\n${r.out}`);
    assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
    assert.match(r.out, /already running/);
  } finally {
    child.kill('SIGKILL');
  }
});

/** The daily job's plist as launchd/install.sh writes it for <checkout>, logging under <jobRoot>, plus a live Control Center lock there. */
function controlCenterOnJobRoot(w, checkout) {
  const jobRoot = path.join(w.T, 'job-data');
  const agents = path.join(w.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.career-ops.immigration-watch.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.career-ops.immigration-watch</string>
  <key>WorkingDirectory</key><string>${checkout}</string>
  <key>StandardOutPath</key><string>${jobRoot}/data/immigration/logs/launchd.out.log</string>
</dict>
</plist>
`);
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(jobRoot, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  return child;
}

test('a re-run sees the Control Center running on the data root the installed daily job names, when this run resolves another (R20-scripts-b-L2-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = controlCenterOnJobRoot(w, D);
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), `npm ci must not run under a running Control Center\n${r.out}`);
    assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
    assert.match(r.out, /already running/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a Control Center running on the data root of a daily job another checkout installed does not stop this checkout\'s npm ci or start (R20-scripts-b review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const other = path.join(w.T, 'other-checkout');
  fs.mkdirSync(other);
  const child = controlCenterOnJobRoot(w, other);
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), r.out);
    assert.equal(w.calls('cc').length, 1, r.out);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a stale Control Center lock whose PID was reused is reinstalled, not skipped (R17-scripts-b-L1-02)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: Math.floor(Date.now() / 1000) - 100000, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.equal(r.status, 0, r.out);
    assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must run when the lock is stale (reused PID)');
  } finally {
    child.kill('SIGKILL');
  }
});

// PID 1 is launchd, owned by root: kill(1, 0) is refused with EPERM, yet ps still reads when it started.
test('a stale Control Center lock naming a reused PID of another user is reinstalled, not skipped (R18-scripts-b-review-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, start: 1, port: 4317, nonce: 'test' }));
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(r.status, 0, r.out);
  assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must run when the lock names another user\'s process that started at another time');
});

// The supervisor rejects a lock without an integer port (parseHolder) and replaces it once it is older than
// UNREADABLE_LOCK_GRACE_MS, live PID or not.
test('a malformed Control Center lock past its grace is not running, so npm ci runs and the Control Center starts (R18-scripts-b-review-02)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
    assert.equal(r.status, 0, r.out);
    assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must run when the lock is malformed');
    assert.equal(w.calls('cc').length, 1, 'the Control Center starts when the lock is malformed');
  } finally {
    child.kill('SIGKILL');
  }
});

// acquireInstanceLock throws on a lock it cannot read rather than replacing it, so no second instance starts.
test('a Control Center lock that cannot be read is treated as running: no npm ci, no second start (R18-scripts-b-review-05)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  // A directory in the lock's place: reading it fails (EISDIR) for every user, root included, unlike chmod 000.
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(r.status, 3, `its skipped npm ci is a pending action (R27-scripts-b-L1-01)\n${r.out}`);
  assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must not run while the lock cannot be read');
  assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
  assert.match(r.out, /\d+\. The Control Center lock .*supervisor\.lock'? cannot be read, so its dependencies were not reinstalled: if no Control Center is running, remove that lock, run npm --prefix .*custom\/control-center'? ci, then start it: .*bin\/cc/, r.out);
  assert.doesNotMatch(r.out, /was running|already running|stop it/, `nothing may be running, so the run does not say it is (R27 merge review)\n${r.out}`);
});

test('given the Control Center lock becomes unreadable after its npm ci ran, the run does not start it and leaves removing the lock as a pending action (R27 merge review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_MKDIR: lock } });
  assert.equal(r.status, 3, r.out);
  assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'its npm ci ran before the lock appeared');
  assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
  assert.match(r.out, /\d+\. The Control Center lock .*supervisor\.lock'? cannot be read, so it was not started: if no Control Center is running, remove that lock, then start it: .*bin\/cc/);
  assert.doesNotMatch(r.out, /dependencies were not reinstalled|already running/);
});

test('given its npm ci was skipped for an unreadable lock that is gone by the end of a --no-start run, the pending action does not say the Control Center was running (R27 merge review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.symlinkSync(path.join(D, 'data', 'control-center', 'nowhere'), lock);
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_REMOVE: lock } });
  assert.equal(r.status, 3, r.out);
  assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'a --no-start run does not install it');
  assert.match(r.out, /\d+\. The Control Center lock could not be read, so its dependencies were not reinstalled; it is gone now: run npm --prefix .*custom\/control-center'? ci, then start it: .*bin\/cc/);
  assert.doesNotMatch(r.out, /was running/);
});

test('given its npm ci was skipped for an unreadable lock and a Control Center holds a readable lock by the end, the pending action says it is running now, not that it was (R27 merge review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.symlinkSync(path.join(D, 'data', 'control-center', 'nowhere'), lock);
  // The doctor step replaces the dangling link with a live Control Center's lock.
  const live = path.join(w.T, 'live.lock');
  fs.writeFileSync(live, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_COPY_FROM: live, FAKE_DOCTOR_COPY_TO: path.join(D, 'data', 'control-center', 'nowhere') } });
    assert.match(r.out, /Control Center lock .* cannot be read; leaving its dependencies as they are/, 'the npm ci was skipped for the unreadable lock');
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /\d+\. The Control Center lock could not be read when its dependencies were due, and a Control Center is running now: stop it, run npm --prefix .*custom\/control-center'? ci, then start it again/);
    assert.doesNotMatch(r.out, /was running/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a Control Center that stops after its npm ci was skipped gets that npm ci before the installer starts it (R18-scripts-b-review-06)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_REMOVE: lock } });
    assert.equal(r.status, 0, r.out);
    const log = w.log();
    const ci = log.findIndex((l) => l.startsWith('npm --prefix custom/control-center ci'));
    assert.ok(ci > log.findIndex((l) => l.startsWith('doctor ')), `npm ci must run after the Control Center stopped: ${log.join('\n')}`);
    assert.equal(log[log.length - 1], 'cc ', log.join('\n'));
  } finally {
    child.kill('SIGKILL');
  }
});

test('a Control Center that stops after its npm ci was skipped, on a --no-start run, leaves that npm ci as a pending action (R27-scripts-b-L1-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_REMOVE: lock } });
    assert.equal(r.status, 3, r.out);
    assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'a --no-start run does not install it either');
    assert.match(r.out, /\d+\. The Control Center was running, so its dependencies were not reinstalled; it has stopped since: run npm --prefix .*custom\/control-center'? ci, then start it: .*custom\/control-center\/bin\/cc/);
    assert.doesNotMatch(r.out, /stop it, run npm/, 'there is nothing left to stop (R27 merge review)');
  } finally {
    child.kill('SIGKILL');
  }
});

test('the Control Center preflight runs again after the deferred npm ci, before the start (R18-scripts-b-review-07)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_DOCTOR_REMOVE: lock } });
    assert.equal(r.status, 0, r.out);
    const log = w.log();
    const ci = log.findIndex((l) => l.startsWith('npm --prefix custom/control-center ci'));
    assert.ok(ci !== -1 && log.slice(ci).some((l) => l.startsWith('npm --prefix custom/control-center run preflight')), `the preflight must run after the deferred npm ci: ${log.join('\n')}`);
    assert.equal(log[log.length - 1], 'cc ', log.join('\n'));
  } finally {
    child.kill('SIGKILL');
  }
});

// acquireInstanceLock cannot take a lock path that is a dangling symlink (the link fails, the read finds nothing),
// so it refuses to start: the helpers must not reinstall or start a second instance either.
test('a Control Center lock that is a dangling symlink is treated as running (R18-scripts-b-review-08)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.symlinkSync(path.join(D, 'data', 'control-center', 'nowhere'), lock);
  const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  assert.equal(r.status, 3, `its skipped npm ci is a pending action (R27-scripts-b-L1-01)\n${r.out}`);
  assert.ok(!w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), 'npm ci must not run');
  assert.equal(w.calls('cc').length, 0, 'a second Control Center must not start');
  assert.match(r.out, /\d+\. The Control Center lock .*supervisor\.lock'? cannot be read, so its dependencies were not reinstalled: if no Control Center is running, remove that lock, run npm --prefix .*custom\/control-center'? ci, then start it: .*bin\/cc/, r.out);
  assert.doesNotMatch(r.out, /was running|already running|stop it/, `nothing may be running, so the run does not say it is (R27 merge review)\n${r.out}`);
});

// Only this run's own root is one the supervisor would start on; on the root the data moved away from, a lock that
// names no live process is just left over.
test('a dangling Control Center lock on the root --data-root moves away from is not running: npm ci runs and the Control Center starts (R20-scripts-b review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.symlinkSync(path.join(D, 'data', 'control-center', 'nowhere'), lock);
  const r = w.run(['--dir', D, '--data-root', path.join(w.T, 'co-data'), '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none']);
  assert.ok(w.log().some((l) => l.startsWith('npm --prefix custom/control-center ci')), r.out);
  assert.equal(w.calls('cc').length, 1, r.out);
});
