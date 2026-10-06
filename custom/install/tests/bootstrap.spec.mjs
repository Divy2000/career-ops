import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorld, BOOTSTRAP_SH, FORK_URL } from './harness.mjs';

function world() {
  const w = makeWorld({ tools: ['git', 'node', 'npm', 'uname'] });
  const installer = path.join(w.fakeSrc, 'custom', 'install', 'install.sh');
  fs.mkdirSync(path.dirname(installer), { recursive: true });
  fs.writeFileSync(installer, '#!/bin/bash\necho "install-sh $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  return w;
}
const source = fs.readFileSync(BOOTSTRAP_SH, 'utf8');

test('the whole body is one function called on the last line', () => {
  const lines = source.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], 'main "$@"');
  assert.equal(lines.filter((l) => /^main\(\) \{/.test(l)).length, 1);
});

test('a download truncated inside main() executes nothing', () => {
  const w = world();
  const cut = source.slice(0, source.indexOf('git clone --branch') + 12);
  const r = spawnSync('bash', [], { input: cut, env: w.env(), encoding: 'utf8', timeout: 30000, detached: true });
  assert.notEqual(r.status, 0);
  assert.equal(w.log().length, 0);
  assert.equal(fs.existsSync(path.join(w.home, 'career-ops')), false);
});

test('a download truncated before the final call defines main and runs nothing', () => {
  const w = world();
  const lines = source.trimEnd().split('\n');
  const cut = `${lines.slice(0, -1).join('\n')}\n`;
  const r = spawnSync('bash', [], { input: cut, env: w.env(), encoding: 'utf8', timeout: 30000, detached: true });
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

test('a failing clone is reported and install.sh never runs', () => {
  const w = world();
  fs.rmSync(path.join(w.bin, 'git')); // a symlink to the shared stub: replace the link, never write through it
  fs.writeFileSync(path.join(w.bin, 'git'), '#!/bin/bash\necho "git $*" >> "$STUB_LOG"\nexit 128\n', { mode: 0o755 });
  const r = w.run([], { script: BOOTSTRAP_SH, tty: 'y\n' });
  assert.notEqual(r.status, 0);
  assert.ok(!w.log().some((l) => l.startsWith('install-sh')));
});
