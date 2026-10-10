import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caseFlippedHome } from '../../test-support/case-home.mjs';
import { makeWorld, installLogs, INSTALL_SH, INSTALL_DIR, FORK_URL, linkSystemCommands, pythonPtyMissing, PTY_PROBE_OK, SYSTEM_DIRS } from './harness.mjs';

const SECRET = 'FAKE-SECRET-123';
const QUIET = ['--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'none'];
// pty_run.py needs a python3 that runs; without one the pty tests skip instead of failing. pty_run.py's own tests
// find it on this process's PATH, an install run under a pty on the world's system folders.
const PTY_SKIP = pythonPtyMissing(process.env.PATH);
const WORLD_PTY_SKIP = pythonPtyMissing(SYSTEM_DIRS.join(':'));

function fresh(opts = {}) {
  const w = makeWorld(opts);
  const D = path.join(w.T, 'checkout');
  const args = (...extra) => ['--dir', D, '--non-interactive', ...QUIET, ...extra];
  return { w, D, args };
}
const READY_FILES = {
  'cv.md': '# Me\n',
  'config/profile.yml': 'name: x\n',
  'modes/_profile.md': 'mine\n',
  // Seeded from its template otherwise, which the doctor reports as not personalized.
  'modes/_brief.md': 'my brief\n',
  'portals.yml': 'x: 1\n',
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));
const md = (w, name, data) => w.write(`src/${name}`, data);
// A freshly seeded modes/_custom.md: the template with the projects-library rule in place of its first "none yet" line.
const seededCustom = () => read(INSTALL_DIR, 'templates', '_custom.md').replace('(none yet -- add yours above)', read(INSTALL_DIR, 'templates', '_custom-projects.md').trimEnd());

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

test('a missing npm is a failure (exit 1) that names npm', () => {
  const { w, args } = fresh({ tools: ['git', 'node', 'security', 'uname', 'launchctl', 'plutil', 'claude'] });
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.match(r.out, /npm/);
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
  const { w, args } = fresh({ tools: ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil'], keychain: true });
  const r = w.run(args());
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(r.out, /brew install --cask claude-code/);
  assert.equal(w.calls('claude').length, 0);
  assert.equal(w.calls('brew').length, 0);
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

test('an origin that is not the fork is refused with exit 1', () => {
  const { w, D, args } = fresh();
  w.makeCheckout(D, { origin: 'https://github.com/career-ops-hq/career-ops.git' });
  const r = w.run(args());
  assert.equal(r.status, 1);
  assert.match(r.out, /origin/);
  assert.equal(w.calls('npm').length, 0);
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
  const hang = w.write('hang.sh', 'echo "waiting for an answer that never comes"\nexec sleep 60\n');
  const r = w.runInPty([], { steps: [], script: hang, timeout: 8_000 });
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

/** A cpSync filter for a copy of `root` (custom/install) without its tests/ folder, wherever the checkout lives. */
const withoutTests = (root) => (src) => path.relative(root, src).split(path.sep)[0] !== 'tests';

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

// ---------------------------------------------------------------- Keychain

test('without a TTY a missing Keychain item is a pending action (exit 3) and the token flow never starts', () => {
  const { w, args } = fresh();
  const r = w.run(args());
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /career-ops-claude-token/);
  assert.match(r.out, /claude setup-token/);
  assert.ok(!w.calls('claude').some((l) => l.includes('setup-token')));
  assert.ok(!w.log().some((l) => l.includes('add-generic-password')));
  assert.ok(!r.out.includes(SECRET));
});

test('an existing Keychain item is checked without reading the secret and nothing is run', () => {
  const { w, args } = fresh({ keychain: true });
  w.run(args());
  const sec = w.calls('security');
  assert.ok(sec.length > 0);
  assert.ok(sec.every((l) => !l.includes(' -w') && !l.includes(' -g')), sec.join('\n'));
  assert.ok(!w.calls('claude').some((l) => l.includes('setup-token')));
});

test('on a terminal the token is created through the TTY only: it never reaches the installer output or log, and add-generic-password takes no value', () => {
  const { w, D } = fresh();
  const data = path.join(w.T, 'mydata');
  const r = w.run(['--dir', D, '--data-root', data, ...QUIET], { tty: 'y\ny\n' });
  assert.ok(w.calls('claude').some((l) => l.startsWith('claude setup-token')), r.out);
  assert.ok(!r.out.includes(SECRET));
  assert.ok(w.ttyOutput().includes(SECRET), 'the secret went to the terminal and nowhere else');
  for (const log of installLogs(data)) assert.ok(!fs.readFileSync(log, 'utf8').includes(SECRET));
  const add = w.calls('security').filter((l) => l.startsWith('security add-generic-password'));
  assert.deepEqual(add, ['security add-generic-password -U -a tester -s career-ops-claude-token -w']);
  assert.ok(!w.log().some((l) => l.includes(SECRET)));
});

test('answering n to the token question skips the flow and leaves a pending action', () => {
  const { w, D } = fresh();
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\nn\n' });
  assert.equal(r.status, 3);
  assert.ok(!w.calls('claude').some((l) => l.includes('setup-token')));
});

// ---------------------------------------------------------------- plan confirmation

test('on a terminal the plan is confirmed first; n aborts with exit 1 and nothing changes', () => {
  const { w, D } = fresh();
  const before = w.snapshot();
  const r = w.run(['--dir', D, ...QUIET], { tty: 'n\n' });
  assert.equal(r.status, 1);
  assert.match(r.out, /aborted/i);
  assert.deepEqual(w.snapshot(), before);
  assert.equal(w.calls('git').length, 0);
});

test('--yes skips the plan question', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--yes', ...QUIET], { tty: 'n\nn\nn\n' });
  assert.equal(r.status, 0, r.out);
  assert.ok(w.calls('git').some((l) => l.startsWith('git clone')));
});

// ---------------------------------------------------------------- H-1B index

test('an installed H-1B index is detected and nothing is downloaded', () => {
  const { w, D } = fresh({ keychain: true });
  w.makeCheckout(D, { files: { 'data/h1b/index.ndjson.gz': 'x' } });
  w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--onboard', 'none']);
  assert.equal(w.calls('plugins').length, 0);
  assert.equal(w.calls('h1b-install').length, 0);
});

test('a missing H-1B index is installed by default in non-interactive mode, after enabling the plugin', () => {
  const { w, D } = fresh({ keychain: true });
  w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--onboard', 'none']);
  const log = w.log();
  const enable = log.indexOf('plugins enable h1b-sponsor --confirm');
  const install = log.findIndex((l) => l.startsWith('h1b-install'));
  assert.ok(enable >= 0 && install > enable, log.join('\n'));
});

test('--no-h1b-index skips it, and answering n on a terminal skips it too', () => {
  const a = fresh({ keychain: true });
  a.w.run(a.args());
  assert.equal(a.w.calls('h1b-install').length, 0);
  const b = fresh({ keychain: true });
  b.w.run(['--dir', b.D, '--no-start', '--no-launchd', '--onboard', 'none'], { tty: 'y\nn\n' });
  assert.equal(b.w.calls('h1b-install').length, 0);
});

// ---------------------------------------------------------------- onboarding

test('by default without a TTY onboarding is not started: the interactive command is printed with the copied paths and claude is not called', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const doc = md(w, 'proj.md', '# P\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume, '--docs', doc]);
  assert.equal(w.calls('claude').length, 0);
  assert.match(r.out, /claude '?"?Read custom\/install\/ONBOARDING\.md and follow it\./);
  assert.ok(r.out.includes(path.join(D, 'documents', 'cv', 'resume.md')));
  assert.ok(r.out.includes(path.join(D, 'documents', 'projects', 'proj.md')));
});

test('--onboard none prints the command even on a terminal', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, ...QUIET], { tty: 'y\n' });
  assert.equal(w.calls('claude').length, 0);
  assert.match(r.out, /Read custom\/install\/ONBOARDING\.md and follow it/);
});

test('--onboard interactive starts claude without -p, from the checkout, with a prompt naming ONBOARDING.md and the paths', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const doc = md(w, 'proj.md', '# P\n');
  w.run(['--dir', D, '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'interactive', '--resume', resume, '--docs', doc], { tty: 'y\n' });
  const argv = w.claudeArgv();
  assert.ok(argv, 'claude was called');
  assert.equal(argv.length, 1);
  assert.ok(!argv.includes('-p'));
  assert.match(argv[0], /^Read custom\/install\/ONBOARDING\.md and follow it\./);
  assert.ok(argv[0].includes(path.join(D, 'documents', 'cv', 'resume.md')));
  assert.ok(argv[0].includes(path.join(D, 'documents', 'projects', 'proj.md')));
  assert.ok(w.calls('claude').some((l) => l.includes(`(cwd=${D})`)));
});

test('--yes at a terminal takes onboarding\'s default answer too: Claude Code starts interactively, as --help documents (SW6-scripts-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--yes', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume], { tty: '\n' });
  const argv = w.claudeArgv();
  assert.ok(argv, r.out);
  assert.ok(!argv.includes('-p'), argv.join(' '));
  assert.match(argv.at(-1), /ONBOARDING\.md/);
});

test('--yes without a terminal still only prints the onboarding command', () => {
  const { w, D } = fresh({ keychain: true });
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--yes', '--no-start', '--no-launchd', '--no-h1b-index', '--resume', resume]);
  assert.equal(w.claudeArgv(), null, r.out);
  assert.match(r.out, /claude '/);
});

test('--onboard interactive without a usable terminal prints the command and records a pending action instead', () => {
  const { w, D } = fresh({ keychain: true });
  const r = w.run(['--dir', D, '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'interactive']);
  assert.equal(w.calls('claude').length, 0);
  assert.equal(r.status, 3);
});

test('--onboard headless runs a restricted claude -p: dontAsk, read tools plus one Edit rule for the draft dir, no Bash, no MCP servers, token only in the child env and never in its hook or tool children (R11-scripts-b-L3-01)', () => {
  const { w, D } = fresh({ keychain: true });
  const data = path.join(w.T, 'mydata');
  const resume = md(w, 'resume.md', '# Me\n## Skills\n');
  const r = w.run(['--dir', D, '--data-root', data, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env: { FAKE_CLAUDE_DRAFTS: '1' } });
  const argv = w.claudeArgv();
  assert.ok(argv, r.out);
  const draft = path.join(data, 'data', 'install', 'onboarding-draft');
  assert.equal(argv[0], '-p');
  assert.ok(argv[1].includes(draft));
  assert.match(argv[1], /Draft mode/);
  assert.doesNotMatch(argv[1], /\{\{/);
  const flag = (name) => argv[argv.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--max-turns'), '40');
  assert.equal(flag('--effort'), 'medium');
  assert.equal(flag('--output-format'), 'text');
  assert.ok(argv.includes('--add-dir') && argv.includes(draft));
  const start = argv.indexOf('--allowedTools') + 1;
  const tools = [];
  for (let i = start; i < argv.length && !argv[i].startsWith('--'); i++) tools.push(argv[i]);
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep', `Edit(/${draft}/**)`]);
  assert.ok(!argv.some((a) => /bash/i.test(a) && !a.includes('\n') && a.length < 40));
  // As the Control Center confines its sessions: no user or project MCP server starts with the token in its env.
  assert.ok(argv.includes('--strict-mcp-config'), argv.join(' '));
  assert.ok(!argv.includes('--mcp-config'), 'no MCP config is handed in');
  const envLine = w.log().find((l) => l.startsWith('claude-env'));
  // SUBPROCESS_ENV_SCRUB: hook and tool children run without the OAuth token.
  assert.equal(envLine, 'claude-env TOKEN_SET=1 API_KEY_EMPTY=1 SUBPROCESS_ENV_SCRUB=1');
  assert.ok(!r.out.includes(SECRET));
  assert.ok(!w.log().some((l) => l.includes(SECRET)));
  for (const log of installLogs(data)) assert.ok(!fs.readFileSync(log, 'utf8').includes(SECRET));
  assert.equal(exists(data, 'config', 'profile.yml'), false);
  assert.equal(exists(data, 'portals.yml'), false);
  assert.equal(exists(data, 'article-digest.md'), false);
  assert.ok(r.out.includes(path.join(draft, 'questions.md')));
  assert.match(r.out, /claude .*Read custom\/install\/ONBOARDING\.md and follow it/);
});

test('--onboard headless without the Keychain item is a pending action (exit 3) and claude is not called', () => {
  const { w, D } = fresh({ keychain: false });
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless']);
  assert.equal(r.status, 3);
  assert.equal(w.claudeArgv(), null);
  assert.match(r.out, /Keychain/);
});

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
