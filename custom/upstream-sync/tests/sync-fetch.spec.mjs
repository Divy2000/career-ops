import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, chmodSync, existsSync, rmSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../test-support/tmp.mjs';
import { gitTestEnv } from '../../test-support/git-env.mjs';
// The real lock writer's start time, so a running-Control-Center lock carries what acquireInstanceLock writes.
import { processStartTime } from '../../control-center/supervisor/instance-lock.ts';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(SYNC_DIR, '../..');
const LIB = path.join(SYNC_DIR, 'lib.sh');
const SYNC = path.join(SYNC_DIR, 'sync.sh');
const TAG_ONLY = '+refs/tags/career-ops-v1.35.0:refs/tags/career-ops-v1.35.0';

const GIT_ENV = gitTestEnv();

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

test('deps_fingerprint falls back to package.json when the root has no tracked lockfile, and changes with its dependencies', () => {
  const w = npmStubWorld();
  try {
    const before = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.equal(before.status, 0, before.stderr);
    assert.equal(before.stderr, '', 'no git error noise');
    assert.match(before.stdout.trim(), /^[0-9a-f]{40}$/);
    commitFile(w.repo, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^1.0.0"}}\n', 'add a dependency');
    const after = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.notEqual(after.stdout, before.stdout);
    commitFile(w.repo, 'package-lock.json', '{"a":1}\n', 'lock');
    const withLock = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.equal(withLock.stdout.trim(), git(w.repo, 'rev-parse', 'HEAD:package-lock.json').trim());
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- sync.sh end to end, as far as it can go without Keychain, Claude or network ----

function runSync(world, { home, inherited = {}, security = 'exit 44', osascript = 'exit 0' }) {
  const syncDir = path.join(world.live, 'custom/upstream-sync');
  mkdirSync(syncDir, { recursive: true });
  for (const f of ['sync.sh', 'keep-fork-readme.sh', 'lib.sh', 'sync-prompt.md']) copyFileSync(path.join(SYNC_DIR, f), path.join(syncDir, f));
  mkdirSync(path.join(world.live, 'custom/launchd'), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'custom/launchd/pinned-node.sh'), path.join(world.live, 'custom/launchd/pinned-node.sh'));
  copyFileSync(path.join(REPO_ROOT, 'path-resolver.mjs'), path.join(world.live, 'path-resolver.mjs'));
  const bin = path.join(world.base, 'bin');
  // The Keychain is never touched: a stub that finds no item stops the run right after the fetch checks.
  for (const dir of [bin, path.join(home, '.local/bin')]) {
    stub(dir, 'security', security);
    stub(dir, 'osascript', osascript);
  }
  // The data root is pinned to the test checkout: one inherited from the shell (or the launchd plist, when the
  // weekly sync runs these specs) would send this run's log into the user's real data/upstream-sync.
  // Anthropic and Claude Code variables the shell running these specs exports (Claude Code sets several) are dropped
  // too, so a run sees only the ones a test passes in and its assertions never depend on the host.
  const hostEnv = Object.fromEntries(Object.entries(GIT_ENV).filter(([n]) => !/^(ANTHROPIC_|CLAUDE_CODE_)/.test(n)));
  const { CAREER_OPS_DATA_DIR: _dir, CAREER_OPS_TRACKER: _tracker, CC_NODE_BIN: _node, ...env } = { ...hostEnv, ...inherited };
  // The node running these specs, pinned as the plist pins one: sync.sh puts Homebrew's folders first on its PATH.
  // Only a test's own inherited pin replaces it, never one from the shell or the plist that runs these specs.
  const childEnv = { ...env, CC_NODE_BIN: inherited.CC_NODE_BIN ?? process.execPath, CAREER_OPS_ROOT: world.live, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const res = spawnCpuLimited('bash', [path.join(syncDir, 'sync.sh'), '--no-merge'], {
    cwd: world.live,
    env: childEnv,
    encoding: 'utf8',
  });
  const logDir = path.join(world.live, 'data/upstream-sync');
  const logName = existsSync(logDir) ? readdirSync(logDir).find((n) => n.endsWith('.log')) : null;
  return { ...res, env: childEnv, log: logName ? readFileSync(path.join(logDir, logName), 'utf8') : '' };
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
  assert.match(sync, /update_live_checkout/, 'the live checkout is updated through the tested helper, which reinstalls only on a dependency change');
  assert.match(sync, /\^\[0-9\]\+\$/, 'BEHIND is checked to be numeric');
});

// The real AppleScript compiler, minus the notification: "display notification X with title Y" becomes "return X",
// so the text the user would see is printed, and a message that breaks the script fails to compile as it does live.
const COMPILING_OSASCRIPT = (shown) => `args=()
for a in "$@"; do
  a="\${a//display notification/return}"
  args+=("\${a%% with title *}")
done
/usr/bin/osascript "\${args[@]}" >> "${shown}"`;

test('Given contract.json is unparseable, when the sync gate fails with JSON.parse text holding double quotes, then the notification still shows that text (R33-scripts-b-L2-01)', { skip: process.platform !== 'darwin' && 'osascript is macOS only' }, () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const shown = path.join(w.base, 'shown.txt');
  mkdirSync(home);
  try {
    const claudeDir = path.join(w.live, 'custom/control-center/server/claude');
    mkdirSync(claudeDir, { recursive: true });
    copyFileSync(path.join(REPO_ROOT, 'custom/control-center/server/claude/confinement.mjs'), path.join(claudeDir, 'confinement.mjs'));
    mkdirSync(path.join(w.live, 'custom/control-center/server/core'), { recursive: true });
    writeFileSync(path.join(w.live, 'custom/control-center/server/core/contract.json'), '<<<<<<< HEAD\n{}\n');
    stub(path.join(w.base, 'claude-bin'), 'claude', 'echo "2.1.300 (Claude Code)"');
    const res = runSync(w, {
      home,
      inherited: { CC_CLAUDE_BIN: path.join(w.base, 'claude-bin', 'claude') },
      security: 'echo test-token',
      osascript: COMPILING_OSASCRIPT(shown),
    });
    assert.equal(res.status, 1, res.log);
    const failure = res.log.match(/^!!! (.*)$/m)?.[1];
    assert.match(failure ?? '', /cannot check claude .* against the approved Claude Code versions: .*"/, res.log);
    assert.equal(readFileSync(shown, 'utf8').replace(/ \(log: data\/upstream-sync\/\d{4}-\d{2}-\d{2}\.log\)\n$/, ''), failure);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('Given the shell exports a data root (as the launchd plist does), the runSync harness keeps sync.sh under test logging to the test checkout and never into that root', () => {
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

test('Given the plist pins a data root (CAREER_OPS_*), sync.sh logs there but every later child, the worktree suites included, runs without it (SW10-scripts-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const seen = path.join(w.base, 'security-env.txt');
  mkdirSync(home);
  try {
    // The Keychain lookup is the first child after the data root is resolved; it records what it inherits and stops the run.
    const res = runSync(w, { home, inherited: { CAREER_OPS_PDF_INDEX: path.join(w.live, 'data/pdf-index.tsv') }, security: `env | grep '^CAREER_OPS_' > "${seen}"\nexit 44` });
    assert.equal(res.env.CAREER_OPS_ROOT, w.live, 'the run starts with a pinned data root');
    assert.match(res.log, /Keychain item career-ops-claude-token not found/, 'the log still goes to the pinned root');
    assert.equal(readFileSync(seen, 'utf8'), '');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a sync started while another holds the run lock is refused before it touches that run\'s worktree (R11-scripts-b-L1-02)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const wt = path.join(home, '.career-ops-sync');
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, 'mid-suite.txt'), 'the scheduled run is still testing here\n');
  // The Keychain lookup is the last step before the run replaces the worktree. A run that got past the lock records
  // it there and stops, so a regressed lock never reaches the worktree removal or npm (sync.sh puts Homebrew's
  // folders ahead of any stub on its PATH, so a stubbed npm would not be the one that runs).
  const passedLock = path.join(w.base, 'passed-lock');
  const ready = path.join(w.base, 'holder-ready');
  // The scheduled run, still going: it holds the lock while the manual run starts. Its own process group, so the
  // cleanup kills the shell and its sleep along with lockf.
  const holder = spawn('/usr/bin/lockf', ['-k', '-t', '0', path.join(home, '.career-ops-sync.lockf'), '/bin/sh', '-c', `touch "${ready}"; sleep 60`], { stdio: 'ignore', detached: true });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
    assert.ok(existsSync(ready), 'the holder never took the lock');
    const res = runSync(w, { home, security: `touch "${passedLock}"\nexit 44` });
    assert.equal(existsSync(passedLock), false, 'the run went past the held lock');
    assert.equal(res.status, 75, res.log + res.stderr);
    assert.match(res.stderr, /another upstream sync is running \(it holds .*\.career-ops-sync\.lockf\); not started/);
    assert.match(res.log, /another upstream sync is running .*; not started/);
    assert.equal(readFileSync(path.join(wt, 'mid-suite.txt'), 'utf8'), 'the scheduled run is still testing here\n');
  } finally {
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('the lock marker the re-exec sets stays out of every child of the locked run, so a test run inside the weekly sync still exercises the lock (R15-scripts-b-L1-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const seen = path.join(w.base, 'security-env.txt');
  mkdirSync(home);
  try {
    // The Keychain lookup runs inside the locked run; it records what it inherits and stops the run.
    const res = runSync(w, { home, security: `env | grep '^CC_SYNC_LOCKED=' > "${seen}"\nexit 44` });
    assert.match(res.log, /Keychain item career-ops-claude-token not found/, res.log + res.stderr);
    assert.equal(readFileSync(seen, 'utf8'), '');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('inherited Anthropic credentials are dropped before any child of the sync runs; the Keychain token goes only to claude (R31-scripts-b-X-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const seen = path.join(w.base, 'security-env.txt');
  mkdirSync(home);
  try {
    const inherited = {
      ANTHROPIC_API_KEY: 'sk-api', ANTHROPIC_AUTH_TOKEN: 'sk-auth', ANTHROPIC_BASE_URL: 'https://proxy.invalid',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth', CLAUDE_CODE_API_KEY_HELPER: 'x', CLAUDE_CODE_EFFORT_LEVEL: 'low',
      // Settings whose names only contain a credential word (TOKENS is not the TOKEN segment) are not credentials.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', CLAUDE_CODE_ENTRYPOINT: 'cli',
    };
    const res = runSync(w, { home, inherited, security: `env > "${seen}"\nexit 44` });
    assert.match(res.log, /Keychain item career-ops-claude-token not found/, res.log + res.stderr);
    // Names only: the values in this environment can be the developer's real credentials.
    const names = readFileSync(seen, 'utf8').split('\n').map((l) => l.split('=')[0]);
    // The credential rule sync.sh applies: any ANTHROPIC_* name, or a CLAUDE_CODE_* name with a credential segment.
    const credential = /^ANTHROPIC_|^CLAUDE_CODE_(.*_)?(TOKEN|KEY|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|CERT|HEADERS?)(_|$)/;
    assert.deepEqual(names.filter((n) => credential.test(n)), []);
    for (const kept of ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_ENTRYPOINT']) {
      assert.ok(names.includes(kept), `the non-credential setting ${kept} is kept`);
    }
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('an inherited exported TOKEN never carries the Keychain token to the children that run after the read (R31-scripts-b-L2-02)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const seen = path.join(w.base, 'claude-env.txt');
  mkdirSync(home);
  const old = path.join(w.base, 'old-claude');
  // claude --version is the first child after the read; it records what it inherits, then fails the version floor.
  stub(old, 'claude', `env > "${seen}"\necho "2.1.200 (Claude Code)"`);
  try {
    const res = runSync(w, { home, security: 'echo tok-secret', inherited: { TOKEN: 'inherited', CC_CLAUDE_BIN: path.join(old, 'claude') } });
    assert.match(res.log, /older than 2\.1\.288/, res.log + res.stderr);
    assert.doesNotMatch(readFileSync(seen, 'utf8'), /tok-secret/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a sync whose claude is too old to keep the token out of hooks and tools stops before it touches the worktree (R15-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  const wt = path.join(home, '.career-ops-sync');
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, 'kept.txt'), 'an earlier run\n');
  const old = path.join(w.base, 'old-claude');
  stub(old, 'claude', 'echo "2.1.200 (Claude Code)"');
  try {
    const res = runSync(w, { home, security: 'echo tok-123', inherited: { CC_CLAUDE_BIN: path.join(old, 'claude') } });
    assert.equal(res.status, 1, res.log + res.stderr);
    assert.match(res.log, /^!!! Claude Code 2\.1\.200 at .*old-claude\/claude is older than 2\.1\.288/m);
    assert.equal(readFileSync(path.join(wt, 'kept.txt'), 'utf8'), 'an earlier run\n');
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

// ---- the gates that stop the sync before anything is pushed ----

/** A sync worktree on `sync/x` from main, with upstream/main one commit ahead; `merged` merges it in. */
function verifyWorld({ merged = true, conflict = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'sync-verify-'));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commitFile(repo, 'shared.txt', 'base\n', 'base');
  git(repo, 'checkout', '-q', '-b', 'up');
  commitFile(repo, 'shared.txt', 'upstream\n', 'upstream');
  git(repo, 'update-ref', 'refs/remotes/upstream/main', 'up');
  git(repo, 'checkout', '-q', '-b', 'sync/x', 'main');
  if (conflict) {
    commitFile(repo, 'shared.txt', 'fork\n', 'fork');
    spawnSync('git', ['merge', '-q', 'upstream/main'], { cwd: repo, env: GIT_ENV });
  } else if (merged) git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'upstream/main');
  return { base, repo, verify: () => bashLib(repo, 'verify_merge sync/x') };
}

test('verify_merge passes a finished merge of upstream/main, untracked files and all', () => {
  const w = verifyWorld();
  try {
    writeFileSync(path.join(w.repo, 'untracked.log'), 'x\n');
    const res = w.verify();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(res.stdout, '');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('verify_merge stops on unmerged paths', () => {
  const w = verifyWorld({ conflict: true });
  try {
    const res = w.verify();
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), 'unmerged paths remain after Claude');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('verify_merge stops when upstream/main is not merged into the branch', () => {
  const w = verifyWorld({ merged: false });
  try {
    const res = w.verify();
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), 'upstream/main is not merged into sync/x');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('verify_merge stops on uncommitted changes to tracked files', () => {
  const w = verifyWorld();
  try {
    writeFileSync(path.join(w.repo, 'shared.txt'), 'edited after the merge\n');
    const res = w.verify();
    assert.equal(res.status, 1);
    assert.equal(res.stdout.trim(), 'uncommitted changes left in the sync worktree');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('sync.sh stops the run through verify_merge before it pushes', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const gate = sync.indexOf('GATE="$(verify_merge "$BRANCH")" || fail "$GATE"');
  assert.ok(gate > sync.indexOf('echo "--- verifying"') && gate < sync.indexOf('git push'), `verify_merge at ${gate}`);
});

// ---- which upstream edits hold the PR: only this run's, outside the conflicts ----

/**
 * A fork whose main already carries an edit to the upstream file scan.mjs, kept by an earlier sync, and an upstream
 * one commit ahead. `conflict` makes upstream edit scan.mjs too. The sync branch merges upstream; `claude(repo)` then
 * stands in for the headless pass. Returns what sync.sh's own lines decide is an unexpected upstream edit.
 */
function heldUpstream({ conflict = false, claude = () => {}, tamper = (snap) => snap, failing = false, forkFiles = {} } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'sync-held-'));
  const repo = path.join(base, 'repo');
  const state = path.join(base, 'state');
  mkdirSync(repo);
  mkdirSync(state);
  try {
    git(repo, 'init', '-q', '-b', 'main');
    commitFile(repo, 'scan.mjs', 'upstream scan\n', 'upstream base');
    commitFile(repo, 'other.mjs', 'upstream other\n', 'upstream other');
    git(repo, 'checkout', '-q', '-b', 'up');
    if (conflict) commitFile(repo, 'scan.mjs', 'upstream scan v2\n', 'upstream edits scan');
    else commitFile(repo, 'new.mjs', 'upstream new\n', 'upstream adds a file');
    git(repo, 'update-ref', 'refs/remotes/upstream/main', 'up');
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'scan.mjs', 'fork scan\n', 'an earlier sync kept a fork edit');
    for (const [rel, text] of Object.entries(forkFiles)) commitFile(repo, rel, text, `fork ${rel}`);
    git(repo, 'checkout', '-q', '-b', 'sync/x');
    const merged = spawnSync('git', ['merge', '-q', '--no-ff', '--no-edit', 'upstream/main'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
    assert.equal(merged.status === 0, !conflict, merged.stderr);
    const lines = readFileSync(SYNC, 'utf8').split('\n');
    const snapshot = lines.find((l) => l.startsWith('MERGE_SNAPSHOT="$(merge_snapshot)"'));
    assert.ok(snapshot, 'sync.sh takes no MERGE_SNAPSHOT before Claude');
    const from = lines.findIndex((l) => l.startsWith('CHANGED_UPSTREAM="$(git diff'));
    const protectedAt = lines.findIndex((l) => l.startsWith('PROTECTED_EDITS='));
    const to = protectedAt > -1 ? protectedAt : lines.findIndex((l) => l.startsWith('UNEXPECTED_UPSTREAM='));
    assert.ok(from > -1 && to > from, 'the CHANGED_UPSTREAM .. UNEXPECTED_UPSTREAM block was not found');
    const vars = `STATE_DIR="${state}" TODAY=2026-10-05 CONFLICTS="$(git diff --name-only --diff-filter=U)"\nfail() { echo "!!! $1"; exit 1; }\n`;
    const before = bashLib(repo, `${vars}${snapshot}\nprintf '%s\\0%s' "$CONFLICTS" "$MERGE_SNAPSHOT"`);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    const [conflicts, taken] = before.stdout.split('\0');
    // Nothing on disk for the sync Claude (Write and Edit, --add-dir STATE_DIR) to rewrite or delete.
    assert.deepEqual(readdirSync(state), []);
    claude(repo);
    // The snapshot crosses into the second shell the way it stays in sync.sh's memory: as a variable.
    const after = bashLib(repo, `STATE_DIR="${state}" TODAY=2026-10-05 CONFLICTS="${conflicts}"\nfail() { echo "!!! $1" >&2; exit 1; }\n{\n${lines.slice(from, to + 1).join('\n')}\n} >/dev/null\nprintf '%s\\0%s' "$UNEXPECTED_UPSTREAM" "\${PROTECTED_EDITS-}"`, { MERGE_SNAPSHOT: tamper(taken) });
    if (!failing) assert.equal(after.status, 0, after.stderr);
    const [unexpected, guarded = ''] = after.stdout.split('\0');
    return { conflicts, status: after.status, unexpected, protectedEdits: guarded, stderr: after.stderr, differs: git(repo, 'diff', '--name-only', 'upstream/main', 'HEAD').trim() };
  } finally { rmSync(base, { recursive: true, force: true }); }
}

test('a fork edit to an upstream file kept by an earlier sync does not hold a clean merge', () => {
  const r = heldUpstream();
  assert.equal(r.differs, 'scan.mjs', 'the earlier fork edit still differs from upstream');
  assert.equal(r.unexpected, '');
});

test('an edit after the merge to an upstream file that did not conflict holds the PR', () => {
  const r = heldUpstream({ claude: (repo) => commitFile(repo, 'other.mjs', 'patched by the pass\n', 'fix(custom): sneaky') });
  assert.equal(r.unexpected, 'other.mjs');
});

test('an upstream file the pass adds or deletes after the merge holds the PR too', () => {
  const r = heldUpstream({
    claude: (repo) => {
      git(repo, 'rm', '-q', 'new.mjs');
      commitFile(repo, 'added.mjs', 'x\n', 'add and delete');
    },
  });
  assert.equal(r.unexpected, 'added.mjs\nnew.mjs');
});

test('a fix to fork code under custom/ that no gate or guard covers holds nothing', () => {
  const r = heldUpstream({ claude: (repo) => commitFile(repo, 'custom/a.mjs', 'fix\n', 'fix(custom): follow upstream') });
  assert.equal(r.unexpected, '');
  assert.equal(r.protectedEdits, '');
});

test('edits after the merge to fork specs, the sync\'s own gates, the guard or the fork README hold the PR and are named (SW4-scripts-02)', () => {
  const edits = ['custom/a/tests/x.spec.mjs', 'custom/control-center/tests/unit/contract.test.ts', 'custom/control-center/server/claude/guard-policy.mjs', 'custom/upstream-sync/lib.sh', 'custom/test-support/tmp.mjs', 'custom/launchd/install.sh', 'custom/immigration/run-daily.sh', '.github/README.md'];
  const r = heldUpstream({ claude: (repo) => { for (const f of edits) commitFile(repo, f, 'weakened\n', `fix(custom): ${f}`); } });
  assert.equal(r.unexpected, '', 'none of them is an upstream file');
  assert.equal(r.protectedEdits, [...edits].sort().join('\n'));
});

test('resolving a conflict is allowed, but an upstream file slipped into the merge commit beside it holds the PR', () => {
  const resolve = (extra) => (repo) => {
    writeFileSync(path.join(repo, 'scan.mjs'), 'resolved\n');
    if (extra) writeFileSync(path.join(repo, 'other.mjs'), 'slipped in\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--no-edit');
  };
  const clean = heldUpstream({ conflict: true, claude: resolve(false) });
  assert.equal(clean.conflicts, 'scan.mjs');
  assert.equal(clean.unexpected, '');
  assert.equal(heldUpstream({ conflict: true, claude: resolve(true) }).unexpected, 'other.mjs');
});

test('sync.sh records the merge result in memory after the README step and before Claude runs, and fails the run when it cannot', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const snap = sync.indexOf('MERGE_SNAPSHOT="$(merge_snapshot)" || fail ');
  assert.ok(snap > sync.indexOf('keep-fork-readme.sh" "$STATE_DIR"') && snap < sync.indexOf('"$CLAUDE_BIN" -p'), `merge_snapshot at ${snap}`);
  assert.equal(/merge-snapshot|merge_snapshot >/.test(sync), false, 'the snapshot is never written to a file');
});

test('a missing merge snapshot fails the run: it never reads as "nothing changed" and auto-merges', () => {
  const r = heldUpstream({ tamper: () => '', failing: true });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^!!! /m);
  assert.equal(r.unexpected, '');
});

test('a snapshot that no longer matches the merge holds the PR for every path it disagrees on', () => {
  const r = heldUpstream({ tamper: (snap) => snap.replace(/^other\.mjs\t(\S+) \S+$/m, 'other.mjs\t$1 0000000000000000000000000000000000000000') });
  assert.equal(r.unexpected, 'other.mjs');
});

test('merge_snapshot and changed_since_snapshot fail, not print nothing, when they cannot do their job', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'sync-snap-'));
  try {
    assert.notEqual(bashLib(base, 'merge_snapshot').status, 0, 'outside a git repository');
    git(base, 'init', '-q', '-b', 'main');
    assert.notEqual(bashLib(base, 'merge_snapshot').status, 0, 'an index with nothing in it');
    commitFile(base, 'a.txt', 'a\n', 'a');
    assert.notEqual(bashLib(base, 'changed_since_snapshot ""').status, 0, 'an empty snapshot');
    const snap = bashLib(base, 'merge_snapshot');
    assert.equal(snap.status, 0, snap.stderr);
    const same = bashLib(base, 'changed_since_snapshot "$S"', { S: snap.stdout });
    assert.equal(same.status, 0, same.stderr);
    assert.equal(same.stdout, '');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- the merged tree is tested with the dependencies it will merge ----

test('sync.sh keeps the baseline dependency tree in memory before Claude, then cleans the worktree and reinstalls after verify_merge, before any post-merge test', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const install = sync.indexOf('install_root_deps ignore-scripts >/dev/null 2>&1 || fail "installing root dependencies failed on origin/main"');
  const tree = sync.indexOf('BASE_DEPS_TREE="$(root_deps_tree)" || fail ');
  const claude = sync.indexOf('"$CLAUDE_BIN" -p');
  const gate = sync.indexOf('GATE="$(verify_merge "$BRANCH")"');
  const clean = sync.indexOf('clean_sync_worktree "$WT" || fail ');
  const refresh = sync.indexOf('refresh_root_deps "$BASE_REV" "$BASE_DEPS_TREE" || fail ');
  const added = sync.indexOf('git worktree add -q -B "$BRANCH" "$WT" origin/main');
  const baseRev = sync.indexOf('BASE_REV="$(git rev-parse HEAD)" || fail ');
  assert.ok(added > -1 && baseRev > sync.indexOf('cd "$WT"', added) && baseRev < claude, `worktree=${added} BASE_REV=${baseRev} claude=${claude}`);
  const custom = sync.indexOf('custom_tests "$STATE_DIR/$TODAY.custom-tests.txt"');
  assert.ok(install > -1 && tree > install && claude > tree, `install=${install} tree=${tree} claude=${claude}`);
  assert.ok(gate > claude && clean > gate && refresh > clean && custom > refresh, `verify=${gate} clean=${clean} refresh=${refresh} custom=${custom}`);
});

/**
 * Runs sync.sh's own lines from just after verify_merge through the dependency reinstall, in the sync worktree `w.repo`
 * whose origin/main is HEAD unless a test moves it. The npm stub records each call and whether it saw a project .npmrc
 * and a package-lock.json (copied aside).
 */
function syncDepsStep(w, env = {}) {
  if (!refExists(w.repo, 'refs/remotes/origin/main')) git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The base sync.sh recorded before Claude ran: origin/main as it was then, unless a test says otherwise.
  const baseRev = env.BASE_REV ?? git(w.repo, 'rev-parse', 'refs/remotes/origin/main').trim();
  stub(w.bin, 'npm', `echo "$*" >> "${w.log}"\n[ -e .npmrc ] && echo "saw .npmrc" >> "${w.log}"\n[ -e package-lock.json ] && cp package-lock.json "${w.dir}/lock-seen.json"\n${env.NPM_EXIT ? `exit ${env.NPM_EXIT}` : 'exit 0'}`);
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('GATE="$(verify_merge'));
  const to = lines.findIndex((l, i) => i > from && l.startsWith('refresh_root_deps '));
  assert.ok(from > -1 && to > from, 'no verify_merge .. refresh_root_deps block in sync.sh');
  const script = `WT="${w.repo}"\nfail() { echo "!!! $1" >&2; exit 1; }\n${lines.slice(from + 1, to + 1).join('\n')}`;
  return bashLib(w.repo, script, { ...w.env, BASE_DEPS_TREE: '{"lockfileVersion":3,"packages":{"node_modules/leftish":{"version":"1.0.0"}}}', ...env, BASE_REV: baseRev });
}

const npmCalls = (w) => readFileSync(w.log, 'utf8').trim().split('\n');

test('a node_modules the sync Claude changed is thrown away and reinstalled, though package.json did not change', () => {
  const w = npmStubWorld();
  try {
    const tampered = path.join(w.repo, 'node_modules', 'js-yaml', 'index.js');
    mkdirSync(path.dirname(tampered), { recursive: true });
    writeFileSync(tampered, 'module.exports = "patched by the pass";\n');
    const res = syncDepsStep(w);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(tampered), false, 'the old tree is gone (the npm stub installs nothing)');
    assert.equal(npmCalls(w).filter((c) => /^(ci|install)\b/.test(c)).length, 1);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('with the dependencies unchanged by the merge, the reinstall is npm ci of the baseline tree, and the temporary lockfile is removed', () => {
  const w = npmStubWorld();
  try {
    const res = syncDepsStep(w);
    assert.equal(res.status, 0, res.stderr);
    assert.match(npmCalls(w)[0], /^ci\b.*--ignore-scripts/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(w.dir, 'lock-seen.json'), 'utf8')), { lockfileVersion: 3, packages: { 'node_modules/leftish': { version: '1.0.0' } } });
    assert.equal(existsSync(path.join(w.repo, 'package-lock.json')), false);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('with the dependencies changed by the merge, they are resolved fresh', () => {
  const w = npmStubWorld();
  try {
    git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    commitFile(w.repo, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^1.0.0"}}\n', 'upstream adds a dependency');
    const res = syncDepsStep(w);
    assert.equal(res.status, 0, res.stderr);
    assert.match(npmCalls(w)[0], /^install\b.*--no-package-lock.*--ignore-scripts/);
    assert.equal(existsSync(path.join(w.dir, 'lock-seen.json')), false);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('an unchanged-dependencies reinstall with no baseline tree fails the run instead of resolving fresh', () => {
  const w = npmStubWorld();
  try {
    const res = syncDepsStep(w, { BASE_DEPS_TREE: '' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^!!! /m);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a failed reinstall after Claude fails the run, and leaves no temporary lockfile', () => {
  const w = npmStubWorld();
  try {
    const res = syncDepsStep(w, { NPM_EXIT: '7' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^!!! /m);
    assert.equal(existsSync(path.join(w.repo, 'package-lock.json')), false);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('files the sync Claude left untracked or ignored are gone before the reinstall and the tests: a project .npmrc, a stray spec', () => {
  const w = npmStubWorld();
  try {
    writeFileSync(path.join(w.repo, '.gitignore'), 'node_modules\n.npmrc\n');
    git(w.repo, 'add', '.gitignore');
    git(w.repo, 'commit', '-q', '-m', 'ignore');
    writeFileSync(path.join(w.repo, '.npmrc'), 'registry=http://attacker.invalid/\n');
    mkdirSync(path.join(w.repo, 'custom', 'evil', 'tests'), { recursive: true });
    writeFileSync(path.join(w.repo, 'custom', 'evil', 'tests', 'pass.spec.mjs'), "import { test } from 'node:test';\ntest('always passes', () => {});\n");
    const res = syncDepsStep(w);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(readFileSync(w.log, 'utf8'), /saw \.npmrc/);
    assert.equal(existsSync(path.join(w.repo, '.npmrc')), false);
    assert.equal(existsSync(path.join(w.repo, 'custom', 'evil')), false);
    assert.equal(existsSync(path.join(w.repo, '.gitignore')), true, 'tracked files stay');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('clean_sync_worktree refuses to clean anything but the sync worktree it is given', () => {
  const w = npmStubWorld();
  try {
    writeFileSync(path.join(w.repo, 'untracked.txt'), 'keep\n');
    const res = bashLib(w.repo, `clean_sync_worktree "${w.dir}"`, w.env);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /not the sync worktree/);
    assert.equal(existsSync(path.join(w.repo, 'untracked.txt')), true);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- the reinstall against a real npm and a local registry whose range moves on ----

const execFileP = promisify(execFile);

/** A registry on a free loopback port serving `leftish`: 1.0.0, and 1.1.0 too once release() is called. */
async function fakeRegistry(dir) {
  const tarballs = {};
  for (const v of ['1.0.0', '1.1.0']) {
    const src = path.join(dir, `src-${v}`, 'package');
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'leftish', version: v, main: 'index.js' }));
    writeFileSync(path.join(src, 'index.js'), `module.exports = ${JSON.stringify(v)};\n`);
    const tgz = path.join(dir, `leftish-${v}.tgz`);
    execFileSync('tar', ['-czf', tgz, '-C', path.dirname(src), 'package']);
    tarballs[v] = readFileSync(tgz);
  }
  let versions = ['1.0.0'];
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/leftish') {
      const doc = { name: 'leftish', 'dist-tags': { latest: versions.at(-1) }, versions: {} };
      for (const v of versions) {
        doc.versions[v] = { name: 'leftish', version: v, main: 'index.js', dist: { tarball: `${base}/leftish/-/leftish-${v}.tgz`, shasum: createHash('sha1').update(tarballs[v]).digest('hex'), integrity: `sha512-${createHash('sha512').update(tarballs[v]).digest('base64')}` } };
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify(doc));
    }
    const m = /^\/leftish\/-\/leftish-(.+)\.tgz$/.exec(req.url);
    if (m && versions.includes(m[1])) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(tarballs[m[1]]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, release: () => { versions = ['1.0.0', '1.1.0']; }, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('with the dependencies unchanged, a registry that moved on since the baseline does not change what the merged tree is tested with', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-registry-'));
  const registry = await fakeRegistry(dir);
  try {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules\npackage-lock.json\n');
    commitFile(repo, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^1.0.0"}}\n', 'pkg');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // npm keeps a compile cache in TMPDIR: it gets its own, inside this test's folder.
    mkdirSync(path.join(dir, 'tmp'));
    const env = { ...GIT_ENV, HOME: dir, TMPDIR: path.join(dir, 'tmp'), npm_config_registry: registry.url, npm_config_cache: path.join(dir, 'npm-cache'), npm_config_prefer_online: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    const lines = readFileSync(SYNC, 'utf8').split('\n');
    const take = (prefix) => {
      const line = lines.find((l) => l.startsWith(prefix));
      assert.ok(line, `no line starting ${prefix} in sync.sh`);
      return line;
    };
    const bash = (script, extra = {}) => execFileP('bash', ['-c', `source "${LIB}"\nWT="${repo}"\nfail() { echo "!!! $1" >&2; exit 1; }\n${script}`], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
    const installed = () => JSON.parse(readFileSync(path.join(repo, 'node_modules', 'leftish', 'package.json'), 'utf8')).version;
    const before = await bash(`${take('install_root_deps ignore-scripts')}\n${take('BASE_DEPS_TREE=')}\nprintf '%s' "$BASE_DEPS_TREE"`);
    assert.equal(installed(), '1.0.0');
    registry.release();
    const baseRev = git(repo, 'rev-parse', 'HEAD').trim();
    const refresh = () => bash(take('refresh_root_deps '), { BASE_DEPS_TREE: before.stdout, BASE_REV: baseRev });
    await refresh();
    assert.equal(installed(), '1.0.0', 'the baseline tree, not the newer 1.1.0 the range now resolves to');
    commitFile(repo, 'package.json', '{"name":"x","version":"1.0.1","scripts":{"test":"node --test"},"engines":{"node":">=22"},"dependencies":{"leftish":"^1.0.0"}}\n', 'upstream release bot bumps the version; a PR edits scripts and engines');
    await refresh();
    assert.equal(installed(), '1.0.0', 'a version, scripts or engines edit is not a dependency change');
    commitFile(repo, 'package.json', '{"name":"x","version":"1.0.1","scripts":{"test":"node --test"},"engines":{"node":">=22"},"dependencies":{"leftish":">=1.0.0"}}\n', 'upstream widens the range');
    await refresh();
    assert.equal(installed(), '1.1.0', 'a merge that changed a range resolves fresh');
  } finally {
    await registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deps_fingerprint ignores everything but how dependencies resolve, in any key order', () => {
  const w = npmStubWorld();
  try {
    const fp = (pkg) => {
      commitFile(w.repo, 'package.json', `${JSON.stringify(pkg)}\n`, 'edit');
      const r = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const base = { name: 'x', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^2.0.0' } };
    const first = fp(base);
    assert.equal(fp({ ...base, version: '1.0.1', description: 'new', scripts: { t: 'x' }, engines: { node: '>=22' }, bin: { x: 'x.js' } }), first);
    assert.equal(fp({ version: '9', dependencies: { b: '^2.0.0', a: '^1.0.0' }, name: 'x' }), first, 'key order does not matter');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'bundleDependencies', 'bundledDependencies', 'workspaces']) {
      const value = field === 'dependencies' ? { a: '^1.1.0', b: '^2.0.0' } : field === 'peerDependenciesMeta' ? { c: { optional: true } } : field.startsWith('bundle') || field === 'workspaces' ? ['a'] : { c: '1.0.0' };
      assert.notEqual(fp({ ...base, [field]: value }), first, `${field} changes the fingerprint`);
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('deps_fingerprint fails on a package.json it cannot parse, rather than hashing nothing', () => {
  const w = npmStubWorld();
  try {
    commitFile(w.repo, 'package.json', '{ not json\n', 'broken');
    const r = bashLib(w.repo, 'deps_fingerprint HEAD', w.env);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('a fetch that moves origin/main while Claude runs does not change the base the reinstall compares with', () => {
  const w = npmStubWorld();
  try {
    const base = git(w.repo, 'rev-parse', 'HEAD').trim();
    git(w.repo, 'checkout', '-q', '-b', 'later');
    commitFile(w.repo, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^2.0.0"}}\n', 'a later origin/main with other dependencies');
    git(w.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(w.repo, 'checkout', '-q', 'main');
    const res = syncDepsStep(w, { BASE_REV: base });
    assert.equal(res.status, 0, res.stderr);
    assert.match(npmCalls(w)[0], /^ci\b/, 'compared with the recorded base, so the baseline tree is reinstalled');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// ---- the one step that touches the live checkout: update_live_checkout ----

/**
 * A live checkout cloned from a bare origin whose main then gets one more commit (`depsChange` edits the root
 * dependencies, else an unrelated file). npm is a stub that logs its calls, or fails with `npmExit`.
 */
function liveWorld({ depsChange = false, ccChange = false, npmExit = 0, laterCommit = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'sync-live-'));
  const seed = path.join(base, 'seed');
  const origin = path.join(base, 'origin.git');
  const live = path.join(base, 'live');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'npm.log');
  stub(bin, 'npm', `echo "$*" >> "${log}"\nexit ${npmExit}`);
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  commitFile(seed, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^1.0.0"}}\n', 'pkg');
  commitFile(seed, 'custom/control-center/package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/fastify":{"version":"5.0.0"}}}\n', 'cc lock');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(seed, 'push', '-q', origin, 'main');
  git(base, 'clone', '-q', origin, live);
  if (depsChange) commitFile(seed, 'package.json', '{"name":"x","version":"1.0.0","dependencies":{"leftish":"^2.0.0"}}\n', 'merged sync PR changes dependencies');
  if (ccChange) commitFile(seed, 'custom/control-center/package-lock.json', '{"lockfileVersion":3,"packages":{"node_modules/fastify":{"version":"5.1.0"}}}\n', 'merged PR bumps a Control Center dependency');
  commitFile(seed, 'scan.mjs', 'merged\n', 'merged sync PR');
  git(seed, 'push', '-q', origin, 'main');
  const target = git(seed, 'rev-parse', 'HEAD').trim();
  if (laterCommit) {
    commitFile(seed, 'later.txt', 'another PR\n', 'a PR merged right after the sync PR');
    git(seed, 'push', '-q', origin, 'main');
  }
  // run-daily's lock, in a data root that does not exist yet: the daily job creates it.
  const dailyLock = path.join(base, 'data', 'data', 'immigration', '.run-daily.lockf');
  // HOME is the world's own, so the daily job installed on this machine (if any) is never read or locked.
  const home = path.join(base, 'home');
  mkdirSync(home);
  const update = ({ wait = 5, prefix = '' } = {}) => bashLib(live, `${prefix}out="$(update_live_checkout "$LOCK" ${wait} "$TARGET")"; rc=$?; printf "%s" "$out"; exit $rc`, { PATH: `${bin}:${process.env.PATH}`, HOME: home, LOCK: dailyLock, TARGET: target });
  return { base, home, live, log, target, update, dailyLock, head: () => git(live, 'rev-parse', 'HEAD').trim(), npm: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

const LIVE_CASES = [
  { name: 'a clean main with unchanged dependencies fast-forwards and installs nothing', setup: () => {}, status: 0, moves: true, npm: '', out: /^live checkout now at [0-9a-f]+$/ },
  { name: 'changed dependencies fast-forward and install with lifecycle scripts', opts: { depsChange: true }, setup: () => {}, status: 0, moves: true, npm: /^install --no-package-lock --silent$/m, out: /^live checkout now at / },
  { name: 'a failed install after the fast-forward is reported, not fatal', opts: { depsChange: true, npmExit: 1 }, setup: () => {}, status: 3, moves: true, npm: /^install /m, out: /npm install failed; run it by hand/ },
  { name: 'a changed Control Center lockfile reinstalls the Control Center with npm ci, and only it (SW3-scripts-01)', opts: { ccChange: true }, setup: () => {}, status: 0, moves: true, npm: /^--prefix custom\/control-center ci\n$/, out: /^live checkout now at / },
  { name: 'a failed Control Center reinstall is reported, not fatal (SW3-scripts-01)', opts: { ccChange: true, npmExit: 1 }, setup: () => {}, status: 3, moves: true, npm: /^--prefix custom\/control-center ci$/m, out: /npm --prefix custom\/control-center ci failed; run it by hand/ },
  { name: 'tracked local changes leave the checkout alone', setup: (w) => writeFileSync(path.join(w.live, 'package.json'), '{"edited":true}\n'), status: 10, moves: false, npm: '', out: /^the live checkout has local changes$/ },
  { name: 'a branch other than main leaves the checkout alone', setup: (w) => git(w.live, 'checkout', '-q', '-b', 'mine'), status: 10, moves: false, npm: '', out: /^the live checkout is not on main$/ },
  { name: 'a checkout someone already pulled past the sync commit is left alone (R11-scripts-b-L1-01)', opts: { laterCommit: true }, setup: (w) => git(w.live, 'pull', '-q', '--ff-only'), status: 10, moves: false, npm: '', out: /^the live checkout is already past the sync commit$/ },
  { name: 'a main that cannot fast-forward fails', setup: (w) => commitFile(w.live, 'local.txt', 'mine\n', 'a local commit'), status: 1, moves: false, npm: '', out: /^live checkout could not fast-forward$/ },
];

for (const c of LIVE_CASES) {
  test(`update_live_checkout: ${c.name} (SW2-tests-14)`, () => {
    const w = liveWorld(c.opts);
    try {
      c.setup(w);
      const before = w.head();
      const res = w.update();
      assert.equal(res.status, c.status, res.stdout + res.stderr);
      assert.match(res.stdout, c.out);
      if (c.moves) assert.equal(w.head(), w.target);
      else assert.equal(w.head(), before);
      if (c.npm === '') assert.equal(w.npm(), '');
      else assert.match(w.npm(), c.npm);
    } finally { rmSync(w.base, { recursive: true, force: true }); }
  });
}

test('update_live_checkout moves the live checkout to the verified sync merge, not to a later commit on origin/main (R11-scripts-b-L1-01)', () => {
  const w = liveWorld({ laterCommit: true });
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
    assert.equal(res.stdout, `live checkout now at ${w.target.slice(0, 7)}`);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

// A Control Center that is running leaves its supervisor.lock naming a live PID; the live update must not run npm ci
// under it, because that deletes node_modules while the fast-forward's blue/green reload starts the new server child.
// `start` is the holder's process start time in seconds (or null, when it could not be read): a live PID whose start
// differs from the lock's is a reused PID, not the Control Center.
function holdRunningControlCenter(w, child, start = null) {
  const lock = path.join(w.base, 'data', 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: child.pid, start, port: 4317, nonce: 'test' }));
}

test('a running Control Center leaves the live update to skip its npm ci, so the reload is not raced (R17-scripts-b-L1-01)', () => {
  const w = liveWorld({ ccChange: true });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  holdRunningControlCenter(w, child);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target, 'the fast-forward still happens');
    assert.equal(w.npm(), '', 'npm ci must not run under a running Control Center');
    assert.match(res.stdout, /Control Center is running/);
    assert.match(res.stdout, /npm --prefix custom\/control-center ci/, 'the deferred message names the npm ci command, not a restart');
    assert.doesNotMatch(res.stdout, /restart it to pick them up/, 'a restart does not install dependencies');
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('given a running Control Center\'s lock carries its real start time, as acquireInstanceLock writes it, the live update skips its npm ci (R27-tests-custom-L2-01)', () => {
  const w = liveWorld({ ccChange: true });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const start = processStartTime(child.pid);
  assert.equal(typeof start, 'number', `the writer must read a start, or the lock is the legacy null format: ${start}`);
  holdRunningControlCenter(w, child, start);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target, 'the fast-forward still happens');
    assert.equal(w.npm(), '', 'npm ci must not run under a running Control Center');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('a stale Control Center lock whose PID was reused is not treated as running, so npm ci still runs (R17-scripts-b-L1-01)', () => {
  const w = liveWorld({ ccChange: true });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  holdRunningControlCenter(w, child, Math.floor(Date.now() / 1000) - 100000);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target, 'the fast-forward still happens');
    assert.match(w.npm(), /^--prefix custom\/control-center ci\n$/, 'npm ci must run when the lock is stale (reused PID)');
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

// PID 1 is launchd, owned by root: kill(1, 0) is refused with EPERM, yet ps still reads when it started.
test('a stale Control Center lock naming a reused PID of another user is not treated as running, so npm ci still runs (R18-scripts-b-review-01)', () => {
  const w = liveWorld({ ccChange: true });
  holdRunningControlCenter(w, { pid: 1 }, 1);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target, 'the fast-forward still happens');
    assert.match(w.npm(), /^--prefix custom\/control-center ci\n$/, 'npm ci must run when the lock names another user\'s process that started at another time');
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

// The supervisor rejects a lock without an integer port (parseHolder). It leaves a malformed lock younger than
// UNREADABLE_LOCK_GRACE_MS (5 s) alone, refusing to start, and replaces an older one, live PID or not.
// The lock's age is its mtime against the reading node's Date.now, so both are pinned: the update runs a fetch and
// a merge before it reads the lock, which under load takes longer than the grace.
const LOCK_CLOCK_MS = Date.UTC(2026, 0, 1);
function writeControlCenterLock(w, text, ageMs) {
  const lock = path.join(w.base, 'data', 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, text);
  const at = new Date(LOCK_CLOCK_MS - ageMs);
  utimesSync(lock, at, at);
}

// A prefix for w.update that pins Date.now in every node the update starts to LOCK_CLOCK_MS.
function pinLockClock(w) {
  const preload = path.join(w.base, 'pin-clock.mjs');
  writeFileSync(preload, `Date.now = () => ${LOCK_CLOCK_MS};\n`);
  return `export NODE_OPTIONS="--import=${preload}"; `;
}

test('a malformed Control Center lock past its grace is not treated as running, so npm ci still runs (R18-scripts-b-review-02)', () => {
  const w = liveWorld({ ccChange: true });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  writeControlCenterLock(w, JSON.stringify({ pid: child.pid, start: null }), 60000);
  try {
    const res = w.update({ prefix: pinLockClock(w) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(w.npm(), /^--prefix custom\/control-center ci\n$/, 'npm ci must run when the lock has no port');
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('a malformed Control Center lock within its grace is treated as running, as the supervisor does (R18-scripts-b-review-02)', () => {
  const w = liveWorld({ ccChange: true });
  writeControlCenterLock(w, '{"pid":', 1000);
  try {
    const res = w.update({ prefix: pinLockClock(w) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.npm(), '', 'npm ci must not run while a malformed lock is within its grace');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

// acquireInstanceLock throws on a lock it cannot read rather than replacing it, so no second instance starts.
test('a Control Center lock that cannot be read is treated as running, as the supervisor refuses to replace it (R18-scripts-b-review-05)', () => {
  const w = liveWorld({ ccChange: true });
  // A directory in the lock's place: reading it fails (EISDIR) for every user, root included, unlike chmod 000.
  const lock = path.join(w.base, 'data', 'data', 'control-center', 'supervisor.lock');
  mkdirSync(lock, { recursive: true });
  const at = new Date(Date.now() - 60000);
  utimesSync(lock, at, at);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.npm(), '', 'npm ci must not run while the lock cannot be read');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

// acquireInstanceLock cannot take a lock path that is a dangling symlink (the link fails, the read finds nothing).
test('a Control Center lock that is a dangling symlink is treated as running, as the supervisor cannot take it (R18-scripts-b-review-08)', () => {
  const w = liveWorld({ ccChange: true });
  const lock = path.join(w.base, 'data', 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  symlinkSync(path.join(w.base, 'nowhere'), lock);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.npm(), '', 'npm ci must not run while the lock path is a dangling symlink');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('a dangling Control Center lock on the installed daily job\'s other data root is not running, so the npm ci runs (R20-scripts-b review)', () => {
  const w = liveWorld({ ccChange: true });
  const jobRoot = path.join(w.base, 'job-data');
  installDailyPlist(w, jobRoot);
  const lock = path.join(jobRoot, 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  symlinkSync(path.join(w.base, 'nowhere'), lock);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(w.npm(), /^--prefix custom\/control-center ci$/m);
  } finally {
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('a running Control Center with a failed root install still reports the skipped Control Center deps (R17-scripts-b-L1-01)', () => {
  const w = liveWorld({ depsChange: true, ccChange: true, npmExit: 1 });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  holdRunningControlCenter(w, child);
  try {
    const res = w.update();
    assert.equal(res.status, 3, res.stdout + res.stderr);
    assert.equal(w.head(), w.target, 'the fast-forward still happens');
    assert.match(res.stdout, /npm install failed; run it by hand/);
    assert.match(res.stdout, /Control Center is running/, 'the deferred Control Center deps are still reported when the root install also failed');
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

/**
 * A shell prefix that starts a daily job holding run-daily's lock in the background and returns once it holds it, so
 * the update after it always meets a held lock. `body` is what the job does while it holds the lock.
 */
function holdDailyLock(w, body) {
  const ready = path.join(w.base, 'holder-ready');
  return `mkdir -p "$(dirname "$LOCK")"
/usr/bin/lockf -k -t 0 "$LOCK" /bin/sh -c 'touch "$1"; ${body}' holder "${ready}" >/dev/null 2>&1 &
echo $! > "${w.base}/holder.pid"
for _ in $(seq 400); do [ -e "${ready}" ] && break; sleep 0.05; done
[ -e "${ready}" ] || { echo "the daily job never took its lock"; exit 99; }
`;
}

/** The command line `holdDailyLock` waits on until `release` appears in the world; the holder outlives the update. */
const untilReleased = (w) => `for _ in $(seq 600); do [ -e "${w.base}/release" ] && break; sleep 0.05; done`;

/**
 * Lets a holder started with `untilReleased` go and waits for it to exit, before the world (and its `release`) is
 * removed. Returns the holder's pid if it is still running, so the spec can assert it left nothing behind.
 */
function releaseDailyLock(w) {
  const pidFile = path.join(w.base, 'holder.pid');
  writeFileSync(path.join(w.base, 'release'), '');
  if (!existsSync(pidFile)) return [];
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) spawnSync('sleep', ['0.05']);
  return alive() ? [pid] : [];
}

test('a daily job holding its lock for longer than the wait leaves the live checkout alone, reinstalls nothing, and says why (R11-scripts-b-L1-03)', () => {
  const w = liveWorld({ depsChange: true, ccChange: true });
  let left;
  try {
    const before = w.head();
    // The daily job, mid-run: it holds run-daily.sh's lock until the update has returned.
    const res = w.update({ wait: 1, prefix: holdDailyLock(w, untilReleased(w)) });
    assert.equal(res.status, 10, res.stdout + res.stderr);
    assert.equal(res.stdout, 'the daily job is still running');
    assert.equal(w.head(), before);
    assert.equal(w.npm(), '');
  } finally {
    left = releaseDailyLock(w);
    rmSync(w.base, { recursive: true, force: true });
  }
  assert.deepEqual(left, [], 'the daily-lock holder was still running after its release');
});

test('a daily job that finishes within the wait is waited for, then the live checkout is updated (R11-scripts-b-L1-03)', () => {
  const w = liveWorld({ depsChange: true });
  try {
    const res = w.update({ wait: 20, prefix: holdDailyLock(w, 'sleep 1') });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^live checkout now at [0-9a-f]+$/);
    assert.equal(w.head(), w.target);
    assert.match(w.npm(), /^install --no-package-lock --silent$/m);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('the live update names its pid beside the daily job\'s lock while it holds it, and removes it after (R15-scripts-b-L1-02)', () => {
  const w = liveWorld({ depsChange: true });
  const marker = path.join(path.dirname(w.dailyLock), '.live-update.pid');
  const seen = path.join(w.base, 'marker-seen');
  // npm runs inside the locked update: it records whether the marker names a live process at that point.
  stub(path.join(w.base, 'bin'), 'npm', `pid="$(cat "${marker}" 2>/dev/null)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo alive >> "${seen}"; exit 0`);
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(existsSync(seen) ? readFileSync(seen, 'utf8') : '', 'alive\n');
    assert.equal(existsSync(marker), false, 'the marker outlived the update');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

/** Installs the daily job's plist in the world's HOME with its launchd logs under <jobRoot>, as launchd/install.sh writes it. */
function installDailyPlist(w, jobRoot, checkout = w.live) {
  const agents = path.join(w.home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, 'com.career-ops.immigration-watch.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.career-ops.immigration-watch</string>
  <key>WorkingDirectory</key><string>${checkout}</string>
  <key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${jobRoot}</string></dict>
  <key>StandardOutPath</key><string>${jobRoot}/data/immigration/logs/launchd.out.log</string>
</dict>
</plist>
`);
}

test('the live update also waits on the daily job installed on another data root than the sync resolved (R20-scripts-b-L1-01)', () => {
  const w = liveWorld({ depsChange: true, ccChange: true });
  const jobRoot = path.join(w.base, 'job-data');
  installDailyPlist(w, jobRoot);
  const jobLock = path.join(jobRoot, 'data', 'immigration', '.run-daily.lockf');
  let left;
  try {
    const before = w.head();
    const res = w.update({ wait: 1, prefix: `LOCK="${jobLock}"\n${holdDailyLock(w, untilReleased(w))}LOCK="${w.dailyLock}"\n` });
    assert.equal(res.status, 10, res.stdout + res.stderr);
    assert.equal(res.stdout, 'the daily job is still running');
    assert.equal(w.head(), before);
    assert.equal(w.npm(), '');
  } finally {
    left = releaseDailyLock(w);
    rmSync(w.base, { recursive: true, force: true });
  }
  assert.deepEqual(left, [], 'the daily-lock holder was still running after its release');
});

test('the live update skips the Control Center npm ci while it runs on the installed daily job\'s data root (R20-scripts-b-L1-01)', () => {
  const w = liveWorld({ ccChange: true });
  const jobRoot = path.join(w.base, 'job-data');
  installDailyPlist(w, jobRoot);
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(jobRoot, 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
    assert.equal(w.npm(), '', 'npm ci must not run under a running Control Center');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('the live update skips the Control Center npm ci while it runs on the checkout itself, after the data root moved out (R20-scripts-b review)', () => {
  const w = liveWorld({ ccChange: true });
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(w.live, 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  try {
    const res = w.update();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
    assert.equal(w.npm(), '', 'npm ci must not run under a running Control Center');
    assert.match(res.stdout, /Control Center is running/);
  } finally {
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('an installed daily job whose data root is gone (an unmounted volume) does not block the live update (R20-scripts-b review)', () => {
  const w = liveWorld({ depsChange: true });
  const gone = path.join(w.base, 'unmounted', 'co-data');
  installDailyPlist(w, gone);
  // A folder nothing can be created in, as an unmounted /Volumes path.
  mkdirSync(path.join(w.base, 'unmounted'));
  chmodSync(path.join(w.base, 'unmounted'), 0o555);
  try {
    const res = w.update({ wait: 1 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
    assert.equal(existsSync(gone), false);
  } finally {
    chmodSync(path.join(w.base, 'unmounted'), 0o755);
    rmSync(w.base, { recursive: true, force: true });
  }
});

test('a daily job and Control Center of another checkout neither hold up the live update nor stop its npm ci (R20-scripts-b review)', () => {
  const w = liveWorld({ ccChange: true });
  const other = path.join(w.base, 'other-checkout');
  mkdirSync(other);
  const jobRoot = path.join(w.base, 'other-data');
  installDailyPlist(w, jobRoot, other);
  const jobLock = path.join(jobRoot, 'data', 'immigration', '.run-daily.lockf');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = path.join(jobRoot, 'data', 'control-center', 'supervisor.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: child.pid, start: null, port: 4317, nonce: 'test' }));
  let left;
  try {
    const res = w.update({ wait: 1, prefix: `LOCK="${jobLock}"\n${holdDailyLock(w, untilReleased(w))}LOCK="${w.dailyLock}"\n` });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
    assert.match(w.npm(), /^--prefix custom\/control-center ci$/m);
  } finally {
    left = releaseDailyLock(w);
    child.kill('SIGKILL');
    rmSync(w.base, { recursive: true, force: true });
  }
  assert.deepEqual(left, [], 'the daily-lock holder was still running after its release');
});

test('the live update locks the installed daily job\'s data root before that job\'s first run there, so the first run cannot start mid-update (R20-scripts-b review)', () => {
  const w = liveWorld({ depsChange: true });
  const jobRoot = path.join(w.base, 'new-data');
  mkdirSync(jobRoot);
  installDailyPlist(w, jobRoot);
  try {
    const res = w.update({ wait: 1 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(existsSync(path.join(jobRoot, 'data', 'immigration', '.run-daily.lockf')), 'the daily lock of the new root was never taken');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a daily job installed on the sync\'s own data root, spelled through a symlink, is locked once, not waited on by the update itself (R20-scripts-b-L1-01)', () => {
  const w = liveWorld({ depsChange: true });
  const alias = path.join(w.base, 'data-alias');
  mkdirSync(path.join(w.base, 'data'), { recursive: true });
  symlinkSync(path.join(w.base, 'data'), alias);
  installDailyPlist(w, alias);
  try {
    const res = w.update({ wait: 1 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(w.head(), w.target);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('update_live_checkout refuses to run without the daily job\'s lock, a wait and a target commit (R11-scripts-b-L1-03)', () => {
  const w = liveWorld();
  try {
    const before = w.head();
    for (const args of ['', `"${w.dailyLock}" 5`, `"${w.dailyLock}" x ${w.target}`]) {
      const res = bashLib(w.live, `update_live_checkout ${args}`);
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(res.stdout, /needs the daily job's lock file, a wait in seconds and the commit to move to/, args);
    }
    assert.equal(w.head(), before);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('sync.sh updates the live checkout under the lock run-daily.sh takes, in the data root it resolved (R11-scripts-b-L1-03)', () => {
  const sync = readFileSync(SYNC, 'utf8');
  assert.match(sync, /^ {2}LIVE_UPDATE="\$\(update_live_checkout "\$DATA\/data\/immigration\/\.run-daily\.lockf" [0-9]+ "\$MERGE_OID"\)"$/m);
  const daily = readFileSync(path.join(REPO_ROOT, 'custom/immigration/run-daily.sh'), 'utf8');
  assert.match(daily, /^IMM="\$DATA\/data\/immigration"$/m);
  assert.match(daily, /lockf -k -t 0 "\$IMM\/\.run-daily\.lockf"/);
});

test('sync.sh updates the live checkout through update_live_checkout and fails the run only on its failures (SW2-tests-14)', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('  LIVE_UPDATE="$(update_live_checkout '));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  assert.ok(from > -1 && to > from, 'no LIVE_UPDATE .. esac block in sync.sh');
  const block = lines.slice(from, to + 1).join('\n');
  const decide = (status, out) => spawnSync('bash', ['-c', `update_live_checkout() { echo "${out}"; return ${status}; }\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; exit 1; }\nBEHIND=2\n${block}\necho continued`], { encoding: 'utf8' });
  assert.match(decide(0, 'live checkout now at abc').stdout, /live checkout now at abc\nNOTIFY: Merged upstream \(2 commits\) and updated career-ops\ncontinued/);
  assert.match(decide(3, 'live checkout now at abc, but npm install failed; run it by hand').stdout, /NOTIFY: Merged upstream, but in the live checkout npm install failed; run it by hand\ncontinued/);
  assert.match(decide(3, 'live checkout now at abc, but npm --prefix custom/control-center ci failed; run it by hand').stdout, /NOTIFY: Merged upstream, but in the live checkout npm --prefix custom\/control-center ci failed; run it by hand\ncontinued/);
  assert.match(decide(10, 'the live checkout has local changes').stdout, /NOTIFY: Merged upstream; the live checkout has local changes, so it was not updated\. Run: git switch main && git pull --ff-only\ncontinued/);
  const failed = decide(1, 'live checkout could not fast-forward');
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^!!! live checkout could not fast-forward$/m);
  assert.doesNotMatch(failed.stdout, /continued/);
});

test('an update that left the running Control Center\'s dependencies alone says so in the notification, with the command to run (R18-scripts-b-L3-02)', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('  LIVE_UPDATE="$(update_live_checkout '));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  const block = lines.slice(from, to + 1).join('\n');
  const deferred = "the Control Center is running, so its dependencies were not reinstalled; stop it, run 'npm --prefix custom/control-center ci', then start it again";
  const r = spawnSync('bash', ['-c', `update_live_checkout() { echo "live checkout now at abc; ${deferred}"; return 0; }\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; exit 1; }\nBEHIND=2\n${block}\necho continued`], { encoding: 'utf8' });
  const notice = r.stdout.split('\n').find((l) => l.startsWith('NOTIFY: ')) ?? '';
  assert.equal(notice, `NOTIFY: Merged upstream (2 commits) and updated career-ops, but ${deferred}`, r.stdout);
  assert.match(r.stdout, /continued$/m);
});

test('a live update that cannot take the daily lock for a reason other than a timeout fails the run with a readable reason, naming the lock and the merged commit (R22-scripts-b-L1-01)', () => {
  const w = liveWorld();
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  // From the stderr capture set up just before the update, through the outcome.
  const from = lines.findIndex((l) => l.startsWith('  LIVE_LOG_FROM='));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  const block = lines.slice(from, to + 1).join('\n');
  // The lock file is a symlink to itself, so lockf cannot open it (as root too) and exits 73 (EX_CANTCREAT).
  mkdirSync(path.dirname(w.dailyLock), { recursive: true });
  symlinkSync(path.basename(w.dailyLock), w.dailyLock);
  try {
    const before = w.head();
    // As in sync.sh, stderr goes to the day log.
    const log = path.join(w.base, 'day.log');
    writeFileSync(log, '!!! an earlier line\nlockf: from an earlier run of the day\n');
    const res = bashLib(w.live, `exec 2>>"$LOG"\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; notify "$1 (log: x)"; exit 1; }\nBEHIND=2\n${block}\necho continued`, { PATH: `${path.join(w.base, 'bin')}:${process.env.PATH}`, HOME: w.home, DATA: path.join(w.base, 'data'), MERGE_OID: w.target, LOG: log });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /continued/);
    const problem = res.stdout.split('\n').find((l) => l.startsWith('!!!')) ?? '';
    // The Control Center's parseDailyLog only records a `!!!` line with text after the marker.
    assert.match(problem, /^!!!\s+\S/, res.stdout);
    assert.ok(problem.includes(w.dailyLock), problem);
    assert.match(problem, /lockf: cannot open .*Too many levels of symbolic links/);
    assert.ok(problem.includes(w.target), problem);
    assert.match(problem, /not updated/);
    assert.doesNotMatch(problem, /earlier run/);
    assert.match(readFileSync(log, 'utf8'), /^lockf: cannot open /m);
    assert.equal(w.head(), before);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a live update killed while it holds the daily lock is reported as killed, not as a lock it could not take (R22-scripts-b-L1-01)', () => {
  const w = liveWorld();
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('  LIVE_LOG_FROM='));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  const block = lines.slice(from, to + 1).join('\n');
  // git, first run inside the locked section, kills the shell lockf runs; lockf then exits 70 and prints nothing.
  const killer = path.join(w.base, 'killer');
  stub(killer, 'git', 'p=$PPID\nwhile [ "${p:-1}" -gt 1 ]; do\n  if ps -o args= -p "$p" | grep -q "live_update_locked \\"\\$4\\""; then kill -KILL "$p"; exit 1; fi\n  p="$(ps -o ppid= -p "$p" | tr -d " ")"\ndone\nexit 1');
  try {
    const log = path.join(w.base, 'day.log');
    writeFileSync(log, 'lockf: from an earlier run of the day\n');
    const res = bashLib(w.live, `exec 2>>"$LOG"\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; exit 1; }\nBEHIND=2\n${block}\necho continued`, { PATH: `${killer}:${process.env.PATH}`, HOME: w.home, DATA: path.join(w.base, 'data'), MERGE_OID: w.target, LOG: log });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    const problem = res.stdout.split('\n').find((l) => l.startsWith('!!!')) ?? '';
    assert.match(problem, /^!!! the live checkout update exited 70 without saying why/, problem + res.stderr);
    assert.doesNotMatch(problem, /could not take/);
    assert.ok(problem.includes(w.target), problem);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a live update killed after it took the lock, with nothing printed, fails the run naming its exit, not blaming the lock (R22-scripts-b-L1-01)', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('  LIVE_UPDATE="$(update_live_checkout '));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  const block = lines.slice(from, to + 1).join('\n');
  const r = spawnSync('bash', ['-c', `update_live_checkout() { return 143; }\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; exit 1; }\nBEHIND=2\nDATA=/d\nMERGE_OID=abc123\n${block}\necho continued`], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  const problem = r.stdout.split('\n').find((l) => l.startsWith('!!!')) ?? '';
  assert.match(problem, /^!!! the live checkout update exited 143 without saying why/, problem);
  assert.match(problem, /the fork main is at abc123 but the live checkout was not updated/);
  assert.doesNotMatch(problem, /could not take/);
});

test('a live update whose lockf ran out of wait is not reported as a lock it could not take, though lockf said already locked (R22-scripts-b-L1-01)', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('  LIVE_LOG_FROM='));
  const to = lines.findIndex((l, i) => i > from && l === '  esac');
  const block = lines.slice(from, to + 1).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-live-'));
  const log = path.join(dir, 'day.log');
  writeFileSync(log, '');
  try {
    const r = spawnSync('bash', ['-c', `exec 2>>"$LOG"\nupdate_live_checkout() { echo "lockf: $1: already locked" >&2; return 75; }\nnotify() { echo "NOTIFY: $1"; }\nfail() { echo "!!! $1"; exit 1; }\nBEHIND=2\nDATA=/d\nMERGE_OID=abc123\n${block}\necho continued`], { encoding: 'utf8', env: { PATH: process.env.PATH, LOG: log } });
    const problem = r.stdout.split('\n').find((l) => l.startsWith('!!!')) ?? '';
    assert.match(problem, /^!!! the live checkout update exited 75 without saying why/, r.stdout);
    assert.doesNotMatch(problem, /could not take/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const KEYCHAIN_LOCKED = 'echo "security: SecKeychainSearchCopyNext: User interaction is not allowed." >&2; exit 36';

test('a Keychain item that does not exist (security exit 44) stops the sync with the setup-token advice (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Keychain item career-ops-claude-token not found\. Run: claude setup-token, then security add-generic-password -U -a \$USER -s career-ops-claude-token -w$/m);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('an empty Keychain token stops the sync as a missing one, before anything is replaced (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'echo ""' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Keychain item career-ops-claude-token not found\. Run: claude setup-token/m);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a whitespace-only Keychain token stops the sync as a missing one, as the Control Center trims it (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'printf "  \\t \\n"' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Keychain item career-ops-claude-token not found\. Run: claude setup-token/m);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a Keychain token with whitespace around it is passed on trimmed, as the Control Center reads it (R22-scripts-b-L3-01)', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('SECURITY_ERR="$(mktemp '));
  const to = lines.findIndex((l, i) => i > from && l === 'fi');
  const block = lines.slice(from, to + 1).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-token-'));
  stub(dir, 'security', 'printf " \\ttok-123 \\n"');
  try {
    const r = spawnSync('bash', ['-c', `fail() { echo "!!! $1"; exit 1; }\n${block}\necho "[$TOKEN]"`], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), '[tok-123]');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('career-ops-sync-security.')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a security command that cannot run (exit 126) is named as the problem, not a locked Keychain (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'exit 126' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Could not read Keychain item career-ops-claude-token: the security command could not be run \(exit 126\)/m);
    assert.doesNotMatch(res.log, /unlock-keychain|not found|setup-token/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a locked Keychain (security exit 36) stops the sync saying the token could not be read, never that it is missing (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: KEYCHAIN_LOCKED });
    assert.equal(res.status, 1, res.log);
    const problem = res.log.split('\n').find((l) => l.startsWith('!!!')) ?? '';
    assert.match(problem, /^!!! Could not read Keychain item career-ops-claude-token: security failed \(exit 36: security: SecKeychainSearchCopyNext: User interaction is not allowed\.\)\. /, res.log);
    assert.match(problem, /Unlock it with: security unlock-keychain, then re-run/);
    assert.doesNotMatch(res.log, /not found|setup-token/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a Keychain read failing for a reason that is not a lock (security exit 50, no such keychain) names the code and security\'s reason without guessing a fix (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'echo "security: SecKeychainSearchCopyNext: The specified keychain could not be found." >&2; exit 50' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Could not read Keychain item career-ops-claude-token: security failed \(exit 50: security: SecKeychainSearchCopyNext: The specified keychain could not be found\.\)\.?$/m);
    assert.doesNotMatch(res.log, /unlock-keychain|setup-token/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a Keychain read refused at the prompt (security exit 51) names the exit code and says access was denied, without the setup-token or unlock advice (R22-scripts-b-L3-01)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const res = runSync(w, { home, security: 'exit 51' });
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Could not read Keychain item career-ops-claude-token: security failed \(exit 51\)\. Access to it was denied/m);
    assert.doesNotMatch(res.log, /not found|setup-token|probably locked/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a Keychain read that never answers (locked keychain, unlock prompt nobody answers) stops the sync fast with the reason and frees its lock', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  // A security that waits forever, as one blocked on an unanswered unlock dialog does (one process, as security is).
  // Every command line it has, the script's and the sleep's it becomes, names its own path: under load the alarm can
  // fire before the script has run a line, so the check below finds it by that path rather than by a pid it wrote.
  // runSync writes the stub to two folders on PATH; both are under the world's base.
  const stubs = [path.join(w.base, 'bin', 'security'), path.join(home, '.local/bin', 'security')];
  const stubPattern = stubs.map((s) => s.replace(/[^\w/-]/g, '\\$&')).join('|');
  try {
    const started = Date.now();
    const res = runSync(w, { home, inherited: { CC_KEYCHAIN_TIMEOUT: '2' }, security: 'exec -a "$0-waiting" /bin/sleep 100000' });
    assert.ok(Date.now() - started < 30_000, `the sync waited ${Date.now() - started} ms for the Keychain`);
    assert.equal(res.status, 1, res.log);
    assert.match(res.log, /^!!! Could not read Keychain item career-ops-claude-token: security did not answer within 2 s\. The login keychain is probably locked and waiting at an unlock prompt nobody answered\. Unlock it with: security unlock-keychain, then re-run\.$/m);
    assert.doesNotMatch(res.log, /not found|setup-token/);
    const lock = spawnSync('/usr/bin/lockf', ['-k', '-t', '0', path.join(home, '.career-ops-sync.lockf'), '/usr/bin/true']);
    assert.equal(lock.status, 0, 'the sync lock is free once the run has failed');
    const orphan = spawnSync('/usr/bin/pgrep', ['-f', stubPattern], { encoding: 'utf8' });
    assert.equal(orphan.stdout, '', 'nothing the Keychain read started is left running');
    assert.equal(orphan.status, 1, orphan.stderr);
  } finally {
    // A run that failed above may have left the stub sleeping: stop it so it does not outlive the test.
    spawnSync('/usr/bin/pkill', ['-KILL', '-f', stubPattern]);
    rmSync(w.base, { recursive: true, force: true });
  }
});

// 4294967296 wraps to alarm(0) in perl, which would wait forever: the wait is capped at an hour.
for (const value of ['0', 'soon', '3601', '4294967296']) {
  test(`a Keychain wait of '${value}' (not a whole number of seconds from 1 to 3600) stops the sync before the Keychain is read`, () => {
    const w = makeWorld();
    const home = path.join(w.base, 'home');
    mkdirSync(home);
    const read = path.join(w.base, 'security-ran');
    try {
      const res = runSync(w, { home, inherited: { CC_KEYCHAIN_TIMEOUT: value }, security: `touch "${read}"\necho tok-123` });
      assert.equal(res.status, 1, res.log);
      assert.match(res.log, new RegExp(`^!!! CC_KEYCHAIN_TIMEOUT must be a whole number of seconds from 1 to 3600, not ${value}\\.$`, 'm'));
      assert.equal(existsSync(read), false);
    } finally { rmSync(w.base, { recursive: true, force: true }); }
  });
}

test('a sync stopped while the Keychain read waits (launchd stop, signal to the job group) stops the security it started and removes its temporary file', async () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('SECURITY_ERR="$(mktemp '));
  const to = lines.findIndex((l) => l.startsWith('SECURITY_RC=$?'));
  const block = lines.slice(from, to + 1).join('\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-cancel-'));
  const securityPid = path.join(dir, 'security.pid');
  stub(dir, 'security', `echo $$ > "${securityPid}"\nexec /bin/sleep 100000`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const child = spawn('bash', ['-c', `fail() { echo "!!! $1"; exit 1; }\n${block}`], { env: { PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir }, stdio: 'ignore', detached: true });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    for (let i = 0; i < 600 && !existsSync(securityPid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(securityPid), 'the Keychain read never started');
    const pid = Number(readFileSync(securityPid, 'utf8'));
    process.kill(-child.pid, 'SIGTERM');
    await exited;
    for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const left = alive(pid);
    if (left) process.kill(pid, 'SIGKILL');
    assert.equal(left, false, 'the security the stopped sync started is still running');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('career-ops-sync-security.')), [], 'the stopped sync left its Keychain stderr file behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the merge goes ahead only onto the main every gate tested (R11-scripts-b-L1-01) ----

/**
 * Runs sync.sh's own lines from the origin/main check through leaving for the live checkout, with every other gate
 * green, on a sync commit made from origin/main as it was when the run started (BASE_REV). `moveMain` merges another
 * PR into the fork meanwhile; `fetchFails` makes the re-fetch fail; `race` merges another PR in the moment between
 * that check and the merge itself (a pre-push hook, which runs after the remote's refs were read). gh is a stub that
 * records its argv.
 */
function mergeDecision({ moveMain = false, fetchFails = false, race = false } = {}) {
  const w = makeWorld();
  try {
    git(w.live, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const baseRev = git(w.live, 'rev-parse', 'refs/remotes/origin/main').trim();
    git(w.live, 'checkout', '-q', '-b', 'sync/x', baseRev);
    commitFile(w.live, 'synced.txt', 'merged upstream\n', 'the sync merge');
    const extra = path.join(w.base, 'extra');
    git(w.base, 'clone', '-q', w.originBare, extra);
    commitFile(extra, 'other-pr.txt', 'x\n', 'another PR merged into the fork while the sync ran');
    const otherPr = git(extra, 'rev-parse', 'HEAD').trim();
    if (moveMain) git(extra, 'push', '-q', 'origin', 'HEAD:main');
    if (race) {
      const hook = path.join(w.live, '.git', 'hooks', 'pre-push');
      mkdirSync(path.dirname(hook), { recursive: true });
      writeFileSync(hook, `#!/bin/bash\ngit -C "${extra}" push -q origin HEAD:main\n`);
      chmodSync(hook, 0o755);
    }
    if (fetchFails) git(w.live, 'remote', 'set-url', 'origin', path.join(w.base, 'gone.git'));
    const bin = path.join(w.base, 'bin');
    const ghLog = path.join(w.base, 'gh.log');
    stub(bin, 'gh', `printf '%s\\n' "$*" >> "${ghLog}"`);
    const lines = readFileSync(SYNC, 'utf8').split('\n');
    const from = lines.findIndex((l) => l.startsWith('MAIN_MOVED='));
    const to = lines.findIndex((l, i) => i > from && l.startsWith('  cd "$LIVE"'));
    assert.ok(from > -1 && to > from, 'no MAIN_MOVED .. cd "$LIVE" block in sync.sh');
    const script = `source "${LIB}"\nfail() { echo "!!! $1"; exit 1; }\nPR_URL=https://example.invalid/pr/1\nBRANCH=sync/x\nLIVE="${w.live}"\n${lines.slice(from, to + 1).join('\n')}\necho "deployed $MERGE_OID"\nelse\necho "hold: $BLOCKERS"\nfi`;
    // The commit the gates verified, recorded by sync.sh right after verify_merge: here the sync merge just made.
    const verifiedOid = git(w.live, 'rev-parse', 'HEAD').trim();
    const env = { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, BASE_REV: baseRev, VERIFIED_OID: verifiedOid, CUSTOM_OK: '1', CC_OK: '1', NEW_FAILURES: '', AUTO_MERGE: '1', KEPT_README: '0', UNEXPECTED_UPSTREAM: '', CLAUDE_HOLD: '', PROTECTED_EDITS: '' };
    const res = spawnSync('bash', ['-c', script], { cwd: w.live, env, encoding: 'utf8' });
    const now = git(w.live, 'rev-parse', 'refs/remotes/origin/main').trim();
    const forkMain = git(w.originBare, 'rev-parse', 'refs/heads/main').trim();
    return { ...res, baseRev, now, forkMain, otherPr, head: git(w.live, 'rev-parse', 'HEAD').trim(), gh: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '' };
  } finally { rmSync(w.base, { recursive: true, force: true }); }
}

test('a fork main unchanged since the run started gets exactly the tested sync commit, and the live checkout is sent to it (R11-scripts-b-L1-01)', () => {
  const r = mergeDecision();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.forkMain, r.head, 'the fork main is the sync commit the gates tested');
  assert.match(r.stdout, new RegExp(`^deployed ${r.head}$`, 'm'), r.stdout);
});

test('a fork main that moved while the sync ran holds the PR, naming both commits, and nothing is merged (R11-scripts-b-L1-01)', () => {
  const r = mergeDecision({ moveMain: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.notEqual(r.now, r.baseRev, 'the re-fetch saw the moved main');
  assert.match(r.stdout, new RegExp(`^hold: origin/main moved during the sync \\(tested ${r.baseRev.slice(0, 12)}, now ${r.now.slice(0, 12)}\\); re-run the sync$`, 'm'), r.stdout);
  assert.equal(r.forkMain, r.otherPr);
});

test('a re-fetch of the fork main that fails holds the PR rather than merging on a stale origin/main (R11-scripts-b-L1-01)', () => {
  const r = mergeDecision({ fetchFails: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^hold: cannot confirm origin\/main is still the commit the sync tested \(the fetch failed\)$/m, r.stdout);
  assert.equal(r.forkMain, r.baseRev);
});

test('a PR merged in the moment between the check and the merge leaves the fork main as that PR left it and fails the run before the live checkout (R11-scripts-b-L1-01)', () => {
  const r = mergeDecision({ race: true });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.forkMain, r.otherPr, 'no untested combination reached the fork main');
  assert.match(r.stdout, /^!!! the fork main moved, or refused the push, before the sync commit could land on it; https:\/\/example\.invalid\/pr\/1 is left open$/m, r.stdout);
  assert.doesNotMatch(r.stdout, /^deployed/m);
});

// ---- an existing PR whose body could not be updated (R28-scripts-b-X-01) ----

/**
 * Runs sync.sh's own lines from the open-PR lookup through printing the PR, with gh a stub that finds an open PR and
 * exits `editExit` on `gh pr edit`, followed by a marker that stands for the merge decision.
 */
function existingPrBodyUpdate(editExit) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-pr-edit-'));
  try {
    const bin = path.join(dir, 'bin');
    stub(bin, 'gh', `if [ "$2" = list ]; then echo https://example.invalid/pr/7; exit 0; fi\nif [ "$2" = edit ]; then echo "HTTP 502" >&2; exit ${editExit}; fi\nexit 0`);
    const lines = readFileSync(SYNC, 'utf8').split('\n');
    const from = lines.findIndex((l) => l.startsWith('PR_URL="$(gh pr list'));
    const to = lines.findIndex((l, i) => i > from && l.startsWith('echo "PR: $PR_URL"'));
    assert.ok(from > -1 && to > from, 'no gh pr list .. echo "PR: $PR_URL" block in sync.sh');
    const body = path.join(dir, 'body.md');
    writeFileSync(body, 'report\n');
    const script = `fail() { echo "!!! $1"; exit 1; }\nFORK=o/r\nBRANCH=sync/x\nTODAY=2026-10-17\nBODY="${body}"\n${lines.slice(from, to + 1).join('\n')}\necho "merge decision reached"`;
    return spawnSync('bash', ['-c', script], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('an existing PR whose body update fails stops the run before the merge decision, so it cannot merge under a stale report (R28-scripts-b-X-01)', () => {
  const r = existingPrBodyUpdate(1);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^!!! gh pr edit failed; https:\/\/example\.invalid\/pr\/7 still shows an earlier run's report$/m, r.stdout);
  assert.doesNotMatch(r.stdout, /merge decision reached/);
});

test('an existing PR whose body update succeeds goes on to the merge decision (R28-scripts-b-X-01)', () => {
  const r = existingPrBodyUpdate(0);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PR: https:\/\/example\.invalid\/pr\/7$/m);
  assert.match(r.stdout, /^merge decision reached$/m);
});

// ---- Playwright's browser after an install without lifecycle scripts (SW3-scripts-04) ----

/** A worktree with an npx stub that logs its calls (or fails), and optionally an installed playwright package. */
function browserWorld({ playwright = true, npxExit = 0 } = {}) {
  const w = npmStubWorld();
  const npxLog = path.join(w.dir, 'npx.log');
  stub(w.bin, 'npx', `echo "$*" >> "${npxLog}"\nexit ${npxExit}`);
  if (playwright) {
    mkdirSync(path.join(w.repo, 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(path.join(w.repo, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","version":"1.64.0"}\n');
  }
  return { ...w, npx: () => (existsSync(npxLog) ? readFileSync(npxLog, 'utf8') : '') };
}

test('ensure_playwright_browser installs the installed Playwright\'s Chromium, the one postinstall step --ignore-scripts skips', () => {
  const w = browserWorld();
  try {
    const res = bashLib(w.repo, 'ensure_playwright_browser', w.env);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(w.npx(), '--no-install playwright install chromium\n');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('ensure_playwright_browser does nothing without Playwright, and fails when the browser cannot be installed', () => {
  const none = browserWorld({ playwright: false });
  const failing = browserWorld({ npxExit: 1 });
  try {
    assert.equal(bashLib(none.repo, 'ensure_playwright_browser', none.env).status, 0);
    assert.equal(none.npx(), '');
    const res = bashLib(failing.repo, 'ensure_playwright_browser', failing.env);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /cannot install Chromium for Playwright 1\.64\.0/);
  } finally {
    rmSync(none.dir, { recursive: true, force: true });
    rmSync(failing.dir, { recursive: true, force: true });
  }
});

test('sync.sh provides the browser after the baseline install and after the post-merge reinstall, before any suite runs, and fails the run when it cannot', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const lines = sync.split('\n');
  const at = (prefix, from = 0) => lines.findIndex((l, i) => i >= from && l.startsWith(prefix));
  const baseInstall = at('install_root_deps ignore-scripts');
  const baseSuite = at('suite_failures "$STATE_DIR/$TODAY.baseline-failures.txt"');
  const firstBrowser = at('ensure_playwright_browser || fail ', baseInstall);
  assert.ok(baseInstall > -1 && firstBrowser > baseInstall && firstBrowser < baseSuite, `baseline install=${baseInstall} browser=${firstBrowser} suite=${baseSuite}`);
  const refresh = at('refresh_root_deps ');
  const custom = at('custom_tests ');
  const secondBrowser = at('ensure_playwright_browser || fail ', refresh);
  assert.ok(refresh > -1 && secondBrowser > refresh && secondBrowser < custom, `refresh=${refresh} browser=${secondBrowser} custom=${custom}`);
});

// ---- the confinement gate data in contract.json (SW5-scripts-01) ----

const CONTRACT = 'custom/control-center/server/core/contract.json';
const contractDoc = (over = {}) => `${JSON.stringify({
  clis: [{ id: 'scan', script: 'scan.mjs', flags: ['--quiet'] }],
  claude: { approvedVersions: ['2.1.289'], flags: ['--restricted'] },
  playwrightMcp: { probed: false },
  ...over,
}, null, 2)}\n`;
/** heldUpstream with the fork's contract.json on main before the merge, then `edit` committed by the stand-in Claude. */
const contractRun = (edit) => heldUpstream({ forkFiles: { [CONTRACT]: contractDoc() }, claude: (repo) => commitFile(repo, CONTRACT, edit, 'fix(custom): follow upstream') });

test('an edit to the Claude versions or flags the confinement gate approves holds the PR (SW5-scripts-01)', () => {
  const r = contractRun(contractDoc({ claude: { approvedVersions: ['2.1.289', '2.1.300'], flags: ['--restricted'] } }));
  assert.equal(r.protectedEdits, CONTRACT);
});

test('turning the Playwright probe on for apply sessions holds the PR (SW5-scripts-01)', () => {
  assert.equal(contractRun(contractDoc({ playwrightMcp: { probed: true } })).protectedEdits, CONTRACT);
});

test('following an upstream flag rename in the CLI contract still auto-merges (SW5-scripts-01)', () => {
  const r = contractRun(contractDoc({ clis: [{ id: 'scan', script: 'scan.mjs', flags: ['--silent'] }] }));
  assert.equal(r.protectedEdits, '');
  assert.equal(r.unexpected, '');
});

test('a contract.json the gate cannot parse after the merge holds the PR (SW5-scripts-01)', () => {
  assert.equal(contractRun('{ not json\n').protectedEdits, CONTRACT);
});

test('sync.sh under test runs on the node running these specs, pinned the way the plist pins one (SW4-tests-26)', () => {
  const w = makeWorld();
  const home = path.join(w.base, 'home');
  mkdirSync(home);
  try {
    const seen = path.join(w.base, 'security-node.txt');
    // The Keychain lookup runs after sync.sh has set its PATH; it records which node that PATH finds and stops the run.
    const res = runSync(w, { home, security: `command -v node > "${seen}"\nexit 44` });
    assert.match(res.log, /Keychain item career-ops-claude-token not found/, res.log + res.stderr);
    assert.equal(readFileSync(seen, 'utf8').trim(), process.execPath, 'pinned-node.sh puts this node ahead of Homebrew on the job PATH');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
