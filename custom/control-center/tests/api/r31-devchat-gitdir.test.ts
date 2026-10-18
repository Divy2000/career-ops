// The Dev Chat git diff card ran git with the server's environment, so a server started from a shell or git hook that
// exports GIT_DIR (or GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_PARAMETERS...) diffed another repository instead of the
// code root (R31-devchat-gitdir). Every child the server starts now gets those repository overrides removed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { childEnv } from '../../server/system/child-env.js';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
const saved = Object.fromEntries(REPO_VARS.map((k) => [k, process.env[k]]));
const restore = () => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

function makeRepo(prefix: string, file: string): string {
  const repo = tempDir(prefix);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe', env: cleanGitEnv() });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'custom', 'Tracked.txt'), 'old\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'custom', 'Tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'custom', file), 'new\n');
  return repo;
}

describe('GET /api/dev/git-diff with repository overrides in the server environment', () => {
  let t: TestApp;
  let codeRoot: string;
  let other: string;
  beforeAll(async () => {
    codeRoot = makeRepo('cc-r31-gitdir-code-', 'Mine.txt');
    other = makeRepo('cc-r31-gitdir-other-', 'Theirs.txt');
    t = await makeTestApp({ codeRoot });
  });
  afterEach(restore);
  afterAll(async () => {
    restore();
    await t.close();
  });
  const get = async () => (await t.app.inject({ method: 'GET', url: '/api/dev/git-diff', headers: t.authed })).json();

  it('diffs the code root, not the repository GIT_DIR and GIT_WORK_TREE name', async () => {
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    const body = await get();
    expect(body.ok).toBe(true);
    expect(body.untracked).toEqual(['custom/Mine.txt']);
    expect(body.diff).toContain('+changed');
  });

  it('ignores an exported GIT_INDEX_FILE and config injected through the environment', async () => {
    process.env.GIT_INDEX_FILE = path.join(other, 'no-such-index');
    process.env.GIT_CONFIG_PARAMETERS = "'diff.noprefix'='true'";
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'diff.mnemonicPrefix';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    const body = await get();
    expect(body.ok).toBe(true);
    expect(body.untracked).toEqual(['custom/Mine.txt']);
    expect(body.diff).toContain('--- a/custom/Tracked.txt');
  });
});

describe('childEnv', () => {
  it('drops the repository overrides git reads from the environment and keeps other GIT_ settings', () => {
    const base = Object.fromEntries([...REPO_VARS.map((k) => [k, 'x']), ['GIT_TERMINAL_PROMPT', '0'], ['PATH', '/bin']]);
    const env = childEnv({}, base);
    for (const k of REPO_VARS) expect(env, k).not.toHaveProperty(k);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.PATH).toBe('/bin');
  });

  it('keeps a repository variable a caller passes explicitly', () => {
    expect(childEnv({ GIT_DIR: '/explicit' }, { GIT_DIR: '/inherited' }).GIT_DIR).toBe('/explicit');
  });
});
