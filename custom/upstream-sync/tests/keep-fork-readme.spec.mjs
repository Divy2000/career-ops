import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../keep-fork-readme.sh');
const SYNC = path.resolve(HERE, '../sync.sh');
const PROMPT = path.resolve(HERE, '../sync-prompt.md');
const README = '.github/README.md';

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

function write(repo, rel, text) {
  const file = path.join(repo, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function commit(repo, message) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

// A fork branch ("main") and an "upstream" branch that diverged from one base commit.
// forkFiles / upstreamFiles are { relPath: contents } written on each side.
function makeRepo({ forkFiles, upstreamFiles }) {
  const repo = mkdtempSync(path.join(tmpdir(), 'keep-readme-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'base.txt', 'base\n');
  commit(repo, 'base');
  git(repo, 'branch', 'upstream');
  for (const [rel, text] of Object.entries(forkFiles)) write(repo, rel, text);
  commit(repo, 'fork side');
  git(repo, 'checkout', '-q', 'upstream');
  for (const [rel, text] of Object.entries(upstreamFiles)) {
    if (text === null) git(repo, 'rm', '-q', '-f', rel);
    else write(repo, rel, text);
  }
  commit(repo, 'upstream side');
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

function merge(repo) {
  return spawnSync('git', ['merge', '--no-ff', '--no-edit', '-m', 'chore(sync): merge upstream main', 'upstream'], {
    cwd: repo, env: GIT_ENV, encoding: 'utf8',
  });
}

function runScript(repo, state, today = '2026-10-04') {
  return spawnSync('bash', [SCRIPT, state, today], { cwd: repo, env: GIT_ENV, encoding: 'utf8' });
}

function unmerged(repo) {
  return git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
}

function cleanup(...dirs) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

test('Given an add/add conflict on .github/README.md, when the script runs, then the fork README is kept and upstream copy is saved', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n', 'custom/a.txt': 'fork\n' },
    upstreamFiles: { [README]: 'UPSTREAM README\n', 'upstream-only.txt': 'u\n' },
  });
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    assert.notEqual(merge(repo).status, 0, 'the merge must conflict for this scenario to mean anything');
    assert.deepEqual(unmerged(repo), [README]);

    const res = runScript(repo, state);

    assert.equal(res.status, 10, res.stderr + res.stdout);
    assert.equal(readFileSync(path.join(repo, README), 'utf8'), 'FORK README\n');
    assert.equal(readFileSync(path.join(state, '2026-10-04.upstream-github-readme.md'), 'utf8'), 'UPSTREAM README\n');
    assert.deepEqual(unmerged(repo), []);
    assert.equal(existsSync(path.join(repo, 'upstream-only.txt')), true, 'the rest of the merge is kept');
  } finally {
    cleanup(repo, state);
  }
});

test('Given README is the only conflict, when the script runs, then it finishes the merge commit with both parents', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n' },
    upstreamFiles: { [README]: 'UPSTREAM README\n' },
  });
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    merge(repo);
    runScript(repo, state);

    const parents = git(repo, 'log', '-1', '--format=%P').trim().split(' ');
    assert.equal(parents.length, 2);
    assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'chore(sync): merge upstream main 2026-10-04');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=no').trim(), '');
  } finally {
    cleanup(repo, state);
  }
});

test('Given another file also conflicts, when the script runs, then only README is resolved and no commit is made', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n', 'shared.txt': 'fork shared\n' },
    upstreamFiles: { [README]: 'UPSTREAM README\n', 'shared.txt': 'upstream shared\n' },
  });
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    merge(repo);
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();

    const res = runScript(repo, state);

    assert.equal(res.status, 10, res.stderr + res.stdout);
    assert.deepEqual(unmerged(repo), ['shared.txt']);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), headBefore, 'merge stays open for the other conflict');
    assert.equal(readFileSync(path.join(repo, README), 'utf8'), 'FORK README\n');
  } finally {
    cleanup(repo, state);
  }
});

test('Given upstream deleted README while the fork kept it, when the script runs, then ours is kept and no upstream copy is written', () => {
  const repo2 = mkdtempSync(path.join(tmpdir(), 'keep-readme-'));
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    git(repo2, 'init', '-q', '-b', 'main');
    write(repo2, README, 'v1\n');
    commit(repo2, 'base');
    git(repo2, 'branch', 'upstream');
    write(repo2, README, 'FORK README v2\n');
    commit(repo2, 'fork edit');
    git(repo2, 'checkout', '-q', 'upstream');
    git(repo2, 'rm', '-q', README);
    commit(repo2, 'upstream delete');
    git(repo2, 'checkout', '-q', 'main');
    merge(repo2);
    assert.deepEqual(unmerged(repo2), [README]);

    const res = runScript(repo2, state);

    assert.equal(res.status, 10, res.stderr + res.stdout);
    assert.equal(readFileSync(path.join(repo2, README), 'utf8'), 'FORK README v2\n');
    assert.equal(existsSync(path.join(state, '2026-10-04.upstream-github-readme.md')), false);
    assert.deepEqual(unmerged(repo2), []);
  } finally {
    cleanup(repo2, state);
  }
});

test('Given README does not conflict, when the script runs, then it does nothing and exits 0', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n' },
    upstreamFiles: { 'upstream-only.txt': 'u\n' },
  });
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    assert.equal(merge(repo).status, 0);
    const headBefore = git(repo, 'rev-parse', 'HEAD').trim();

    const res = runScript(repo, state);

    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), headBefore);
    assert.equal(existsSync(path.join(state, '2026-10-04.upstream-github-readme.md')), false);
  } finally {
    cleanup(repo, state);
  }
});

test('Given a README conflict on an earlier state-dir run, when the script runs again the same day, then the saved upstream copy is replaced', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n' },
    upstreamFiles: { [README]: 'UPSTREAM README v2\n' },
  });
  const state = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  try {
    writeFileSync(path.join(state, '2026-10-04.upstream-github-readme.md'), 'stale\n');
    merge(repo);
    runScript(repo, state);
    assert.equal(readFileSync(path.join(state, '2026-10-04.upstream-github-readme.md'), 'utf8'), 'UPSTREAM README v2\n');
  } finally {
    cleanup(repo, state);
  }
});

test('Given missing arguments, when the script runs, then it exits 2 with a usage message', () => {
  const res = spawnSync('bash', [SCRIPT], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/i);
});

test('Given a state dir that does not exist, when README conflicts, then the script creates it', () => {
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n' },
    upstreamFiles: { [README]: 'UPSTREAM README\n' },
  });
  const parent = mkdtempSync(path.join(tmpdir(), 'keep-readme-state-'));
  const state = path.join(parent, 'nested', 'state');
  try {
    merge(repo);
    const res = runScript(repo, state);
    assert.equal(res.status, 10, res.stderr + res.stdout);
    assert.equal(existsSync(path.join(state, '2026-10-04.upstream-github-readme.md')), true);
  } finally {
    cleanup(repo, parent);
  }
});

test('sync.sh runs keep-fork-readme.sh right after the merge and before headless Claude', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const merged = sync.indexOf('git merge --no-ff');
  const hook = sync.indexOf('keep-fork-readme.sh');
  const claude = sync.indexOf('claude -p');
  assert.ok(merged > -1 && hook > merged && claude > hook, `order was merge=${merged} hook=${hook} claude=${claude}`);
});

test('sync.sh blocks auto-merge when the fork README had to be kept', () => {
  const sync = readFileSync(SYNC, 'utf8');
  assert.match(sync, /KEPT_README=1/);
  assert.match(sync, /\$KEPT_README = 0 \]/, 'auto-merge condition must require KEPT_README = 0');
  assert.match(sync, /\.github\/README\.md/);
});

test('sync.sh excludes .github/README.md from the files-differ-from-upstream report', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const line = sync.split('\n').find((l) => l.startsWith('CHANGED_UPSTREAM="$(git diff'));
  assert.ok(line, 'CHANGED_UPSTREAM line not found');
  assert.ok(line.includes("':(exclude).github/README.md'"), line);

  // Run the real line against a repo where only custom/ and the README differ from upstream.
  const repo = makeRepo({
    forkFiles: { [README]: 'FORK README\n', 'custom/a.txt': 'fork\n' },
    upstreamFiles: { 'upstream-only.txt': 'u\n' },
  });
  try {
    merge(repo);
    git(repo, 'update-ref', 'refs/remotes/upstream/main', git(repo, 'rev-parse', 'upstream').trim());
    const out = execFileSync('bash', ['-c', `${line}\nprintf '%s' "$CHANGED_UPSTREAM"`], {
      cwd: repo, env: GIT_ENV, encoding: 'utf8',
    });
    assert.equal(out, '');
  } finally {
    cleanup(repo);
  }
});

test('sync-prompt.md tells Claude the fork keeps .github/README.md and that custom/ holds the other additions', () => {
  const prompt = readFileSync(PROMPT, 'utf8');
  assert.match(prompt, /\.github\/README\.md/);
  assert.match(prompt, /always keep (the fork's|ours)/i);
  assert.equal(prompt.includes(String.fromCharCode(0x2014)), false, 'no em dash');
});
