import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeWorld, installLogs, INSTALL_SH, INSTALL_DIR, FORK_URL } from './harness.mjs';
import { SECRET, QUIET, WORLD_PTY_SKIP, fresh, READY_FILES, read, exists, md, seededCustom, withoutTests } from './install-fixtures.mjs';

// ---------------------------------------------------------------- the harness itself

test('the world snapshot sees a change inside a fake checkout as well as anywhere else under the world', () => {
  const { w, D } = fresh();
  w.makeCheckout(D, { files: { 'modes/_profile.md': 'mine\n' } });
  const before = w.snapshot();
  assert.ok(Object.keys(before).includes(`${path.relative(w.T, D)}/modes/_profile.md`), 'files inside the checkout are in the snapshot');
  fs.writeFileSync(path.join(D, 'modes', '_profile.md'), 'changed\n');
  assert.notDeepEqual(w.snapshot(), before);
  fs.writeFileSync(path.join(D, 'modes', '_profile.md'), 'mine\n');
  assert.deepEqual(w.snapshot(), before);
  fs.mkdirSync(path.join(D, 'nested', 'deeper', '.git'), { recursive: true });
  fs.writeFileSync(path.join(D, 'nested', 'deeper', 'new.txt'), 'x');
  assert.ok(Object.keys(w.snapshot()).includes(`${path.relative(w.T, D)}/nested/deeper/new.txt`), 'a checkout inside a checkout is snapshotted too');
});

// ---------------------------------------------------------------- usage and contract

test('--help prints every flag of the contract and the exit codes, exit 0, and touches nothing', () => {
  const { w } = fresh();
  const r = w.run(['--help']);
  assert.equal(r.status, 0);
  for (const flag of ['--yes', '-y', '--non-interactive', '--dir', '--data-root', '--ref', '--no-launchd', '--with-upstream-sync', '--no-start', '--no-h1b-index', '--resume', '--docs', '--replace-cv', '--onboard', '--install-missing', '--core-only', '--dry-run', '--help']) {
    assert.ok(r.stdout.includes(flag), `help mentions ${flag}`);
  }
  assert.ok(r.stdout.includes('--projects'), 'help mentions --projects');
  assert.match(r.stdout, /interactive \| headless \| none/);
  assert.match(r.stdout, /Markdown/);
  assert.match(r.stdout, /0 done, 1 failure, 2 usage error, 3 done with pending actions/);
  assert.equal(w.log().length, 0);
});

test('unknown flags, missing values and bad --onboard modes are usage errors (exit 2) that change nothing', () => {
  for (const args of [['--bogus'], ['--dir'], ['--resume'], ['--docs'], ['--onboard', 'sometimes'], ['--ref'], ['--data-root'], ['--projects']]) {
    const { w, D } = fresh();
    const before = w.snapshot();
    const r = w.run(['--dir', D, ...args]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.out}`);
    assert.match(r.out, /install\.sh --help/);
    assert.deepEqual(w.snapshot(), before);
    assert.equal(w.log().length, 0);
  }
});

test('--docs takes every value up to the next flag', () => {
  const { w, D, args } = fresh();
  const a = md(w, 'a.md', '# A\n');
  const b = md(w, 'b.md', '# B\n');
  const r = w.run(args('--docs', a, b, '--dry-run'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /a\.md/);
  assert.match(r.out, /b\.md/);
});

test('without --dir the installer targets ~/career-ops when the script is not inside a checkout', () => {
  const w = makeWorld();
  const copy = path.join(w.T, 'copy', 'custom', 'install');
  fs.cpSync(INSTALL_DIR, copy, { recursive: true });
  const r = w.run(['--non-interactive', '--dry-run', ...QUIET], { script: path.join(copy, 'install.sh') });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes(path.join(w.home, 'career-ops')), r.out);
});

// ---------------------------------------------------------------- platform and prerequisites

// Requirement change: the installer accepts the Control Center's supported Node versions, 22.22.2+, 24.15+ or 26+ (the
// versions every dependency in its lockfile accepts), where it used to take any Node from 22.6.0.
test('Node 20 fails with exit 1 naming the supported versions, before anything is changed', () => {
  const { w, D, args } = fresh();
  const r = w.run(args(), { env: { FAKE_NODE_VERSION: 'v20.11.0' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /Node 20\.11\.0 is not supported; use 22\.22\.2\+, 24\.15\+ or 26\+/);
  assert.equal(exists(D), false);
  assert.equal(w.calls('git').length, 0);
});

test('a Node the dependencies do not support fails the same way: just below the floor, the old floor, 23, 24 before 24.15, 25', () => {
  for (const version of ['v22.22.1', 'v22.6.0', 'v23.0.0', 'v24.0.0', 'v24.14.0', 'v25.0.0']) {
    const { w, D, args } = fresh();
    const r = w.run(args(), { env: { FAKE_NODE_VERSION: version } });
    assert.equal(r.status, 1, version);
    assert.match(r.out, new RegExp(`Node ${version.slice(1).replace(/\./g, '\\.')} is not supported; use 22\\.22\\.2\\+, 24\\.15\\+ or 26\\+`), version);
    assert.equal(exists(D), false, version);
  }
});

test('Node 22.22.2, 24.15.0, 26.0.0 and 26.4.0 are accepted', () => {
  for (const version of ['v22.22.2', 'v24.15.0', 'v26.0.0', 'v26.4.0']) {
    const { w, args } = fresh();
    const r = w.run(args('--dry-run'), { env: { FAKE_NODE_VERSION: version } });
    assert.equal(r.status, 0, `${version}\n${r.out}`);
  }
});

test('a missing npm is a failure (exit 1) that names npm, found by the prerequisite check before anything is cloned (R11-tests-custom-L3-07)', () => {
  const { w, D, args } = fresh({ tools: ['git', 'node', 'security', 'uname', 'launchctl', 'plutil', 'claude'] });
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.match(r.out, /missing: npm/, r.out);
  assert.equal(exists(D), false, 'no half-installed checkout is left behind');
  assert.deepEqual(w.calls('git'), []);
});

test('Linux without --core-only exits 1 and lists what needs macOS', () => {
  const { w, D, args } = fresh();
  const r = w.run(args(), { env: { FAKE_UNAME: 'Linux' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /macOS/);
  assert.match(r.out, /Keychain/);
  assert.match(r.out, /launchd/);
  assert.match(r.out, /--core-only/);
  assert.equal(exists(D), false);
});

test('Linux with --core-only installs the core and never touches Keychain, launchd or the Control Center', () => {
  const { w, D, args } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', '--core-only', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_UNAME: 'Linux' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(w.calls('git').some((l) => l.startsWith('git clone')));
  assert.equal(w.calls('security').length, 0);
  assert.equal(w.calls('launchctl').length, 0);
  assert.equal(w.calls('launchd-install').length, 0);
  assert.equal(w.calls('cc').length, 0);
  assert.ok(!w.log().some((l) => l.includes('control-center') && l.includes('ci')));
  void args;
});

test('claude missing is a pending action with the official install commands; the installer never runs them', () => {
  // brew and curl are recording stubs, so running either install command shows in the log (R27-tests-custom-L2-02).
  const { w, args } = fresh({ tools: ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'brew', 'curl'], keychain: true });
  const r = w.run(args());
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(r.out, /brew install --cask claude-code/);
  assert.equal(w.calls('claude').length, 0);
  assert.equal(w.calls('brew').length, 0, 'installer ran brew');
  assert.equal(w.calls('curl').length, 0, 'installer ran curl');
});

test('an optional tool that is missing prints a one-line fix and never runs brew without --install-missing, even with a y answer waiting', () => {
  const { w, D } = fresh({ tools: ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'claude', 'brew', 'pdftotext', 'go'], keychain: true });
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\ny\ny\ny\n' });
  assert.match(r.out, /brew install gh/);
  assert.equal(w.calls('brew').length, 0);
});

test('--install-missing asks y/N per tool and runs brew only on a y', () => {
  const { w, D } = fresh({ tools: ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'claude', 'brew', 'pdftotext', 'go'], keychain: true });
  w.run(['--dir', D, '--install-missing', ...QUIET], { tty: 'y\ny\n' });
  assert.deepEqual(w.calls('brew'), ['brew install gh']);
});

test('--install-missing with a no answer, with --yes, or with --non-interactive never runs brew', () => {
  for (const [extra, tty] of [[[], 'y\nn\n'], [['--yes'], 'y\n'], [['--non-interactive'], 'y\n']]) {
    const { w, D } = fresh({ tools: ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'claude', 'brew', 'pdftotext', 'go'], keychain: true });
    const r = w.run(['--dir', D, '--install-missing', ...QUIET, ...extra], { tty });
    assert.equal(w.calls('brew').length, 0, `${extra.join(' ')}: ${r.out}`);
    assert.match(r.out, /brew install gh/);
  }
});

// ---------------------------------------------------------------- dry run

test('--dry-run changes nothing: no clone, no npm, no files, no Keychain write, and says so', () => {
  const { w, D, args } = fresh();
  const resume = md(w, 'resume.md', '# Me\n## Experience\n');
  const docs = md(w, 'p.md', '# P\n');
  const before = w.snapshot();
  const r = w.run(args('--resume', resume, '--docs', docs, '--data-root', path.join(w.T, 'data'), '--dry-run'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dry run/i);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(exists(D), false);
  for (const prefix of ['npm', 'claude', 'plugins', 'h1b-install', 'launchd-install', 'cc']) assert.equal(w.calls(prefix).length, 0, prefix);
  assert.ok(!w.log().some((l) => l.startsWith('git clone') || l.includes('add-generic-password') || l.includes('remote add')));
});

test('--dry-run on an existing checkout also changes nothing', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  const before = w.snapshot();
  const r = w.run(args('--dry-run'));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(w.calls('npm').length, 0);
  assert.ok(!w.log().some((l) => l.includes('pull') || l.includes('remote add')));
});

// ---------------------------------------------------------------- clone, update, deps

test('a fresh install clones the fork, adds the upstream remote and installs deps with npm install --no-package-lock', () => {
  const { w, D, args } = fresh();
  const r = w.run(args());
  assert.equal(r.status, 3, r.out);
  assert.ok(w.log().includes(`git clone ${FORK_URL} ${D}`), w.log().join('\n'));
  assert.ok(w.log().includes(`git -C ${D} remote add upstream https://github.com/career-ops-hq/career-ops.git`));
  assert.ok(w.log().includes(`npm install --no-package-lock (cwd=${D})`));
  assert.ok(w.log().includes(`npm --prefix custom/control-center ci (cwd=${D})`));
  assert.ok(!w.log().some((l) => l.startsWith('npm ci ')));
});

test('a tracked root lockfile makes the root install npm ci', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  fs.writeFileSync(path.join(D, '.git', 'lock-tracked'), '');
  w.run(args());
  assert.ok(w.log().includes(`npm ci (cwd=${D})`), w.log().join('\n'));
  assert.ok(!w.log().some((l) => l.startsWith('npm install ')));
});

test('--ref checks the tag out after the clone', () => {
  const { w, D, args } = fresh();
  w.run(args('--ref', 'fork-install-v2'));
  assert.ok(w.log().includes(`git -C ${D} checkout fork-install-v2`), w.log().join('\n'));
});

test('re-running is idempotent: one clone, one upstream remote, and a fast-forward pull only', () => {
  const { w, D, args } = fresh();
  w.run(args());
  w.run(args());
  assert.equal(w.log().filter((l) => l.startsWith('git clone')).length, 1);
  assert.equal(w.log().filter((l) => l.includes('remote add upstream')).length, 1);
  assert.equal(w.log().filter((l) => l.includes('pull --ff-only')).length, 1);
  void D;
});

test('a dirty tree or a non-main branch is never pulled', () => {
  const states = [
    { file: 'dirty', data: ' M cv.md\n', says: /^ {2}Not pulling: the working tree has local changes\.$/m },
    { file: 'branch', data: 'feature/x\n', says: /^ {2}Not pulling: on branch feature\/x, not main\.$/m },
  ];
  for (const state of states) {
    const { w, D, args } = fresh();
    w.makeCheckout(D);
    fs.writeFileSync(path.join(D, '.git', state.file), state.data);
    const r = w.run(args());
    assert.ok(!w.log().some((l) => l.includes('pull')), `${state.file}: ${w.log().join('\n')}`);
    assert.match(r.out, state.says);
  }
});

// The daily job's lock under the default data root (the checkout), as run-daily.sh takes it, and a probe the stubs run.
const dailyLock = (D) => path.join(D, 'data', 'immigration', '.run-daily.lockf');
const probeEnv = (D) => ({ FAKE_LOCK_PROBE: path.join(INSTALL_DIR, 'tests', 'stubs', 'lock-probe'), FAKE_LOCK_PROBE_FILE: dailyLock(D) });
/** A running daily job: holds the lock (in its own process group) once `startAfter` exists, then touches `ready`. */
function holdDailyLock(w, D, { startAfter = null } = {}) {
  const ready = path.join(w.T, 'holder-ready');
  const hold = `/usr/bin/lockf -k -t 0 "${dailyLock(D)}" /bin/sh -c 'touch "${ready}"; sleep 60'`;
  const wait = startAfter ? `while [ ! -f "${startAfter}" ]; do sleep 0.05; done; ` : '';
  const holder = spawn('/bin/sh', ['-c', `${wait}${hold}`], { stdio: 'ignore', detached: true });
  const waitReady = () => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
    assert.ok(fs.existsSync(ready), 'the holder never took the lock');
  };
  const stop = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ } };
  return { ready, waitReady, stop };
}

test('a re-run while the daily job holds its lock waits briefly, then stops before pulling or installing anything (R18-scripts-b-L1-01)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
  const job = holdDailyLock(w, D);
  try {
    job.waitReady();
    const r = w.run(args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '1' } });
    assert.equal(r.status, 1, r.out);
    assert.ok(!w.log().some((l) => l.includes('pull') || l.startsWith('npm ')), w.log().join('\n'));
    assert.match(r.out, /error: the daily job is running right now \(it holds .*\.run-daily\.lockf\), so the checkout and its dependencies were left as they are\. Re-run this script once it finishes\./);
  } finally {
    job.stop();
  }
});

test('a re-run holds the daily job\'s lock, naming itself in .live-update.pid, through the pull, the installs and the launchd reinstall, and lets it go after (R18-scripts-b-L1-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { ...READY_FILES, 'data/immigration/logs/.keep': '' } });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], { env: probeEnv(D) });
  assert.equal(r.status, 0, r.out);
  const probes = w.log().filter((l) => l.startsWith('lock-probe'));
  assert.deepEqual(probes, [
    'lock-probe held named: git pull',
    'lock-probe held named: npm install --no-package-lock',
    'lock-probe held named: npm --prefix custom/control-center ci',
    'lock-probe held named: launchd-install',
    'lock-probe free unnamed: npm --prefix custom/control-center run preflight',
  ], w.log().join('\n'));
  assert.equal(spawnSync('/usr/bin/lockf', ['-k', '-t', '0', dailyLock(D), '/usr/bin/true']).status, 0, 'the lock was not released');
  assert.ok(!exists(D, 'data', 'immigration', '.live-update.pid'));
});

test('a daily job that starts after the dependency step and outlasts the wait leaves the launchd job as it was, with a pending action (R18-scripts-b-L1-01)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { ...READY_FILES, 'data/immigration/logs/.keep': '' } });
  const signal = path.join(w.T, 'deps-done');
  const job = holdDailyLock(w, D, { startAfter: signal });
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], {
      env: { CAREER_OPS_INSTALL_DAILY_WAIT: '1', FAKE_DOCTOR_SIGNAL: signal, FAKE_DOCTOR_WAIT_FOR: job.ready },
    });
    assert.equal(r.status, 3, r.out);
    assert.deepEqual(w.calls('launchd-install'), [], r.out);
    assert.ok(w.log().some((l) => l.includes('pull --ff-only')), w.log().join('\n'));
    assert.match(r.out, /The daily job is running right now, so it was left as it was\. Once it finishes, run: bash '.*custom\/launchd\/install\.sh' --jobs daily$/m);
  } finally {
    job.stop();
  }
});

test('--core-only on macOS still waits for the daily job an earlier full install scheduled, and stops before pulling (R18-scripts-b-L1-01 review)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
  const job = holdDailyLock(w, D);
  try {
    job.waitReady();
    const r = w.run(args('--core-only'), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '1' } });
    assert.equal(r.status, 1, r.out);
    assert.ok(!w.log().some((l) => l.includes('pull') || l.startsWith('npm ')), w.log().join('\n'));
    assert.match(r.out, /error: the daily job is running right now/);
  } finally {
    job.stop();
  }
});

test('a re-run also waits on the lock of the data root the installed daily job runs on, when this run resolves another (R18-scripts-b-L1-01 review)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  // An earlier install with CAREER_OPS_ROOT exported baked that root into the job; this shell does not set it.
  const jobRoot = path.join(w.T, 'job-data');
  fs.mkdirSync(path.join(jobRoot, 'data', 'immigration', 'logs'), { recursive: true });
  const agents = path.join(w.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.career-ops.immigration-watch.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.career-ops.immigration-watch</string>
  <key>WorkingDirectory</key><string>${D}</string>
  <key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${jobRoot}</string></dict>
  <key>StandardOutPath</key><string>${jobRoot}/data/immigration/logs/launchd.out.log</string>
</dict>
</plist>
`);
  const job = holdDailyLock(w, jobRoot);
  try {
    job.waitReady();
    const r = w.run(args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '1' } });
    assert.equal(r.status, 1, r.out);
    assert.ok(!w.log().some((l) => l.includes('pull') || l.startsWith('npm ')), w.log().join('\n'));
    assert.ok(r.out.includes(`error: the daily job is running right now (it holds ${dailyLock(jobRoot)})`), r.out);
  } finally {
    job.stop();
  }
});

test('a daily job another checkout installed, running on its own data root, neither holds up this checkout\'s pull and installs nor gets its lock taken (R21-scripts-b-L1-01)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  const other = path.join(w.T, 'other-checkout');
  fs.mkdirSync(other);
  const jobRoot = path.join(w.T, 'job-data');
  fs.mkdirSync(path.join(jobRoot, 'data', 'immigration', 'logs'), { recursive: true });
  const agents = path.join(w.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.career-ops.immigration-watch.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.career-ops.immigration-watch</string>
  <key>WorkingDirectory</key><string>${other}</string>
  <key>StandardOutPath</key><string>${jobRoot}/data/immigration/logs/launchd.out.log</string>
</dict>
</plist>
`);
  const job = holdDailyLock(w, jobRoot);
  try {
    job.waitReady();
    const r = w.run(args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '1' } });
    assert.doesNotMatch(r.out, /the daily job is running right now/, r.out);
    assert.ok(w.log().some((l) => l.includes('pull --ff-only')), w.log().join('\n'));
    assert.ok(!fs.existsSync(path.join(jobRoot, 'data', 'immigration', '.live-update.pid')), 'the installer named itself in another checkout\'s lock folder');
  } finally {
    job.stop();
  }
});

test('a daily lock the installer cannot open stops it before the checkout step, showing lockf\'s own error (R18-scripts-b-L1-01 review)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'data/immigration/.run-daily.lockf': '' } });
  fs.chmodSync(dailyLock(D), 0o000);
  try {
    const r = w.run(args());
    assert.equal(r.status, 1, r.out);
    assert.ok(!w.log().some((l) => l.includes('pull') || l.startsWith('npm ')), w.log().join('\n'));
    assert.match(r.out, /lockf: cannot open .*\.run-daily\.lockf: Permission denied\n(.*\n)*error: could not take the daily job's lock .*\.run-daily\.lockf \(see the lockf error above\)/);
  } finally {
    fs.chmodSync(dailyLock(D), 0o644);
  }
});

test('a daily lock that cannot be opened at the launchd step leaves the job as it was and says why, not that the launchd install failed (R18-scripts-b-L1-01 review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { ...READY_FILES, 'data/immigration/logs/.keep': '' } });
  const signal = path.join(w.T, 'deps-done');
  const ready = path.join(w.T, 'locked-out');
  const blocker = spawn('/bin/sh', ['-c', `while [ ! -f "${signal}" ]; do sleep 0.05; done; chmod 000 "${dailyLock(D)}"; touch "${ready}"`], { stdio: 'ignore', detached: true });
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], {
      env: { FAKE_DOCTOR_SIGNAL: signal, FAKE_DOCTOR_WAIT_FOR: ready },
    });
    assert.equal(r.status, 3, r.out);
    assert.deepEqual(w.calls('launchd-install'), [], r.out);
    assert.match(r.out, /lockf: cannot open .*\.run-daily\.lockf: Permission denied/);
    assert.match(r.out, /Could not take the daily job's lock .*\.run-daily\.lockf \(see the lockf error above\), so the launchd job was left as it was\. Fix that, then run: bash '.*custom\/launchd\/install\.sh' --jobs daily$/m);
    assert.doesNotMatch(r.out, /The launchd install failed/);
  } finally {
    try { process.kill(-blocker.pid, 'SIGKILL'); } catch { /* already gone */ }
    if (fs.existsSync(dailyLock(D))) fs.chmodSync(dailyLock(D), 0o644);
  }
});

test('an origin that is not the fork is refused with exit 1', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { origin: 'https://github.com/career-ops-hq/career-ops.git' });
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.match(r.out, /origin/);
  assert.equal(w.calls('npm').length, 0);
});

test('an origin URL carrying credentials is shown and logged without them (R31-scripts-b-L2-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  w.makeCheckout(D, { origin: 'https://x-access-token:ghp_SECRETVALUE@github.com/Divy2000/career-ops.git' });
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', ...QUIET]);
  assert.match(r.out, /using the existing checkout \(origin https:\/\/github\.com\/Divy2000\/career-ops\.git\)/, r.out);
  assert.ok(!r.out.includes('ghp_SECRETVALUE'), r.out);
  assert.ok(installLogs(data).length > 0);
  for (const log of installLogs(data)) assert.ok(!fs.readFileSync(log, 'utf8').includes('ghp_SECRETVALUE'));
});

test('a refused origin carrying credentials is named without them (R31-scripts-b-L2-01)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { origin: 'https://user:ghp_SECRETVALUE@github.com/career-ops-hq/career-ops.git' });
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.match(r.out, /origin of .* is https:\/\/github\.com\/career-ops-hq\/career-ops\.git, not the fork/, r.out);
  assert.ok(!r.out.includes('ghp_SECRETVALUE'), r.out);
});

test('a CAREER_OPS_REPO_URL carrying credentials is cloned as given but shown without them (R31-scripts-b-L2-01)', () => {
  const { w, args } = fresh();
  const url = 'https://user:ghp_SECRETVALUE@github.com/Divy2000/career-ops.git';
  const r = w.run(args('--dry-run'), { env: { CAREER_OPS_REPO_URL: url } });
  assert.match(r.out, /git clone https:\/\/github\.com\/Divy2000\/career-ops\.git /, r.out);
  assert.ok(!r.out.includes('ghp_SECRETVALUE'), r.out);
});

test('a non-empty directory that is not a git checkout is refused with exit 1', () => {
  const { w, D, args } = fresh();
  fs.mkdirSync(D);
  fs.writeFileSync(path.join(D, 'precious.txt'), 'keep');
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.equal(read(D, 'precious.txt'), 'keep');
});

// ---------------------------------------------------------------- user layer

test('existing user files keep their bytes and profile.yml and portals.yml are never created from examples', () => {
  const { w, D, args } = fresh();
  const mine = { 'cv.md': 'SENTINEL cv\n', 'modes/_profile.md': 'SENTINEL profile\n', 'modes/_custom.md': 'SENTINEL custom\n', 'article-digest.md': 'SENTINEL digest\n' };
  w.makeCheckout(D, { files: mine });
  w.run(args());
  for (const [rel, data] of Object.entries(mine)) assert.equal(read(D, rel), data, rel);
  assert.equal(exists(D, 'config', 'profile.yml'), false);
  assert.equal(exists(D, 'portals.yml'), false);
});

test('a fresh install seeds modes/_custom.md from the template and declares custom/ exactly once across re-runs', () => {
  const { w, D, args } = fresh();
  w.run(args());
  w.run(args());
  assert.equal(read(D, 'modes', '_custom.md'), seededCustom());
  assert.equal(read(D, 'config', 'local-paths.txt').split('\n').filter((l) => l === 'custom/').length, 1);
  assert.ok(w.log().some((l) => l === 'doctor --json --init-templates'));
});

test('local-paths.txt keeps the user\'s own lines', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'config/local-paths.txt': 'my-runner.sh\n' } });
  w.run(args());
  assert.equal(read(D, 'config', 'local-paths.txt'), 'my-runner.sh\ncustom/\n');
});

test('a local-paths.txt the installer cannot write is a failure naming it, not a claim that custom/ is declared (R19-scripts-b-L1-01)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'config/local-paths.txt': 'my-runner.sh\n' } });
  const file = path.join(D, 'config', 'local-paths.txt');
  fs.chmodSync(file, 0o444);
  try {
    const r = w.run(args());
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /local-paths\.txt/);
    assert.doesNotMatch(r.out, /already declares custom\//);
    assert.equal(read(D, 'config', 'local-paths.txt'), 'my-runner.sh\n');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('a modes/_custom.md the installer cannot create is a failure, not a claim that it already exists (R19-scripts-b-L1-01)', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'modes/_profile.md': 'mine\n' } });
  const modes = path.join(D, 'modes');
  fs.chmodSync(modes, 0o555);
  try {
    const r = w.run(args());
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /_custom\.md/);
    assert.doesNotMatch(r.out, /already exists; left as is/);
    assert.equal(exists(D, 'modes', '_custom.md'), false);
  } finally {
    fs.chmodSync(modes, 0o755);
  }
});

test('a projects-library house rule the installer cannot add is a pending action, not silently skipped (R19-scripts-b-L1-01)', () => {
  const { w, D, args } = fresh();
  const script = standalone(w);
  fs.rmSync(path.join(path.dirname(script), 'templates', '_custom-projects.md'));
  const r = w.run(args(), { script });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Done, with pending actions:[\s\S]*projects-library house rule/);
  assert.equal(read(D, 'modes', '_custom.md'), read(INSTALL_DIR, 'templates', '_custom.md'));
});

test('--data-root writes the marker, keeps personal files there and seeds _custom.md in it', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n');
  w.run(args('--data-root', data, '--resume', resume));
  assert.equal(read(D, '.career-ops-data').trim(), data);
  assert.equal(exists(data, 'modes', '_custom.md'), true);
  assert.equal(exists(D, 'modes', '_custom.md'), false);
  assert.equal(read(data, 'cv.md'), '# Me\n');
  assert.equal(exists(D, 'cv.md'), false);
});

test('without --data-root no marker is written', () => {
  const { w, D, args } = fresh();
  w.run(args());
  assert.equal(exists(D, '.career-ops-data'), false);
});

test('a marker that points elsewhere than --data-root is refused, not overwritten', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { '.career-ops-data': '/somewhere/else\n' } });
  const r = w.run(args('--data-root', path.join(w.T, 'mydata')));
  assert.equal(r.status, 1);
  assert.equal(read(D, '.career-ops-data'), '/somewhere/else\n');
});

test('a log is written under the data root and holds script and npm output but no secret', () => {
  const { w, D, args } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  w.run(args('--data-root', data));
  const logs = installLogs(data);
  assert.equal(logs.length, 1);
  const text = fs.readFileSync(logs[0], 'utf8');
  assert.match(text, /npm stub/);
  assert.match(text, new RegExp(D.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!text.includes(SECRET));
});

// ---------------------------------------------------------------- resume and docs

const BAD_INPUTS = {
  'a .pdf resume': (w) => ({ resume: md(w, 'r.pdf', '%PDF-1.4\n') }),
  'a .docx resume': (w) => ({ resume: md(w, 'r.docx', 'PK') }),
  'a directory': (w) => ({ resume: path.dirname(md(w, 'x.md', '# x\n')) }),
  'a missing file': (w) => ({ resume: path.join(w.T, 'nope.md') }),
  'invalid UTF-8': (w) => ({ resume: md(w, 'r.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])) }),
  'an empty file': (w) => ({ resume: md(w, 'r.md', '') }),
  'a resume over 1 MiB': (w) => ({ resume: md(w, 'r.md', `# h\n${'a'.repeat(1024 * 1024 + 5)}`) }),
  'a pdf among the docs': (w) => ({ resume: md(w, 'r.md', '# ok\n'), docs: [md(w, 'a.md', '# a\n'), md(w, 'b.pdf', '%PDF')] }),
};
for (const [label, make] of Object.entries(BAD_INPUTS)) {
  for (const dry of [false, true]) {
    test(`rejecting ${label}${dry ? ' under --dry-run' : ''}: exit 2, names the file and leaves the whole tree untouched`, () => {
      const { w, D, args } = fresh();
      const { resume, docs } = make(w);
      const before = w.snapshot();
      const argv = args(...(resume ? ['--resume', resume] : []), ...(docs ? ['--docs', ...docs] : []), ...(dry ? ['--dry-run'] : []));
      const r = w.run(argv);
      assert.equal(r.status, 2, r.out);
      assert.ok(r.out.includes(path.basename(docs ? docs[1] : resume)), r.out);
      assert.deepEqual(w.snapshot(), before);
      assert.equal(exists(D), false);
      assert.equal(w.calls('git').length, 0);
      assert.equal(w.calls('npm').length, 0);
    });
  }
}

test('a non-Markdown resume is pointed at option 1, the Claude Code prompt', () => {
  const { w, args } = fresh();
  const r = w.run(args('--resume', md(w, 'resume.pdf', '%PDF')));
  assert.match(r.out, /option 1 \(Claude Code prompt\)/);
  assert.match(r.out, /PDF, DOCX and other formats/);
});

test('the resume is copied to documents/cv, cv.md is seeded normalized, and the user is told', () => {
  const { w, D, args } = fresh();
  const resume = md(w, 'resume.md', '﻿# Jane Doe\r\n## Experience\r\nBuilt things\r\n\r\n\r\n');
  const r = w.run(args('--resume', resume));
  assert.equal(read(D, 'documents', 'cv', 'resume.md'), '﻿# Jane Doe\r\n## Experience\r\nBuilt things\r\n\r\n\r\n');
  assert.equal(read(D, 'cv.md'), '# Jane Doe\n## Experience\nBuilt things\n');
  assert.match(r.out, /seeded cv\.md/i);
});

test('an existing cv.md that differs is never replaced non-interactively: exit 3 naming --replace-cv', () => {
  const { w, D, args } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { ...READY_FILES, 'cv.md': 'OLD\n' } });
  const resume = md(w, 'resume.md', '# New\n');
  const r = w.run(args('--resume', resume));
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /--replace-cv/);
  assert.equal(read(D, 'cv.md'), 'OLD\n');
  assert.deepEqual(fs.readdirSync(D).filter((n) => n.startsWith('cv.md.bak')), []);
});

test('a differing cv.md that is kept is not called a copy of the resume in the onboarding prompt (R31-scripts-b-L2-03)', () => {
  const { w, D, args } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { ...READY_FILES, 'cv.md': 'OLD\n' } });
  const resume = md(w, 'resume.md', '# New\n');
  const r = w.run(args('--resume', resume, '--onboard', 'none'));
  const copy = path.join(D, 'documents', 'cv', 'resume.md');
  assert.match(r.out, /cv\.md left as is/);
  assert.ok(!r.out.includes(`cv.md (from ${copy})`), r.out);
  assert.ok(r.out.includes(`${copy} (differs from cv.md; not applied)`), r.out);
});

test('--replace-cv backs the old cv.md up byte for byte, then writes the new one', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  fs.writeFileSync(path.join(D, 'cv.md'), 'OLD\r\nbytes\n');
  const resume = md(w, 'resume.md', '# New\n');
  w.run(args('--resume', resume, '--replace-cv'));
  const backups = fs.readdirSync(D).filter((n) => n.startsWith('cv.md.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(read(D, backups[0]), 'OLD\r\nbytes\n');
  assert.equal(read(D, 'cv.md'), '# New\n');
});

test('an identical cv.md (after normalization) is left alone with no backup, even with --replace-cv', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  fs.writeFileSync(path.join(D, 'cv.md'), '# Same\n');
  w.run(args('--resume', md(w, 'resume.md', '# Same\r\n'), '--replace-cv'));
  assert.deepEqual(fs.readdirSync(D).filter((n) => n.startsWith('cv.md.bak')), []);
  assert.equal(read(D, 'cv.md'), '# Same\n');
});

test('on a terminal a differing cv.md shows a summary and asks; n keeps it, y backs up and replaces', () => {
  for (const [answer, replaced] of [['n', false], ['y', true]]) {
    const { w, D } = fresh({ keychain: true });
    w.makeCheckout(D);
    fs.writeFileSync(path.join(D, 'cv.md'), 'OLD line\n');
    const resume = md(w, 'resume.md', '# New\n');
    const r = w.run(['--dir', D, ...QUIET, '--resume', resume], { tty: `y\n${answer}\n` });
    assert.match(r.out, /Replace cv\.md\? \[y\/N\]/);
    assert.ok(r.out.includes('Summary: 1 line(s) added, 1 line(s) removed if replaced.'), r.out);
    assert.equal(read(D, 'cv.md'), replaced ? '# New\n' : 'OLD line\n', r.out);
    assert.equal(fs.readdirSync(D).filter((n) => n.startsWith('cv.md.bak-')).length, replaced ? 1 : 0);
  }
});

test('under a real pseudo-terminal the same questions work through /dev/tty (python pty)', { skip: WORLD_PTY_SKIP }, () => {
  for (const [answer, replaced] of [['n', false], ['y', true]]) {
    const { w, D } = fresh({ keychain: true });
    w.makeCheckout(D);
    fs.writeFileSync(path.join(D, 'cv.md'), 'OLD line\n');
    const resume = md(w, 'resume.md', '# New\n');
    const r = w.runInPty(['--dir', D, ...QUIET, '--resume', resume], { steps: [{ expect: 'Proceed\\?', send: 'y\n' }, { expect: 'Replace cv\\.md\\?', send: `${answer}\n` }] });
    assert.match(r.out, /Replace cv\.md\?/);
    assert.equal(read(D, 'cv.md'), replaced ? '# New\n' : 'OLD line\n', r.out);
    // Keeping the old cv.md leaves "replace it" as a pending action (exit 3); replacing it leaves nothing pending.
    assert.equal(r.status, replaced ? 0 : 3, r.out);
  }
});

test('an installer that hangs under the pty ends with pty_run\'s own timeout and the transcript, not a silent kill (R11-tests-custom-L1-06)', { skip: WORLD_PTY_SKIP }, () => {
  const { w } = fresh();
  // A python3 that takes 3 s to start, as on a loaded machine: pty_run's deadline counts from its own start, so the
  // outcome must not depend on how long the interpreter took to get there.
  fs.writeFileSync(path.join(w.bin, 'python3'), '#!/bin/bash\nsleep 3\nPATH="${PATH#*:}" exec python3 "$@"\n', { mode: 0o755 });
  const hang = w.write('hang.sh', 'echo "waiting for an answer that never comes"\nexec sleep 60\n');
  // pty_run's deadline is 1 s and the spawnSync backstop keeps runInPty's default, so the deadline under test fires
  // first by a margin no machine load closes; a backstop only 2 s behind it killed pty_run first under load.
  const r = w.runInPty([], { steps: [], script: hang, env: { PTY_RUN_TIMEOUT: '1' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /waiting for an answer that never comes/);
  assert.match(r.out, /pty_run: timed out after [0-9.]+ s; killed the command/);
});

test('docs go to documents/projects, a different file of the same name gets a -1 suffix, and article-digest.md is never written', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'documents/projects/proj.md': 'EXISTING\n' } });
  const doc = md(w, 'proj.md', '# New project\n');
  w.run(args('--docs', doc));
  assert.equal(read(D, 'documents', 'projects', 'proj.md'), 'EXISTING\n');
  assert.equal(read(D, 'documents', 'projects', 'proj-1.md'), '# New project\n');
  assert.equal(exists(D, 'article-digest.md'), false);
  w.run(args('--docs', doc));
  assert.deepEqual(fs.readdirSync(path.join(D, 'documents', 'projects')).sort(), ['proj-1.md', 'proj.md']);
});

// ---------------------------------------------------------------- projects library (--projects)

const LIBRARY = '# Projects library\n\n## Kite Tracker -- https://example.org/kites\nTags: python\n- Tracked 40 kites.\n';

test('--projects with a library .md and no article-digest.md creates it and keeps a copy in documents/projects', () => {
  const { w, D, args } = fresh();
  const lib = md(w, 'projects.md', LIBRARY);
  const r = w.run(args('--projects', lib));
  assert.equal(read(D, 'article-digest.md'), LIBRARY, r.out);
  assert.equal(read(D, 'documents', 'projects', 'projects.md'), LIBRARY);
  assert.match(r.out, /created article-digest\.md/);
});

test('--projects with a projects JSON converts it into the library format, keeps the conversion as the source and names it in each entry', () => {
  const { w, D, args } = fresh();
  const json = md(w, 'projects.json', JSON.stringify([{ id: 'k', name: 'Kite Tracker', url: 'https://example.org/kites', description: 'Tracked 40 kites.', highlights: [], keywords: ['python'] }]));
  w.run(args('--projects', json));
  assert.equal(read(D, 'article-digest.md'), LIBRARY.replace('Tags: python\n', 'Tags: python\nSource: documents/projects/projects.md\n'));
  assert.equal(read(D, 'documents', 'projects', 'projects.md'), LIBRARY);
  assert.equal(exists(D, 'documents', 'projects', 'projects.json'), false, 'intake cannot read JSON, so the JSON itself is not kept there');
});

test('an invalid --projects library exits 2 and changes nothing', () => {
  const { w, D, args } = fresh();
  const bad = md(w, 'bad.md', '## Empty\nTags: go\n');
  const before = w.snapshot();
  const r = w.run(args('--projects', bad));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /"Empty".*no copy-paste points/);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(exists(D), false);
  assert.equal(w.calls('git').length, 0);
});

test('an existing article-digest.md is never overwritten by --projects; a pending action says how to merge', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'article-digest.md': 'MINE\n' } });
  const lib = md(w, 'projects.md', LIBRARY);
  const r = w.run(args('--projects', lib));
  assert.equal(read(D, 'article-digest.md'), 'MINE\n');
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /custom\/projects\/import\.mjs .*--merge --write/);
});

test('--dry-run with --projects says what it would do and writes nothing', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  const lib = md(w, 'projects.md', LIBRARY);
  const r = w.run(args('--projects', lib, '--dry-run'));
  assert.match(r.out, /create article-digest\.md from/);
  assert.equal(exists(D, 'article-digest.md'), false);
});


test('the custom/install copies leave out only its tests/ folder, also from a checkout under a tests folder (R11-tests-custom-L1-04)', () => {
  const root = path.join(path.sep, 'Users', 'me', 'tests', 'career-ops', 'custom', 'install');
  const keep = withoutTests(root);
  for (const rel of ['', 'install.sh', 'lib.mjs', path.join('templates', '_custom.md'), 'tests-notes.md']) assert.equal(keep(path.join(root, rel)), true, rel || '(the root)');
  for (const rel of ['tests', path.join('tests', 'harness.mjs'), path.join('tests', 'stubs', 'git')]) assert.equal(keep(path.join(root, rel)), false, rel);
});

// A copy of custom/install outside any checkout (downloaded on its own): the projects parser is not next to it.
function standalone(w, { parser = true } = {}) {
  const dl = path.join(w.T, 'dl', 'custom', 'install');
  fs.cpSync(INSTALL_DIR, dl, { recursive: true, filter: withoutTests(INSTALL_DIR) });
  if (parser) {
    const repo = path.resolve(INSTALL_DIR, '..', '..');
    for (const rel of ['custom/projects/lib.mjs', 'tracker-parse.mjs', 'tracker-aliases.json', 'skill-extract.mjs']) {
      fs.mkdirSync(path.dirname(path.join(w.fakeSrc, rel)), { recursive: true });
      fs.copyFileSync(path.join(repo, rel), path.join(w.fakeSrc, rel));
    }
  }
  return path.join(dl, 'install.sh');
}
const cloneTargets = (w) => w.calls('git').filter((l) => l.startsWith('git clone')).map((l) => l.split(' ').at(-1));

test('--projects gets the same byte checks as --docs before anything changes, also in standalone mode', () => {
  for (const mode of ['checkout', 'standalone']) {
    const { w, D, args } = fresh();
    const script = mode === 'standalone' ? standalone(w) : INSTALL_SH;
    const bad = w.write('src/bad.md', Buffer.from('## A\n- \xff\n', 'latin1'));
    const before = w.snapshot();
    const r = w.run(args('--projects', bad), { script });
    assert.equal(r.status, 2, `${mode}: ${r.out}`);
    assert.match(r.out, /bad\.md: not valid UTF-8/, mode);
    assert.deepEqual(w.snapshot(), before, mode);
    assert.equal(exists(D), false, mode);
    assert.equal(w.calls('git').length, 0, mode);
  }
});

test('standalone: an invalid --projects file is refused before the checkout or the user layer exists', () => {
  const { w, D, args } = fresh();
  const script = standalone(w);
  const bad = md(w, 'bad.md', '## Empty\nTags: go\n');
  const r = w.run(args('--projects', bad), { script });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /"Empty".*no copy-paste points/);
  assert.match(r.out, /No changes were made to the checkout or the user layer/);
  assert.doesNotMatch(r.out, /unexpected failure/);
  assert.equal(exists(D), false);
  // Only the throwaway validator clone ran, and it is gone.
  const targets = cloneTargets(w);
  assert.equal(targets.length, 1, w.calls('git').join('\n'));
  assert.notEqual(targets[0], D);
  assert.equal(fs.existsSync(targets[0]), false);
});

test('standalone: a valid --projects file is checked first, then seeds article-digest.md after the checkout', () => {
  const { w, D, args } = fresh();
  const script = standalone(w);
  const lib = md(w, 'projects.md', LIBRARY);
  const r = w.run(args('--projects', lib), { script });
  assert.equal(read(D, 'article-digest.md'), LIBRARY, r.out);
  const targets = cloneTargets(w);
  assert.deepEqual(targets.slice(-1), [D]);
  assert.equal(targets.length, 2);
  assert.equal(fs.existsSync(targets[0]), false);
});

test('standalone: when the validator cannot be fetched, the install stops before any change and says so', () => {
  const { w, D, args } = fresh();
  const script = standalone(w, { parser: false });
  const r = w.run(args('--projects', md(w, 'projects.md', LIBRARY)), { script });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not fetch the projects validator/);
  assert.match(r.out, /No changes were made to the checkout or the user layer/);
  assert.equal(exists(D), false);
});

// ---------------------------------------------------------------- self-tests

const SELFTEST_SPEC = `import { test } from 'node:test';
import fs from 'node:fs';
test('records the self-test marker', () => fs.appendFileSync(process.env.STUB_LOG, 'selftest CAREER_OPS_IN_SELFTEST=' + (process.env.CAREER_OPS_IN_SELFTEST ?? '') + '\\n'));
`;

test('the health check runs the checkout\'s custom specs with CAREER_OPS_IN_SELFTEST=1', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'custom/demo/tests/a.spec.mjs': SELFTEST_SPEC } });
  w.run(args());
  assert.deepEqual(w.calls('selftest'), ['selftest CAREER_OPS_IN_SELFTEST=1']);
});

test('inside a self-test run the installer does not start the custom specs again', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'custom/demo/tests/a.spec.mjs': SELFTEST_SPEC } });
  const r = w.run(args(), { env: { CAREER_OPS_IN_SELFTEST: '1' } });
  assert.deepEqual(w.calls('selftest'), []);
  assert.match(r.out, /already inside a self-test run; skipping the self-tests/);
});

test('worlds keep the caller\'s TMPDIR, so nested temp files land where the test run put them', () => {
  const { w } = fresh();
  assert.equal(w.env().TMPDIR, process.env.TMPDIR);
});


// ---------------------------------------------------------------- interrupted runs (R31-scripts-b-L1-01)

/**
 * Starts the installer with its own TMPDIR, presses Ctrl-C (SIGINT to its process group, as a terminal does) once
 * `ready()` holds, and returns how it ended plus what it left in that TMPDIR.
 */
async function interruptedRun(w, args, { env = {}, script = INSTALL_SH, ready }) {
  const tmp = path.join(w.T, 'run-tmp');
  fs.mkdirSync(tmp);
  let out = '';
  const child = spawn('bash', [script, ...args], { env: { ...w.env(), ...env, TMPDIR: tmp }, cwd: w.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 60_000;
  while (!ready(out) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(child.exitCode, null, `the installer ended before the interruption point:\n${out}`);
  assert.ok(ready(out), `the installer never reached the interruption point:\n${out}`);
  process.kill(-child.pid, 'SIGINT');
  const end = await ended;
  return { end, out, leftovers: fs.readdirSync(tmp) };
}

test('Ctrl-C while the installer waits for the daily job\'s lock leaves no lock files in TMPDIR (R31-scripts-b-L1-01)', async () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
  const job = holdDailyLock(w, D);
  try {
    job.waitReady();
    const r = await interruptedRun(w, args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '60' }, ready: (out) => /The daily job is running; waiting up to 60s/.test(out) });
    assert.deepEqual(r.leftovers, [], r.out);
    assert.equal(r.end.code, 130, `${JSON.stringify(r.end)}\n${r.out}`);
  } finally {
    job.stop();
  }
});

test('Ctrl-C while the installer waits for the daily job\'s lock stops the wait: once the job ends, nothing takes the lock for the gone installer or re-creates its temp file (R32-scripts-b-L1-02)', async () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { 'data/immigration/logs/.keep': '' } });
  const job = holdDailyLock(w, D);
  let r;
  try {
    job.waitReady();
    r = await interruptedRun(w, args(), { env: { CAREER_OPS_INSTALL_DAILY_WAIT: '60' }, ready: (out) => /The daily job is running; waiting up to 60s/.test(out) });
    assert.equal(r.end.code, 130, `${JSON.stringify(r.end)}\n${r.out}`);
  } finally {
    job.stop();
  }
  const pidFile = path.join(D, 'data', 'immigration', '.live-update.pid');
  // A waiter still queued on the lock takes it within lockf's retry interval once the job is gone.
  const deadline = Date.now() + 3_000;
  let sawPid = false;
  while (Date.now() < deadline) {
    sawPid ||= fs.existsSync(pidFile);
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.deepEqual(fs.readdirSync(path.join(w.T, 'run-tmp')), [], r.out);
  assert.equal(sawPid, false, 'the lock was taken and .live-update.pid written for an installer that had exited');
  const probe = spawnSync('/usr/bin/lockf', ['-k', '-t', '0', dailyLock(D), '/usr/bin/true']);
  assert.equal(probe.status, 0, 'the daily lock is free');
});

test('Ctrl-C during the Keychain check leaves no Keychain error file in TMPDIR (R31-scripts-b-L1-01)', async () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = await interruptedRun(w, ['--dir', D, '--non-interactive', '--no-h1b-index', '--onboard', 'none'], {
    env: { FAKE_SECURITY_HANG: '60', CC_KEYCHAIN_TIMEOUT: '60' },
    ready: () => w.calls('security').some((l) => l.startsWith('security find-generic-password')),
  });
  assert.deepEqual(r.leftovers, [], r.out);
  assert.equal(r.end.code, 130, `${JSON.stringify(r.end)}\n${r.out}`);
});

test('Ctrl-C during the projects validator clone leaves no scratch clone in TMPDIR (R31-scripts-b-L1-01)', async () => {
  const { w, args } = fresh();
  const script = standalone(w);
  const r = await interruptedRun(w, args('--projects', md(w, 'projects.md', LIBRARY)), {
    script,
    env: { FAKE_GIT_CLONE_HANG: '60' },
    ready: () => w.log().includes('git-clone-hang'),
  });
  assert.deepEqual(r.leftovers, [], r.out);
  assert.equal(r.end.code, 130, `${JSON.stringify(r.end)}\n${r.out}`);
});
