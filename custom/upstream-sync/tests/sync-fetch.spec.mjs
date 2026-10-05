import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SYNC_DIR, '../..');
const LIB = path.join(SYNC_DIR, 'lib.sh');
const SYNC = path.join(SYNC_DIR, 'sync.sh');
const TAG_ONLY = '+refs/tags/career-ops-v1.35.0:refs/tags/career-ops-v1.35.0';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitFile(repo, rel, text, message) {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

// Two bare remotes (origin = the fork, upstream) and a live checkout whose
// remotes only fetch one tag, like the real live checkout.
function makeWorld({ upstreamAhead = true, upstreamHasMain = true } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'sync-fetch-'));
  const seed = path.join(base, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commitFile(seed, 'base.txt', 'base\n', 'base');
  const originBare = path.join(base, 'origin.git');
  const upstreamBare = path.join(base, 'upstream.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', originBare);
  git(base, 'init', '-q', '--bare', '-b', 'main', upstreamBare);
  git(seed, 'push', '-q', originBare, 'main');
  if (upstreamHasMain) {
    git(seed, 'push', '-q', upstreamBare, 'main');
    if (upstreamAhead) {
      commitFile(seed, 'upstream-only.txt', 'u\n', 'upstream commit');
      git(seed, 'push', '-q', '-f', upstreamBare, 'main');
    }
  }
  const live = path.join(base, 'live');
  git(base, 'clone', '-q', originBare, live);
  git(live, 'remote', 'add', 'upstream', upstreamBare);
  for (const remote of ['origin', 'upstream']) {
    git(live, 'config', `remote.${remote}.fetch`, TAG_ONLY);
    try { git(live, 'update-ref', '-d', `refs/remotes/${remote}/main`); } catch { /* absent is fine */ }
  }
  return { base, live, originBare, upstreamBare };
}

function bashLib(cwd, script, env = {}) {
  return spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8' });
}

function refExists(repo, ref) {
  try { git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; }
}

test('Given a remote whose fetch refspec is tag-only, a plain "git fetch <remote> main" leaves no remote-tracking ref (the bug)', () => {
  const w = makeWorld();
  try {
    git(w.live, 'fetch', '-q', 'upstream', 'main');
    assert.equal(refExists(w.live, 'upstream/main'), false);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('Given a tag-only fetch refspec, fetch_main creates refs/remotes/<remote>/main for upstream and origin', () => {
  const w = makeWorld();
  try {
    for (const remote of ['upstream', 'origin']) {
      const res = bashLib(w.live, `fetch_main ${remote}`);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(refExists(w.live, `${remote}/main`), true, `${remote}/main`);
    }
    assert.equal(git(w.live, 'rev-list', '--count', 'origin/main..upstream/main').trim(), '1');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('Given the remote has no main branch, fetch_main fails loudly and names the remote', () => {
  const w = makeWorld({ upstreamHasMain: false });
  try {
    const res = bashLib(w.live, 'fetch_main upstream');
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /upstream/);
    assert.equal(refExists(w.live, 'upstream/main'), false);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('Given a stale remote-tracking ref, fetch_main does not trust it when the fetch fails', () => {
  const w = makeWorld();
  try {
    assert.equal(bashLib(w.live, 'fetch_main upstream').status, 0);
    git(w.live, 'remote', 'set-url', 'upstream', path.join(w.base, 'does-not-exist.git'));
    const res = bashLib(w.live, 'fetch_main upstream');
    assert.notEqual(res.status, 0, 'a failed fetch must not pass because an old ref exists');
    assert.match(res.stderr, /upstream/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

function npmStubWorld() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-npm-'));
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'npm.log');
  stub(bin, 'npm', `echo "$*" >> "${log}"`);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commitFile(repo, 'package.json', '{"name":"x","version":"1.0.0"}\n', 'pkg');
  return { dir, bin, log, repo, env: { PATH: `${bin}:${process.env.PATH}` } };
}

test('Given no tracked root package-lock.json, install_root_deps (ci mode) runs npm install --no-package-lock --ignore-scripts, never npm ci', () => {
  const w = npmStubWorld();
  try {
    const res = bashLib(w.repo, 'install_root_deps ignore-scripts', w.env);
    assert.equal(res.status, 0, res.stderr);
    const calls = readFileSync(w.log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^install\b/);
    assert.match(calls[0], /--no-package-lock/);
    assert.match(calls[0], /--ignore-scripts/);
    assert.equal(/\bci\b/.test(calls[0]), false);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('Given a tracked root package-lock.json, install_root_deps (ci mode) runs npm ci --ignore-scripts', () => {
  const w = npmStubWorld();
  try {
    commitFile(w.repo, 'package-lock.json', '{}\n', 'lock');
    const res = bashLib(w.repo, 'install_root_deps ignore-scripts', w.env);
    assert.equal(res.status, 0, res.stderr);
    const calls = readFileSync(w.log, 'utf8').trim().split('\n');
    assert.match(calls[0], /^ci\b/);
    assert.match(calls[0], /--ignore-scripts/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('Given an untracked (ignored) package-lock.json on disk, it is not treated as tracked', () => {
  const w = npmStubWorld();
  try {
    writeFileSync(path.join(w.repo, 'package-lock.json'), '{}\n');
    const res = bashLib(w.repo, 'install_root_deps ignore-scripts', w.env);
    assert.equal(res.status, 0, res.stderr);
    assert.match(readFileSync(w.log, 'utf8'), /^install\b.*--no-package-lock/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('install_root_deps (live mode) keeps lifecycle scripts and drops --no-package-lock only when a lock is tracked', () => {
  const w = npmStubWorld();
  try {
    assert.equal(bashLib(w.repo, 'install_root_deps run-scripts', w.env).status, 0);
    let call = readFileSync(w.log, 'utf8').trim();
    assert.match(call, /^install\b/);
    assert.match(call, /--no-package-lock/);
    assert.equal(/--ignore-scripts/.test(call), false);
    rmSync(w.log);
    commitFile(w.repo, 'package-lock.json', '{}\n', 'lock');
    assert.equal(bashLib(w.repo, 'install_root_deps run-scripts', w.env).status, 0);
    call = readFileSync(w.log, 'utf8').trim();
    assert.match(call, /^install\b/);
    assert.equal(/--no-package-lock|--ignore-scripts/.test(call), false);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('install_root_deps fails when npm fails and rejects an unknown mode', () => {
  const w = npmStubWorld();
  try {
    stub(w.bin, 'npm', 'exit 7');
    assert.notEqual(bashLib(w.repo, 'install_root_deps ignore-scripts', w.env).status, 0);
    assert.equal(bashLib(w.repo, 'install_root_deps bogus', w.env).status, 2);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('deps_fingerprint falls back to package.json when the root has no tracked lockfile, and changes with it', () => {
  const w = npmStubWorld();
  try {
    const before = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stderr, '', 'no git error noise');
    assert.match(before.stdout.trim(), /^[0-9a-f]{40}$/);
    commitFile(w.repo, 'package.json', '{"name":"x","version":"2.0.0"}\n', 'bump');
    const after = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.notEqual(after.stdout, before.stdout);
    commitFile(w.repo, 'package-lock.json', '{"a":1}\n', 'lock');
    const withLock = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.equal(withLock.stdout.trim(), git(w.repo, 'rev-parse', 'HEAD:package-lock.json').trim());
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- sync.sh end to end, as far as it can go without Keychain, Claude or network ----

function runSync(world, { home, inherited = {} }) {
  const syncDir = path.join(world.live, 'custom/upstream-sync');
  mkdirSync(syncDir, { recursive: true });
  for (const f of ['sync.sh', 'keep-fork-readme.sh', 'lib.sh', 'sync-prompt.md']) copyFileSync(path.join(SYNC_DIR, f), path.join(syncDir, f));
  mkdirSync(path.join(world.live, 'custom/launchd'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'custom/launchd/pinned-node.sh'), path.join(world.live, 'custom/launchd/pinned-node.sh'));
  copyFileSync(path.join(REPO_ROOT, 'path-resolver.mjs'), path.join(world.live, 'path-resolver.mjs'));
  const bin = path.join(world.base, 'bin');
  // The Keychain is never touched: a stub that finds no item stops the run right after the fetch checks.
  for (const dir of [bin, path.join(home, '.local/bin')]) {
    stub(dir, 'security', 'exit 44');
    stub(dir, 'osascript', 'exit 0');
  }
  // The data root is pinned to the test checkout: one inherited from the shell (or the launchd plist, when the
  // weekly sync runs these specs) would send this run's log into the user's real data/upstream-sync.
  const { CAREER_OPS_DATA_DIR: _dir, CAREER_OPS_TRACKER: _tracker, ...env } = { ...GIT_ENV, ...inherited };
  const res = spawnSync('bash', [path.join(syncDir, 'sync.sh'), '--no-merge'], {
    cwd: world.live,
    env: { ...env, CAREER_OPS_ROOT: world.live, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const logDir = path.join(world.live, 'data/upstream-sync');
  const logName = existsSync(logDir) ? readdirSync(logDir).find((n) => n.endsWith('.log')) : null;
  return { ...res, log: logName ? readFileSync(path.join(logDir, logName), 'utf8') : '' };
}

test('sync.sh with tag-only remotes fetches main explicitly and computes BEHIND before going on', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home });
    assert.match(res.log, /fork is 1 commit\(s\) behind upstream\/main/, res.log);
    assert.equal(/Not a valid object name/.test(res.log + res.stderr), false);
    assert.match(res.log, /Keychain item career-ops-claude-token not found/, 'the run got past the fetch checks');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('sync.sh stops loudly naming the remote when upstream has no main, and never prints a blank BEHIND', () => {
  const w = makeWorld({ upstreamHasMain: false });
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /!!! .*upstream/, res.log);
    assert.equal(/commit\(s\) behind/.test(res.log), false);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('sync.sh reports "nothing to do" and exits 0 when the fork already contains upstream/main', () => {
  const w = makeWorld({ upstreamAhead: false });
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home });
    assert.equal(res.status, 0, res.log);
    assert.match(res.log, /nothing to do/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('sync.sh uses the shared helpers: no bare "git fetch upstream main", no unconditional root npm ci, no raw lockfile rev-parse', () => {
  const sync = readFileSync(SYNC, 'utf8');
  assert.match(sync, /source .*lib\.sh/);
  assert.equal(/git fetch -q (upstream|origin) main/.test(sync), false);
  assert.equal(/npm ci/.test(sync.replace(/"Bash\(npm ci:\*\)"/, '')), false, 'root installs go through install_root_deps');
  assert.equal(/rev-parse HEAD:package-lock\.json/.test(sync), false);
  assert.match(sync, /install_root_deps ignore-scripts/);
  assert.match(sync, /deps_fingerprint/);
  assert.match(sync, /\^\[0-9\]\+\$/, 'BEHIND is checked to be numeric');
});

test('Given the shell exports a data root (as the launchd plist does), sync.sh under test still logs to the test checkout and never into that root', () => {
  const w = makeWorld({ upstreamAhead: false });
  const home = path.join(w.base, 'home');
  const decoy = path.join(w.base, 'real-data-root');
  mkdirSync(home);
  mkdirSync(decoy);
  try {
    const res = runSync(w, { home, inherited: { CAREER_OPS_ROOT: decoy, CAREER_OPS_DATA_DIR: decoy, CAREER_OPS_TRACKER: path.join(decoy, 'applications.md') } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.log, /nothing to do/);
    assert.deepEqual(readdirSync(decoy), []);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('Given the plist pins a node (CC_NODE_BIN), sync.sh resolves the data root with it, though Homebrew comes first on its PATH', () => {
  const w = makeWorld({ upstreamAhead: false });
  const home = path.join(w.base, 'home');
  const pinned = path.join(w.base, 'pinned');
  const calls = path.join(w.base, 'pinned-node.log');
  mkdirSync(home);
  stub(pinned, 'node', `echo "$*" >> "${calls}"\nexec "${process.execPath}" "$@"`);
  try {
    const res = runSync(w, { home, inherited: { CC_NODE_BIN: path.join(pinned, 'node') } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.log, /nothing to do/);
    assert.match(existsSync(calls) ? readFileSync(calls, 'utf8') : '', /path-resolver\.mjs/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
