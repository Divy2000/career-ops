// install.sh specs: pending actions, data-root resolution, failures and the pty runner. Split from install.spec.mjs so the files run in parallel (shared setup in install-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caseFlippedHome } from '../../test-support/case-home.mjs';
import { makeWorld, installLogs, INSTALL_SH, INSTALL_DIR, linkSystemCommands, pythonPtyMissing, PTY_PROBE_OK } from './harness.mjs';
import { SECRET, QUIET, PTY_SKIP, fresh, READY_FILES, read, exists, md, seededCustom, withoutTests } from './install-fixtures.mjs';

// ---------------------------------------------------------------- launchd, health, start (continued)

test('a failing doctor is reported as a pending action, not hidden', () => {
  const { w, D, args } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(args(), { env: { FAKE_DOCTOR_EXIT: '1' } });
  assert.equal(r.status, 3);
  assert.match(r.out, /doctor/);
});

test('a failing npm install is a failure (exit 1) that points at the log', () => {
  const { w, D, args } = fresh();
  const r = w.run(args('--data-root', path.join(w.T, 'mydata')), { env: { FAKE_NPM_EXIT: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /install-.*\.log/);
  void D;
});

test('--resume and --docs are resolved against the caller\'s working directory', () => {
  const { w, D, args } = fresh();
  w.write('cwd/resume.md', '# Me\n');
  w.write('cwd/proj.md', '# P\n');
  const r = w.run(args('--resume', 'resume.md', '--docs', 'proj.md'));
  assert.equal(r.status, 3, r.out);
  assert.equal(read(D, 'cv.md'), '# Me\n');
  assert.equal(read(D, 'documents', 'projects', 'proj.md'), '# P\n');
});

test('a script that lives inside a checkout uses that checkout: no clone, and the checkout is the target', () => {
  const w = makeWorld({ keychain: true });
  const inside = path.join(w.T, 'inside');
  w.makeCheckout(inside);
  // Without tests/: the installer runs a checkout's custom specs, and these would run this test again.
  fs.cpSync(INSTALL_DIR, path.join(inside, 'custom', 'install'), { recursive: true, filter: withoutTests(INSTALL_DIR) });
  const r = w.run(['--non-interactive', ...QUIET], { script: path.join(inside, 'custom', 'install', 'install.sh') });
  assert.match(r.out, /no custom\/\*\/tests specs in this checkout; skipping the self-tests/);
  assert.equal(r.status, 0, r.out);
  assert.equal(w.log().filter((l) => l.startsWith('git clone')).length, 0);
  assert.ok(r.out.includes(`checkout:  ${inside}`), r.out);
  assert.ok(w.log().includes(`npm install --no-package-lock (cwd=${inside})`) || w.log().includes(`npm ci (cwd=${inside})`));
});

test('a detached HEAD (a tag clone) is not pulled and the message says how to follow main', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D);
  fs.writeFileSync(path.join(D, '.git', 'branch'), 'HEAD\n');
  const r = w.run(args());
  assert.ok(!w.log().some((l) => l.includes('pull')));
  assert.match(r.out, /detached/i);
  assert.match(r.out, /git switch main/);
});

test('the install log goes under the data root an existing .career-ops-data marker points at, not under the checkout', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'markerdata');
  w.makeCheckout(D, { files: { '.career-ops-data': `${data}\n` } });
  w.run(args());
  assert.equal(installLogs(data).length, 1);
  assert.equal(installLogs(D).length, 0);
});

test('the install log follows CAREER_OPS_ROOT from the environment', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'envdata');
  w.makeCheckout(D);
  w.run(args(), { env: { CAREER_OPS_ROOT: data } });
  assert.equal(installLogs(data).length, 1);
  assert.equal(installLogs(D).length, 0);
});

test('the intro and the --resume same-file guard use the effective data root of an existing checkout with a marker', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'markerdata');
  w.makeCheckout(D, { files: { '.career-ops-data': `${data}\n` } });
  fs.mkdirSync(data, { recursive: true });
  const cv = path.join(data, 'cv.md');
  fs.writeFileSync(cv, '# Mine\n');
  const ok = w.run(args('--dry-run'));
  assert.ok(ok.out.includes(`data root: ${data}`), ok.out);
  const before = w.snapshot();
  const r = w.run(args('--resume', cv, '--dry-run'));
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /target cv\.md/);
  assert.deepEqual(w.snapshot(), before);
});

test('the intro shows CAREER_OPS_ROOT as the data root when the environment sets it', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'envdata');
  w.makeCheckout(D);
  const r = w.run(args('--dry-run'), { env: { CAREER_OPS_ROOT: data } });
  assert.ok(r.out.includes(`data root: ${data}`), r.out);
});

test('--data-root that conflicts with the environment fails first: nothing is created in either root', () => {
  const { w, D, args } = fresh();
  const wanted = path.join(w.T, 'wanted');
  const other = path.join(w.T, 'other');
  w.makeCheckout(D);
  const before = w.snapshot();
  const r = w.run(args('--data-root', wanted), { env: { CAREER_OPS_ROOT: other } });
  assert.equal(r.status, 1);
  assert.match(r.out, /CAREER_OPS_ROOT/);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(exists(wanted), false);
  assert.equal(exists(other), false);
  assert.equal(w.calls('npm').length, 0);
});

test('--data-root that conflicts with an existing marker fails first with no log or directory in the marker root', () => {
  const { w, D, args } = fresh();
  const wanted = path.join(w.T, 'wanted');
  const other = path.join(w.T, 'other');
  w.makeCheckout(D, { files: { '.career-ops-data': `${other}\n` } });
  const before = w.snapshot();
  const r = w.run(args('--data-root', wanted));
  assert.equal(r.status, 1);
  assert.match(r.out, /\.career-ops-data/);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(exists(wanted), false);
  assert.equal(exists(other), false);
});

test('a conflict with the environment is detected before a fresh clone too', () => {
  const { w, D, args } = fresh();
  const r = w.run(args('--data-root', path.join(w.T, 'wanted')), { env: { CAREER_OPS_ROOT: path.join(w.T, 'other') } });
  assert.equal(r.status, 1);
  assert.equal(exists(D), false);
  assert.equal(w.calls('git').filter((l) => l.startsWith('git clone')).length, 0);
});

test('blank CAREER_OPS_ROOT and CAREER_OPS_DATA_DIR are not overrides: --data-root wins and the log lands there', () => {
  const { w, D, args } = fresh();
  const data = path.join(w.T, 'mydata');
  const r = w.run(args('--data-root', data), { env: { CAREER_OPS_ROOT: '   ', CAREER_OPS_DATA_DIR: ' ' } });
  assert.equal(r.status, 3, r.out);
  assert.equal(installLogs(data).length, 1);
  assert.equal(read(D, '.career-ops-data').trim(), data);
});

test('a marker that spells the same --data-root differently (trailing slash, relative, symlink) is accepted and left untouched', () => {
  const data = (w) => {
    const d = path.join(w.T, 'mydata');
    fs.mkdirSync(d);
    return d;
  };
  const spellings = [
    (w, d) => `${d}/`,
    (w) => '../mydata',
    (w, d) => {
      fs.symlinkSync(d, path.join(w.T, 'datalink'));
      return path.join(w.T, 'datalink');
    },
  ];
  for (const spell of spellings) {
    const { w, D, args } = fresh();
    const d = data(w);
    const marker = `${spell(w, d)}\n`;
    w.makeCheckout(D, { files: { '.career-ops-data': marker } });
    const r = w.run(args('--data-root', d));
    assert.equal(r.status, 3, `${marker}: ${r.out}`);
    assert.equal(read(D, '.career-ops-data'), marker);
    assert.equal(read(d, 'modes', '_custom.md'), seededCustom());
  }
});

test('an empty marker is reported as empty, not as pointing somewhere', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { files: { '.career-ops-data': '  \n' } });
  const before = w.snapshot();
  const r = w.run(args('--data-root', path.join(w.T, 'wanted')));
  assert.equal(r.status, 1);
  assert.match(r.out, /\.career-ops-data is empty/);
  assert.deepEqual(w.snapshot(), before);
});

test('without node the environment half of the data-root check still runs: the intro shows the right root and a conflict fails before the plan question', () => {
  const tools = ['git', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'claude'];
  const a = fresh({ tools });
  const env = path.join(a.w.T, 'envdata');
  const intro = a.w.run(['--dir', a.D, '--non-interactive', '--dry-run'], { env: { CAREER_OPS_ROOT: env } });
  assert.ok(intro.out.includes(`data root: ${env}`), intro.out);
  const b = fresh({ tools });
  const r = b.w.run(['--dir', b.D, '--data-root', path.join(b.w.T, 'wanted')], { env: { CAREER_OPS_ROOT: path.join(b.w.T, 'other') }, tty: 'y\ny\n' });
  assert.equal(r.status, 1);
  assert.match(r.out, /CAREER_OPS_ROOT/);
  assert.doesNotMatch(r.out, /Proceed\?/);
});

test('printed commands shell-quote every path, so a checkout directory with a space is copy-pasteable', () => {
  const w = makeWorld({ keychain: true });
  const D = path.join(w.T, 'my checkout');
  const q = (p) => `'${p}'`;
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none']);
  assert.match(r.out, new RegExp(`cd ${q(D).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && node plugins\\.mjs enable`));
  assert.ok(r.out.includes(`cd ${q(D)} && claude 'Read custom/install/ONBOARDING.md`), r.out);
  assert.ok(r.out.includes(`bash ${q(`${D}/custom/launchd/install.sh`)} --jobs daily`), r.out);
  const unquoted = r.out.split('\n').filter((l) => /(cd|bash|-C|--prefix) /.test(l) && l.includes(D) && !l.includes(q(D)) && !l.includes(q(`${D}/`).slice(0, -1)));
  assert.deepEqual(unquoted.filter((l) => /^\s*(cd|bash|\d+\.)/.test(l) || /Retry|run:|Without it/.test(l)), []);
});

test('the pending text for a dirty checkout and for a failed doctor quotes the directory too', () => {
  const w = makeWorld({ keychain: true });
  const D = path.join(w.T, 'my checkout');
  w.makeCheckout(D, { files: READY_FILES });
  fs.writeFileSync(path.join(D, '.git', 'dirty'), ' M x\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none', '--ref', 'v1'], { env: { FAKE_DOCTOR_EXIT: '1' } });
  assert.ok(r.out.includes(`git -C '${D}' checkout 'v1'`), r.out);
  assert.ok(r.out.includes(`run it in '${D}'`), r.out);
});

test('INSTALL_SH exists and is executable bash (R11-tests-custom-L1-05)', () => {
  assert.ok(fs.existsSync(INSTALL_SH));
  // .github/README.md runs it directly, so a lost exec bit is "permission denied" for every user.
  assert.doesNotThrow(() => fs.accessSync(INSTALL_SH, fs.constants.X_OK), 'install.sh is not executable');
  assert.match(fs.readFileSync(INSTALL_SH, 'utf8').split('\n')[0], /^#!(\/usr\/bin\/env bash|\/bin\/bash)$/);
});

// ---- git failing: offline, or a pull that cannot fast-forward (SW2-tests-31) ----

test('a clone that fails (offline) stops with exit 1 and says so, never "unexpected failure" pointing at a log that does not exist', () => {
  const { w, D, args } = fresh();
  const r = w.run(args(), { env: { FAKE_GIT_FAIL: 'clone' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^error: git clone of https:\/\/github\.com\/Divy2000\/career-ops\.git into .* failed/m);
  assert.doesNotMatch(r.out, /unexpected failure|see the install log/);
  assert.equal(exists(D, 'package.json'), false);
});

test('a tag that cannot be fetched or checked out stops with exit 1 and names it', () => {
  for (const sub of ['fetch', 'checkout']) {
    const { w, D, args } = fresh();
    w.makeCheckout(D);
    const r = w.run(args('--ref', 'fork-install-v9'), { env: { FAKE_GIT_FAIL: sub } });
    assert.equal(r.status, 1, `${sub}: ${r.out}`);
    assert.match(r.out, /^error: could not check out fork-install-v9 in /m, sub);
    assert.doesNotMatch(r.out, /unexpected failure/, sub);
  }
});

test('a pull that cannot fast-forward is a pending action, not a failure', () => {
  const { w, D, args } = fresh({ keychain: true });
  w.makeCheckout(D);
  const r = w.run(args(), { env: { FAKE_GIT_FAIL: 'pull' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /git pull --ff-only failed in .*; resolve it by hand\./);
});

// ---- pty_run.py itself: a prompt that never comes, a command that never ends, an older Python (SW2-tests-32) ----

const PTY_RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty_run.py');
const ptyRun = (steps, cmd, { env = {}, pre = '' } = {}) => {
  const args = pre
    ? ['-c', `${pre}\nimport runpy, sys\nsys.argv = ${JSON.stringify([PTY_RUN, JSON.stringify(steps), '--', ...cmd])}\nrunpy.run_path(${JSON.stringify(PTY_RUN)}, run_name='__main__')`]
    : [PTY_RUN, JSON.stringify(steps), '--', ...cmd];
  return spawnSync('python3', args, { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20_000 });
};

test('pty_run.py fails when a prompt it was told to answer never appears', { skip: PTY_SKIP }, () => {
  const r = ptyRun([{ expect: 'Never asked\\?', send: 'y\n' }], ['bash', '-c', 'echo hello']);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /pty_run: prompt never appeared: Never asked/);
  assert.match(r.stdout, /hello/);
});

test('pty_run.py kills a command still running at its deadline, and fails', { skip: PTY_SKIP }, () => {
  const started = Date.now();
  const r = ptyRun([], ['sleep', '30'], { env: { PTY_RUN_TIMEOUT: '1' } });
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pty_run: timed out after 1 s; killed the command/);
});

test('pty_run.py exits with the command\'s own status, also on a Python without os.waitstatus_to_exitcode (before 3.9)', { skip: PTY_SKIP }, () => {
  assert.equal(ptyRun([], ['bash', '-c', 'exit 3']).status, 3);
  const old = ptyRun([], ['bash', '-c', 'exit 3'], { pre: 'import os\ndel os.waitstatus_to_exitcode' });
  assert.equal(old.status, 3, old.stderr);
});

// ---- a data root the confinement would refuse (SW3-tests-01) ----

test('a data root that is the home directory, a folder containing it, or / is refused with exit 1 before anything changes', () => {
  const cases = [
    ['--data-root ~', (w) => ({ args: ['--data-root', w.home] })],
    ['--data-root /', () => ({ args: ['--data-root', '/'] })],
    ['--data-root <parent of home>', (w) => ({ args: ['--data-root', path.dirname(w.home)] })],
    // Through a folder that does not exist yet: resolved as the kernel will once step 5 creates it (R19-scripts-b-L3-01).
    ['--data-root ~/new/..', (w) => ({ args: ['--data-root', `${w.home}/new/..`] })],
    ['--data-root ~/new/deeper/../..', (w) => ({ args: ['--data-root', `${w.home}/new/deeper/../..`] })],
    ['--data-root ~/a/link/.. where link dangles to ~/q', (w) => {
      fs.mkdirSync(path.join(w.home, 'a'), { recursive: true });
      fs.symlinkSync(path.join(w.home, 'q'), path.join(w.home, 'a', 'link'));
      return { args: ['--data-root', `${w.home}/a/link/..`] };
    }],
    ['CAREER_OPS_ROOT=$HOME', (w) => ({ args: [], env: { CAREER_OPS_ROOT: w.home } })],
    ['CAREER_OPS_DATA_DIR=$HOME', (w) => ({ args: [], env: { CAREER_OPS_DATA_DIR: w.home } })],
  ];
  for (const [name, make] of cases) {
    const { w, D } = fresh({ keychain: true });
    const { args, env = {} } = make(w);
    const before = w.snapshot();
    const r = w.run(['--dir', D, '--non-interactive', ...QUIET, ...args], { env });
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.match(r.out, /error: the data root .* (is your home directory or contains it|is the filesystem root)/, name);
    assert.deepEqual(w.snapshot(), before, `${name}: nothing created`);
    assert.equal(w.log().length, 0, `${name}: ${w.log().join('\n')}`);
  }
});

test('a data root next to the home directory is fine', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', ...QUIET, '--data-root', path.join(w.home, 'career-data')]);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(path.join(w.home, 'career-data', 'modes', '_custom.md')));
});

test('a checkout marker naming the home directory is refused once node is installed, before the log or the daily lock lands in home (R30-scripts-b-L2-01)', () => {
  const { w, D } = fresh({ tools: ['git', 'security', 'uname', 'launchctl', 'plutil', 'claude'], keychain: true });
  const stubs = path.join(INSTALL_DIR, 'tests', 'stubs');
  // brew install node puts node and npm on the PATH, as Homebrew does.
  fs.writeFileSync(path.join(w.bin, 'brew'), `#!/bin/bash\necho "brew $*" >> "$STUB_LOG"\nif [ "$*" = "install node" ]; then ln -sf ${stubs}/node ${w.bin}/node; ln -sf ${stubs}/npm ${w.bin}/npm; fi\nexit 0\n`, { mode: 0o755 });
  w.makeCheckout(D, { files: { '.career-ops-data': `${w.home}\n` } });
  const r = w.run(['--dir', D, '--install-missing', ...QUIET], { tty: 'y\ny\nn\nn\nn\n' });
  assert.ok(w.calls('brew').includes('brew install node'), r.out);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /error: the data root .* is your home directory or contains it/);
  assert.ok(!fs.existsSync(path.join(w.home, 'data')), 'nothing written under the home directory');
  assert.ok(!fs.existsSync(path.join(w.home, 'modes')), 'nothing written under the home directory');
  assert.ok(!w.log().some((l) => l.startsWith('git pull') || l.startsWith('npm')), w.log().join('\n'));
});

test('a data root that does not exist yet, named with a trailing slash in CAREER_OPS_ROOT, is that folder, not its parent (review of R19-scripts-b-L3-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const root = path.join(w.home, 'new-root');
  const r = w.run(['--dir', D, '--non-interactive', ...QUIET], { env: { CAREER_OPS_ROOT: `${root}/` } });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /is your home directory or contains it/);
  assert.ok(fs.existsSync(path.join(root, 'modes', '_custom.md')));
});

test('the test world finds no system copy of a tool the installer probes for, so a missing-tool spec means the same on every OS (SW3-tests-06)', () => {
  const w = makeWorld({ tools: ['uname'] });
  for (const tool of ['git', 'node', 'npm', 'npx', 'claude', 'brew', 'gh', 'pdftotext', 'go']) {
    const r = spawnSync('bash', ['-c', `command -v ${tool} || true`], { env: w.env(), encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '', `${tool} found on the world PATH`);
  }
  for (const tool of ['bash', 'sed', 'awk', 'mktemp', 'python3']) {
    const r = spawnSync('bash', ['-c', `command -v ${tool}`], { env: w.env(), encoding: 'utf8' });
    assert.notEqual(r.stdout.trim(), '', `${tool} is still there for the installer`);
  }
});

test('the system command links survive a dangling symlink listed in two folders (merged /usr), keeping the first (review of SW3-tests-06)', () => {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ci-sysbin-test-')));
  try {
    const usrBin = path.join(T, 'usr-bin');
    const bin = path.join(T, 'bin');
    const into = path.join(T, 'into');
    for (const d of [usrBin, bin, into]) fs.mkdirSync(d);
    fs.symlinkSync(path.join(T, 'gone'), path.join(usrBin, 'dangling'));
    fs.symlinkSync(path.join(T, 'gone'), path.join(bin, 'dangling'));
    fs.writeFileSync(path.join(usrBin, 'sed'), '');
    fs.writeFileSync(path.join(bin, 'sed'), '');
    fs.writeFileSync(path.join(bin, 'npm'), '');
    linkSystemCommands([usrBin, bin], into);
    assert.deepEqual(fs.readdirSync(into).sort(), ['dangling', 'sed']);
    assert.equal(fs.readlinkSync(path.join(into, 'sed')), path.join(usrBin, 'sed'));
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('a data root that is the home directory spelled in another case is refused too, as the confinement resolves it (review of SW3-tests-01)', (t) => {
  const h = caseFlippedHome();
  if (!h) return t.skip('needs a case-insensitive temp folder (macOS)');
  try {
    const { w, D } = fresh({ keychain: true });
    const r = w.run(['--dir', D, '--non-interactive', '--dry-run', ...QUIET, '--data-root', h.flipped], { env: { HOME: h.home } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /error: the data root .* is your home directory or contains it/);
  } finally {
    h.cleanup();
  }
});

test('a marker naming the --data-root folder in another letter case is the same folder, not a conflict (SW4-tests-28)', (t) => {
  const h = caseFlippedHome();
  if (!h) return t.skip('needs a case-insensitive temp folder (macOS)');
  try {
    const { w, D, args } = fresh();
    const data = path.join(h.home, 'career-data');
    fs.mkdirSync(data);
    const marker = `${path.join(h.flipped, 'Career-Data')}\n`;
    w.makeCheckout(D, { files: { '.career-ops-data': marker } });
    const r = w.run(args('--data-root', data));
    assert.doesNotMatch(r.out, /already points at/, r.out);
    assert.equal(r.status, 3, r.out);
    assert.equal(read(D, '.career-ops-data'), marker);
  } finally {
    h.cleanup();
  }
});

// ---- installer failure branches the always-succeeding stubs never ran (SW4-tests-29) ----

test('claude setup-token that fails leaves the token as a pending action and says it did not finish', () => {
  const { w, D } = fresh();
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\ny\n', env: { FAKE_CLAUDE_SETUP_TOKEN_EXIT: '1' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /claude setup-token did not finish\./);
  assert.match(r.out, /\d+\. Store the Claude token yourself, in your own terminal: claude setup-token/);
  assert.equal(w.calls('security').filter((l) => l.startsWith('security add-generic-password')).length, 0);
});

test('a token that was not stored (the Keychain prompt was cancelled) is a pending action, not "stored"', () => {
  const { w, D } = fresh();
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\ny\n', env: { FAKE_SECURITY_ADD_NOOP: '1' } });
  assert.equal(r.status, 3, r.out);
  assert.doesNotMatch(r.out, /Keychain item stored\./);
  assert.match(r.out, /\d+\. Store the Claude token yourself/);
});

test('a token stored empty (Enter at both hidden prompts) is a pending action and no daily job, not "stored" (R30-scripts-b-L2-02)', () => {
  const { w, D } = fresh();
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--no-start', '--no-h1b-index', '--onboard', 'none'], { tty: 'y\ny\ny\ny\n', env: { FAKE_SECURITY_TOKEN: '' } });
  assert.equal(r.status, 3, r.out);
  assert.doesNotMatch(r.out, /Keychain item stored\./);
  assert.match(r.out, /\d+\. Store the Claude token yourself/);
  assert.equal(w.calls('launchd-install').length, 0, 'the daily job is not installed on an empty token');
  const reads = w.calls('security').filter((l) => l.startsWith('security find-generic-password') && l.includes(' -w'));
  assert.equal(reads.length, 1, 'only the item this run created is read, once');
});

test('a token stored by this run is read back once and counts as stored (R30-scripts-b-L2-02)', () => {
  const { w, D } = fresh();
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--no-start', '--no-h1b-index', '--onboard', 'none'], { tty: 'y\ny\ny\ny\n' });
  assert.match(r.out, /Keychain item stored\./);
  assert.ok(!r.out.includes(SECRET));
  assert.ok(w.calls('launchd-install').length > 0, r.out);
});

test('a headless onboarding run that fails says so and still prints how to finish interactively', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_P_EXIT: '1' } });
  assert.match(r.out, /The headless run did not finish cleanly; review any drafts in /);
  assert.doesNotMatch(r.out, /Drafts written:/);
  assert.match(r.out, /claude 'Read custom\/install\/ONBOARDING\.md and follow it\.'/);
});

test('a Control Center npm ci that fails stops the install with exit 1 and names it', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--non-interactive', ...QUIET], { env: { FAKE_NPM_FAIL_ON: '--prefix custom/control-center ci' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /error: npm ci for the Control Center failed\. See .*install-.*\.log/);
  assert.equal(w.calls('cc').length, 0, 'the Control Center is not started');
});

test('a failing Control Center preflight is a pending action, and the Control Center is not started on it', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_NPM_FAIL_ON: '--prefix custom/control-center run preflight' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /\d+\. The Control Center preflight failed; run: npm --prefix .*custom\/control-center' run preflight/);
  assert.equal(w.calls('cc').length, 0, 'the Control Center is not started after a failed preflight');
});

test('given the Control Center npm ci was skipped and the preflight then fails, the pending npm ci comes before the preflight, which ran on the old dependencies (R27-scripts-b-L1-01 review)', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(D, 'data', 'control-center', 'supervisor.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const r = w.run(['--dir', D, '--non-interactive', '--no-launchd', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_NPM_FAIL_ON: '--prefix custom/control-center run preflight' } });
    assert.equal(r.status, 3, r.out);
    const ci = r.out.indexOf('The Control Center was running, so its dependencies were not reinstalled');
    const preflight = r.out.indexOf('The Control Center preflight failed; run:');
    assert.ok(ci !== -1 && preflight !== -1 && ci < preflight, r.out);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a launchd install that fails (other than a job running) is a pending action with the retry command', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: READY_FILES });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-h1b-index', '--onboard', 'none'], { env: { FAKE_LAUNCHD_EXIT: '1' } });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /\d+\. The launchd install failed\. Retry: bash .*custom\/launchd\/install\.sh' --jobs daily/);
});

test('the test world has no system security, launchctl or plutil, so a world without their stubs never reaches the real Keychain or launchd (SW5-tests-20)', () => {
  const w = makeWorld({ tools: ['uname'] });
  for (const tool of ['security', 'launchctl', 'plutil']) {
    const r = spawnSync('bash', ['-c', `command -v ${tool} || true`], { env: w.env(), encoding: 'utf8' });
    assert.equal(r.stdout.trim(), '', `${tool} found on the world PATH`);
  }
});

test('the pty tests are skipped, not failed, when python3 is missing or is a stub that cannot run (SW5-tests-19)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ci-nopy-')));
  try {
    assert.match(pythonPtyMissing(dir), /python3/, 'no python3 on PATH');
    // The macOS Command Line Tools stub: python3 exists but exits non-zero.
    fs.writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\necho "xcode-select: note: No developer tools were found" >&2\nexit 1\n', { mode: 0o755 });
    assert.match(pythonPtyMissing(dir), /python3/, 'a python3 that cannot run');
    // A shim that exits 0 without running anything (review of SW5-tests-19).
    fs.writeFileSync(path.join(dir, 'python3'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.match(pythonPtyMissing(dir), /python3/, 'a python3 that exits 0 but never imported pty');
    // Stands in for a python3 that ran the probe: it prints the line the probe prints once pty imported.
    fs.writeFileSync(path.join(dir, 'python3'), `#!/bin/sh\necho ${PTY_PROBE_OK}\n`, { mode: 0o755 });
    assert.equal(pythonPtyMissing(dir), false, 'a python3 that runs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
