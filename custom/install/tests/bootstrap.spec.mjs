import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';
import { makeWorld, BOOTSTRAP_SH, FORK_URL } from './harness.mjs';

function world() {
  const w = makeWorld({ tools: ['git', 'node', 'npm', 'uname'] });
  const installer = path.join(w.fakeSrc, 'custom', 'install', 'install.sh');
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  fs.writeFileSync(installer, '#!/bin/bash\necho "install-sh $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  return w;
}
const source = fs.readFileSync(BOOTSTRAP_SH, 'utf8');
// Feeds a (possibly truncated) download to bash on stdin, the way `curl | bash` runs it.
const runBash = (input, env, limits = {}) => spawnCpuLimited('bash', [], { input, env, detached: true, ...limits });

test('Given a loaded machine, a piped download run is bounded by CPU time, not by a tight wall-clock timeout (R34-flake-walltime)', () => {
  const r = runBash('ulimit -t\n', world().env());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '30\n');
});

test('Given a piped download that spins in a loop, the run is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = runBash('while :; do :; done\n', world().env(), { cpuSeconds: 1 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the spinning run was not killed');
});

test('Given a piped download that blocks on a child that never ends, the run is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = runBash('exec sleep 60\n', world().env(), { hangMs: 1000 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the blocked run was not killed');
});

test('the whole body is one function called on the last line', () => {
  const lines = source.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], 'main "$@"');
  assert.equal(lines.filter((l) => /^main\(\) \{/.test(l)).length, 1);
});

test('a download truncated inside main() executes nothing', () => {
  const w = world();
  const cut = source.slice(0, source.indexOf('git clone --branch') + 12);
  const r = runBash(cut, w.env());
  assert.notEqual(r.status, 0);
  assert.equal(w.log().length, 0);
  assert.equal(fs.existsSync(path.join(w.home, 'career-ops')), false);
});

test('a download truncated before the final call defines main and runs nothing', () => {
  const w = world();
  const lines = source.trimEnd().split('\n');
  const cut = `${lines.slice(0, -1).join('\n')}\n`;
  const r = runBash(cut, w.env());
  assert.equal(r.status, 0);
  assert.equal(w.log().length, 0);
});

test('it says what it will do, then answering n clones nothing and exits 1', () => {
  const w = world();
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'n\n' });
  assert.equal(r.status, 1);
  assert.match(r.out, new RegExp(FORK_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.out, /fork-install-v3/);
  assert.ok(r.out.split('\n').includes(`  clone into: ${path.join(w.home, 'career-ops')}`), r.out);
  assert.equal(w.log().length, 0);
});

test('without a terminal it refuses to continue and clones nothing', () => {
  const w = world();
  const r = w.run([], { script: BOOTSTRAP_SH });
  assert.equal(r.status, 1);
  assert.match(r.out, /terminal/);
  assert.equal(w.log().length, 0);
});

test('answering y clones the pinned tag into ~/career-ops and hands every argument to install.sh', () => {
  const w = world();
  const r = w.run(['--resume', 'resume.md', '--no-start'], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 0, r.out);
  const dest = path.join(w.home, 'career-ops');
  assert.ok(w.log().includes(`git clone --branch fork-install-v3 ${FORK_URL} ${dest}`), w.log().join('\n'));
  assert.ok(w.log().includes('install-sh --resume resume.md --no-start'), w.log().join('\n'));
});

test('--dir chooses the clone location and the tag can be overridden', () => {
  const w = world();
  const dest = path.join(w.T, 'elsewhere');
  const r = w.run(['--dir', dest], { script: BOOTSTRAP_SH, tty: 'y\n', env: { CAREER_OPS_INSTALL_REF: 'fork-install-v2' } });
  assert.equal(r.status, 0, r.out);
  assert.ok(w.log().includes(`git clone --branch fork-install-v2 ${FORK_URL} ${dest}`));
  assert.ok(w.log().includes(`install-sh --dir ${dest}`));
});

test('a quoted ~ in --dir means the home folder, as install.sh reads it: one clone of the pinned tag there, handed to install.sh by its full path (R19-scripts-b-L3-02)', () => {
  const w = world();
  const dest = path.join(w.home, 'elsewhere');
  const r = w.run(['--dir', '~/elsewhere', '--no-start'], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.split('\n').includes(`  clone into: ${dest}`), r.out);
  assert.ok(w.log().includes(`git clone --branch fork-install-v3 ${FORK_URL} ${dest}`), w.log().join('\n'));
  assert.ok(w.log().includes(`install-sh --dir ${dest} --no-start`), w.log().join('\n'));
  assert.equal(fs.existsSync(path.join(w.cwd, '~')), false, 'no folder named ~ in the current directory');
});

test('a relative --dir is handed to install.sh as the full path bootstrap cloned into (R19-scripts-b-L3-02)', () => {
  const w = world();
  const dest = path.join(w.cwd, 'rel', 'co');
  const r = w.run(['--dir', 'rel/co/'], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 0, r.out);
  assert.ok(w.log().includes(`git clone --branch fork-install-v3 ${FORK_URL} ${dest}`), w.log().join('\n'));
  assert.ok(w.log().includes(`install-sh --dir ${dest}`), w.log().join('\n'));
});

test('a quoted ~ in --dir finds the existing checkout in the home folder instead of cloning again (R19-scripts-b-L3-02)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest);
  fs.mkdirSync(path.join(dest, 'custom', 'install'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'custom', 'install', 'install.sh'), '#!/bin/bash\necho "install-sh $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  const r = w.run(['--dir', '~/career-ops'], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 0, r.out);
  assert.ok(!w.log().some((l) => l.startsWith('git clone')), w.log().join('\n'));
  assert.ok(w.log().includes(`install-sh --dir ${dest}`), w.log().join('\n'));
});

test('--dir with no value is refused as install.sh refuses it, before the confirm and before anything is cloned (R19-scripts-b-L3-02 review)', () => {
  for (const args of [['--dir'], ['--dir', ''], ['--dir', '--no-start']]) {
    const w = world();
    const r = w.run(args, { script: BOOTSTRAP_SH, tty: 'y\n' });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.match(r.out, /error: --dir needs a value/);
    assert.doesNotMatch(r.out, /Continue\? \[y\/N\]/);
    assert.equal(w.log().length, 0, w.log().join('\n'));
  }
});

test('an existing checkout is reused: no second clone', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest);
  fs.mkdirSync(path.join(dest, 'custom', 'install'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'custom', 'install', 'install.sh'), '#!/bin/bash\necho "install-sh $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 0, r.out);
  assert.ok(!w.log().some((l) => l.startsWith('git clone')));
  assert.ok(w.log().includes('install-sh '));
});

test('an existing checkout of another repository is refused before the confirm, and its files never run (R15-scripts-b-L3-03)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest, { origin: 'https://github.com/career-ops-hq/career-ops.git' });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`origin of ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is https://github\\.com/career-ops-hq/career-ops\\.git, not the fork`));
  assert.doesNotMatch(r.out, /Continue\? \[y\/N\]/);
  assert.ok(!w.log().some((l) => l.startsWith('install-sh') || l.startsWith('git clone')), w.log().join('\n'));
});

test('an existing fork checkout without the installer is refused before the confirm instead of ending in exit 127 (R15-scripts-b-L3-03)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest, { origin: 'git@github.com:Divy2000/career-ops.git' });
  fs.rmSync(path.join(dest, 'custom', 'install', 'install.sh'));
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /has no custom\/install\/install\.sh/);
  assert.doesNotMatch(r.out, /Continue\? \[y\/N\]/);
});

test('the banner says an existing fork checkout\'s own installer runs, not the pinned tag (R15-scripts-b-L3-03)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest, { origin: 'git@github.com:Divy2000/career-ops.git' });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'n\n' });
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.split('\n').includes(`  use:        the existing checkout at ${dest} and its own installer (checked out: main), not the pinned tag`), r.out);
  assert.doesNotMatch(r.out, /clone into:/);
});

test('a failing clone is reported and install.sh never runs', () => {
  const w = world();
  fs.rmSync(path.join(w.bin, 'git')); // a symlink to the shared stub: replace the link, never write through it
  fs.writeFileSync(path.join(w.bin, 'git'), '#!/bin/bash\necho "git $*" >> "$STUB_LOG"\nexit 128\n', { mode: 0o755 });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.notEqual(r.status, 0);
  assert.ok(!w.log().some((l) => l.startsWith('install-sh')));
});

test('a repository URL with a credential in its userinfo is shown without it, in the banner and the no-terminal error, and cloned as given (R32-scripts-b-L2-02)', () => {
  const secretUrl = 'https://me:ghp_SECRET@github.com/Divy2000/career-ops.git';
  const shown = 'https://github.com/Divy2000/career-ops.git';
  const w = world();
  const confirmed = w.run(['--no-start'], { script: BOOTSTRAP_SH, tty: 'y\n', env: { CAREER_OPS_REPO_URL: secretUrl } });
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.ok(confirmed.out.split('\n').includes(`  repository: ${shown}`), confirmed.out);
  assert.doesNotMatch(confirmed.out, /ghp_SECRET/);
  assert.ok(w.log().includes(`git clone --branch fork-install-v3 ${secretUrl} ${path.join(w.home, 'career-ops')}`), w.log().join('\n'));
  const noTty = world().run([], { script: BOOTSTRAP_SH, env: { CAREER_OPS_REPO_URL: secretUrl } });
  assert.equal(noTty.status, 1, noTty.out);
  assert.match(noTty.out, /git clone https:\/\/github\.com\/Divy2000\/career-ops\.git &&/);
  assert.doesNotMatch(noTty.out, /ghp_SECRET/);
});

test('Given a password with a raw @ in the repository URL, the banner and the no-terminal error show none of it (R35-scripts-b-L2-01)', () => {
  const secretUrl = 'https://me:p@ss@SECRET@github.com/Divy2000/career-ops.git';
  const w = world();
  const confirmed = w.run(['--no-start'], { script: BOOTSTRAP_SH, tty: 'y\n', env: { CAREER_OPS_REPO_URL: secretUrl } });
  assert.equal(confirmed.status, 0, confirmed.out);
  assert.ok(confirmed.out.split('\n').includes('  repository: https://github.com/Divy2000/career-ops.git'), confirmed.out);
  assert.doesNotMatch(confirmed.out, /SECRET|ss@/);
  const noTty = world().run([], { script: BOOTSTRAP_SH, env: { CAREER_OPS_REPO_URL: secretUrl } });
  assert.equal(noTty.status, 1, noTty.out);
  assert.match(noTty.out, /git clone https:\/\/github\.com\/Divy2000\/career-ops\.git &&/);
  assert.doesNotMatch(noTty.out, /SECRET|ss@/);
});

test('Given an existing checkout whose origin password holds a raw @, the refusal prints none of it (R35-scripts-b-L2-01)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest, { origin: 'https://me:p@ss@SECRET@github.com/career-ops-hq/career-ops.git' });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is https:\/\/github\.com\/career-ops-hq\/career-ops\.git, not the fork/);
  assert.doesNotMatch(r.out, /SECRET|ss@/);
});

test('an existing checkout whose origin holds a credential is refused without printing it (R32-scripts-b-L2-02)', () => {
  const w = world();
  const dest = path.join(w.home, 'career-ops');
  w.makeCheckout(dest, { origin: 'https://me:ghp_SECRET@github.com/career-ops-hq/career-ops.git' });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n', env: { CAREER_OPS_REPO_URL: 'https://you:ghp_OTHER@github.com/Divy2000/career-ops.git' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is https:\/\/github\.com\/career-ops-hq\/career-ops\.git, not the fork https:\/\/github\.com\/Divy2000\/career-ops\.git\./);
  assert.doesNotMatch(r.out, /ghp_/);
});
