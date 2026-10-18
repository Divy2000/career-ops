// The Dev Chat git diff card reads custom/ through plain git diff, which never shows untracked files: a turn that only
// added a file left the card saying clean (R22-feat-a-L2-01). The route lists untracked files under custom/ too.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionManager } from '../../server/claude/manager.js';
import { devchatRoutes } from '../../server/routes/devchat.js';
import type { Exec } from '../../server/routes/system.js';
import { testConfig } from '../helpers/app.js';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
let repo: string;
// The host's global and system config (commit signing, a failing core.hooksPath) and any exported GIT_DIR, GIT_WORK_TREE
// or GIT_INDEX_FILE would otherwise break the setup commit or send it to another repository.
const LOCAL_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of [...LOCAL_VARS, 'GIT_CONFIG_PARAMETERS']) delete env[k];
  return env;
};
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe', env: gitEnv() });
beforeAll(async () => {
  repo = tempDir('cc-r22-wl-repo-');
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'custom', 'web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'custom', 'web', 'Old.tsx'), 'old\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'custom/ignored.log\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  t = await makeTestApp({ codeRoot: repo });
});
afterAll(async () => {
  await t?.close();
});
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });

describe('GET /api/dev/git-diff', () => {
  it('reports clean with no tracked change and no untracked file', async () => {
    const body = (await get('/api/dev/git-diff')).json();
    expect(body).toMatchObject({ ok: true, diff: '', untracked: [] });
  });

  it('lists a file a turn added under custom/, but not ignored files or files outside custom/', async () => {
    fs.mkdirSync(path.join(repo, 'custom', 'web', 'insights'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'custom', 'web', 'insights', 'NewTab.tsx'), 'new\n');
    fs.writeFileSync(path.join(repo, 'custom', 'ignored.log'), 'x\n');
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'x\n');
    const body = (await get('/api/dev/git-diff')).json();
    expect(body.ok).toBe(true);
    expect(body.diff).toBe('');
    expect(body.untracked).toEqual(['custom/web/insights/NewTab.tsx']);
  });
});

// The route alone, with git replaced by a fake that answers per subcommand.
async function routeWith(answer: (args: string[]) => Awaited<ReturnType<Exec>>) {
  const app = Fastify();
  await devchatRoutes(app, { cfg: testConfig(), manager: {} as SessionManager, exec: async (_cmd, args) => answer(args) });
  const body = (await app.inject({ method: 'GET', url: '/api/dev/git-diff' })).json();
  await app.close();
  return body;
}

describe('GET /api/dev/git-diff with git answers it cannot fully read', () => {
  it('stays ok when only the full diff overflowed the output buffer', async () => {
    const body = await routeWith((args) => (args[0] === 'diff' && !args.includes('--stat') ? { code: 1, stdout: 'diff --git a/x b/x', stderr: '' } : { code: 0, stdout: args[0] === 'diff' ? ' 1 file changed' : '', stderr: '' }));
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.diff).toBe('diff --git a/x b/x');
  });

  it('is not ok when the full diff failed without output', async () => {
    const body = await routeWith((args) => (args[0] === 'diff' && !args.includes('--stat') ? { code: 124, stdout: '', stderr: 'git timed out after 15 s', timedOut: true } : { code: 0, stdout: args[0] === 'diff' ? ' 1 file changed' : '', stderr: '' }));
    expect(body.ok).toBe(false);
    expect(body.error).toBe('git timed out after 15 s');
  });

  it('caps a huge untracked list and reports how many there are', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => `custom/build/f${i}.js`);
    const body = await routeWith((args) => ({ code: 0, stdout: args[0] === 'ls-files' ? many.join('\0') + '\0' : '', stderr: '' }));
    expect(body.untracked).toHaveLength(500);
    expect(body.untracked[0]).toBe('custom/build/f0.js');
    expect(body.untrackedTotal).toBe(1200);
  });

  it('is not ok when the untracked listing fails', async () => {
    const body = await routeWith((args) => (args[0] === 'ls-files' ? { code: 128, stdout: '', stderr: 'fatal: boom' } : { code: 0, stdout: '', stderr: '' }));
    expect(body.ok).toBe(false);
    expect(body.error).toBe('fatal: boom');
  });
});
