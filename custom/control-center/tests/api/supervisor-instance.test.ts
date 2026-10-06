import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFixtureRoot, FAKE_CLAUDE, PACKAGE_ROOT } from '../helpers/app.js';
import { RunStore, type RunMeta } from '../../server/runner/store.js';
import { tempDir } from '../helpers/tmp.js';

const TSX = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');

/** A port nothing listens on right now (the OS picks it, so it is never 4317 or 4390). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

interface Started {
  proc: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

/** A real supervisor (and its server child) on a temp data root, hermetic like the e2e servers. */
function startSupervisor(port: number, dataRoot: string, opts: { packageRoot?: string; reload?: boolean; guardRoot?: string; env?: NodeJS.ProcessEnv } = {}): Started {
  const pkg = opts.packageRoot ?? PACKAGE_ROOT;
  const proc = spawn(TSX, [path.join(pkg, 'supervisor', 'index.ts')], {
    cwd: pkg,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CC_PORT: String(port),
      CC_TOKEN: 'supervisor-instance-test-token',
      CC_DATA_ROOT: dataRoot,
      CC_GUARD_DIR: opts.guardRoot ?? tempDir('cc-sup-guard-'),
      CC_CLAUDE_BIN: FAKE_CLAUDE,
      CC_FAKE_TOKEN: 'supervisor-instance-fake-token',
      CC_FAKE_LAUNCHD: '1',
      CC_LAUNCH_AGENTS_DIR: path.join(dataRoot, '.launch-agents'),
      CC_CLAUDE_PROJECTS_DIR: path.join(dataRoot, '.claude-projects'),
      CC_NO_OPEN: '1',
      // The code root stays this checkout (path-resolver.mjs, the core modules) when the package itself is a copy.
      CC_CODE_ROOT: path.resolve(PACKAGE_ROOT, '..', '..'),
      ...(opts.reload ? {} : { CC_NO_RELOAD: '1' }),
      CC_FAKE_DAILY: 'idle',
      // tsx keeps a cache in TMPDIR; give the processes their own, removed with this file's temp dirs.
      TMPDIR: tempDir('cc-sup-tmp-'),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  return { proc, output: () => out, exited };
}

async function until(pred: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Ready, or exited first: whichever happens. */
async function settled(s: Started): Promise<'ready' | 'exited'> {
  let exited = false;
  void s.exited.then(() => (exited = true));
  await until(() => exited || s.output().includes('Control Center ready'), 'the supervisor to be ready or exit');
  return exited ? 'exited' : 'ready';
}

async function stop(s: Started): Promise<void> {
  if (s.proc.exitCode !== null || s.proc.signalCode !== null) return;
  s.proc.kill('SIGTERM');
  await s.exited;
}

/** A run left queued on disk: what a running instance holds in its in-memory queue, or a restart finds. */
function queuedRun(dataRoot: string): RunMeta {
  return new RunStore(dataRoot).create({ actionId: 'test.queued', label: 'queued run', cost: 'free', resources: [], claude: false, cmd: { bin: process.execPath, args: ['-e', '0'], cwd: dataRoot }, params: {} });
}
const statusOf = (dataRoot: string, id: string) => new RunStore(dataRoot).read(id)?.status;

describe('one Control Center per data root (SW-claude-02)', () => {
  it('a second launch on the same data root refuses to start and leaves the running instance\'s queued runs alone', async () => {
    const root = copyFixtureRoot();
    const leftover = queuedRun(root);
    const portA = await freePort();
    const a = startSupervisor(portA, root);
    let b: Started | null = null;
    try {
      expect(await settled(a), a.output()).toBe('ready');
      // The first instance still reconciles once it serves: a run left queued by an earlier process is settled.
      await until(() => statusOf(root, leftover.id) === 'lost', 'the first instance to settle the leftover run');
      const held = queuedRun(root);
      b = startSupervisor(await freePort(), root);
      expect(await settled(b), b.output()).toBe('exited');
      expect(await b.exited).toBe(1);
      expect(b.output()).toMatch(/already running on this data root/);
      expect(b.output()).toContain(`port ${portA}`);
      expect(statusOf(root, held.id)).toBe('queued');
    } finally {
      if (b) await stop(b);
      await stop(a);
    }
  });

  it('a stray .DS_Store in the sessions folder does not stop the child when it activates after listen (SW2-claude-01)', async () => {
    const root = copyFixtureRoot();
    const sessions = path.join(root, 'data', 'control-center', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, '.DS_Store'), 'finder');
    const leftover = queuedRun(root);
    const s = startSupervisor(await freePort(), root);
    try {
      expect(await settled(s), s.output()).toBe('ready');
      // Activation reconciled runs and then sessions: the leftover run is settled, and the child is still serving.
      await until(() => statusOf(root, leftover.id) === 'lost', 'the child to reconcile after listen');
      await new Promise((r) => setTimeout(r, 1000));
      expect(s.proc.exitCode, s.output()).toBeNull();
      expect(s.output()).not.toMatch(/server child exited|bad session id/);
    } finally {
      await stop(s);
    }
  });

  it('a Dev Chat edit that breaks a module the server and the old supervisor load still leaves /__recovery up, and the fix brings the app back (SW2-claude-05)', async () => {
    // A copy of the package (its node_modules linked), so the broken file is never this checkout's.
    const pkg = path.join(tempDir('cc-sup-pkg-'), 'control-center');
    for (const part of ['server', 'shared', 'supervisor', 'web', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.web.json']) fs.cpSync(path.join(PACKAGE_ROOT, part), path.join(pkg, part), { recursive: true });
    fs.symlinkSync(path.join(PACKAGE_ROOT, 'node_modules'), path.join(pkg, 'node_modules'));
    const theme = path.join(pkg, 'shared', 'page-theme.ts');
    const good = fs.readFileSync(theme, 'utf8');
    fs.writeFileSync(theme, 'export const PAGE_THEME_CSS = ;\n');
    const port = await freePort();
    const s = startSupervisor(port, copyFixtureRoot(), { packageRoot: pkg, reload: true });
    const get = (url: string, cookie = '') =>
      new Promise<{ status: number; body: string; setCookie: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: url, headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers['set-cookie'] ?? '') }));
        }).on('error', reject);
      });
    try {
      await until(() => /Recovery page:/.test(s.output()) || s.proc.exitCode !== null, 'the supervisor to listen');
      expect(s.proc.exitCode, s.output()).toBeNull();
      const login = await get('/__recovery?t=supervisor-instance-test-token');
      expect(login.status).toBe(302);
      const cookie = login.setCookie.split(';')[0]!;
      const page = await get('/__recovery', cookie);
      expect(page.status, page.body).toBe(200);
      expect(page.body).toContain('Control Center recovery');
      // Every other route says the server is down and where to recover.
      const app = await get('/', cookie);
      expect(app.status).toBe(503);
      expect(app.body).toContain('/__recovery');
      // The Dev Chat change is undone (here by hand): the reload that follows brings the server child up.
      fs.writeFileSync(theme, good);
      const deadline = Date.now() + 60_000;
      for (;;) {
        const health = await get('/healthz').catch(() => ({ status: 0, body: '', setCookie: '' }));
        if (health.status === 200) break;
        if (Date.now() > deadline || s.proc.exitCode !== null) throw new Error(`the app did not come back\n${s.output()}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      await stop(s);
    }
  });

  /** A port held open, so a server child told to listen there (CC_CHILD_PORT) cannot start until it is released. */
  async function heldPort() {
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)));
    return { port, release: () => new Promise<void>((resolve) => blocker.close(() => resolve())) };
  }
  type Reply = { status: number; body: string; setCookie: string };
  const request = (port: number, method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers['set-cookie'] ?? '') }));
      });
      req.on('error', reject);
      req.end();
    });
  const signIn = async (port: number) => (await request(port, 'GET', '/__recovery?t=supervisor-instance-test-token')).setCookie.split(';')[0]!;

  it('with CC_NO_RELOAD set, a server child that cannot start still stops the supervisor with exit 1 (SW2-claude-05 review)', async () => {
    const held = await heldPort();
    const s = startSupervisor(await freePort(), copyFixtureRoot(), { env: { CC_CHILD_PORT: String(held.port) } });
    try {
      // Bounded below the test timeout, so a supervisor that stays up is still stopped by the finally block.
      await until(() => s.proc.exitCode !== null, 'the supervisor to exit', 30_000);
      expect(s.proc.exitCode, s.output()).toBe(1);
      expect(s.output()).toMatch(/server child could not start/);
    } finally {
      await stop(s);
      await held.release();
    }
  });

  it('a first start that fails with no Dev Chat change shows its error, not a change to blame, and /__recovery/restart retries it (SW2-claude-05 review)', async () => {
    const held = await heldPort();
    const port = await freePort();
    const s = startSupervisor(port, copyFixtureRoot(), { reload: true, env: { CC_CHILD_PORT: String(held.port) } });
    let released = false;
    try {
      await until(() => /Recovery page:/.test(s.output()) || s.proc.exitCode !== null, 'the supervisor to listen');
      expect(s.proc.exitCode, s.output()).toBeNull();
      // Not signed in: the way to recovery, nothing about the failure.
      const anonymous = await request(port, 'GET', '/');
      expect(anonymous.status).toBe(503);
      expect(anonymous.body).toContain('/__recovery');
      expect(anonymous.body).not.toMatch(/EADDRINUSE|exited before listening/);
      const cookie = await signIn(port);
      const down = await request(port, 'GET', '/', { cookie });
      expect(down.status).toBe(503);
      expect(down.body).toMatch(/server child exited before listening/);
      expect(down.body).toMatch(/EADDRINUSE/);
      expect(down.body).not.toMatch(/last change|Dev Chat/i);
      expect(down.body).toContain('/__recovery');
      const page = await request(port, 'GET', '/__recovery', { cookie });
      expect(page.body).toMatch(/<form method="post" action="\/__recovery\/restart" data-cc="restart">/);
      // The same rules as a revert: signed in, from the app origin, with X-CC.
      const origin = `http://127.0.0.1:${port}`;
      expect((await request(port, 'POST', '/__recovery/restart', { origin, 'x-cc': '1' })).status).toBe(401);
      expect((await request(port, 'POST', '/__recovery/restart', { cookie })).status).toBe(403);
      expect((await request(port, 'POST', '/__recovery/restart', { cookie, origin })).status).toBe(403);
      expect((await request(port, 'POST', '/__recovery/restart', { cookie, origin: 'http://127.0.0.1:4387', 'x-cc': '1' })).status).toBe(403);
      const again = await request(port, 'POST', '/__recovery/restart', { cookie, origin, 'x-cc': '1' });
      expect(again.status, again.body).toBe(502);
      expect(again.body).toMatch(/still does not start: server child exited before listening/);
      expect(s.proc.exitCode).toBeNull();
      // Once the cause is gone, a restart brings the app up without restarting the supervisor.
      await held.release();
      released = true;
      const restart = await request(port, 'POST', '/__recovery/restart', { cookie, origin, 'x-cc': '1' });
      expect(restart.status, restart.body).toBe(200);
      expect((await request(port, 'GET', '/healthz')).status).toBe(200);
      expect(s.proc.exitCode).toBeNull();
    } finally {
      await stop(s);
      if (!released) await held.release();
    }
  });

  it('a first start that fails after a Dev Chat turn changed files points at reverting that turn (SW2-claude-05 review)', async () => {
    const root = copyFixtureRoot();
    const guardRoot = tempDir('cc-sup-guard-devchat-');
    const id = 's20261005000000-abcdef';
    fs.mkdirSync(path.join(root, 'data', 'control-center', 'sessions', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'control-center', 'sessions', id, 'meta.json'), JSON.stringify({ id, mode: 'devchat', status: 'done', createdAt: '2026-10-05T00:00:00.000Z', turns: [{ n: 1 }] }));
    fs.mkdirSync(path.join(guardRoot, 'sessions', id, 'turns', '1'), { recursive: true });
    fs.writeFileSync(path.join(guardRoot, 'sessions', id, 'turns', '1', 'turn.json'), JSON.stringify({ filesOffset: 0 }));
    // The turn's edit of a server file is still on disk: the file holds the bytes the turn left (only read here, never written).
    const edited = path.join(PACKAGE_ROOT, 'server', 'index.ts');
    const left = crypto.createHash('sha256').update(fs.readFileSync(edited)).digest('hex');
    fs.writeFileSync(path.join(guardRoot, 'sessions', id, 'turns', '1', 'after.json'), JSON.stringify({ files: { [edited]: left } }));
    fs.writeFileSync(path.join(guardRoot, 'sessions', id, 'files.ndjson'), `${JSON.stringify({ path: 'custom/control-center/server/index.ts', abs: edited, root: 'code', tool: 'Edit', ts: 't', sha256: left })}\n`);
    const held = await heldPort();
    const port = await freePort();
    const s = startSupervisor(port, root, { reload: true, guardRoot, env: { CC_CHILD_PORT: String(held.port) } });
    try {
      await until(() => /Recovery page:/.test(s.output()) || s.proc.exitCode !== null, 'the supervisor to listen');
      expect(s.proc.exitCode, s.output()).toBeNull();
      const down = await request(port, 'GET', '/', { cookie: await signIn(port) });
      expect(down.status).toBe(503);
      expect(down.body).toMatch(/Dev Chat turn/);
      expect(down.body).toMatch(/server child exited before listening/);
    } finally {
      await stop(s);
      await held.release();
    }
  });

  it('a launch whose port is taken reconciles nothing on its own data root before it exits', async () => {
    const root = copyFixtureRoot();
    const leftover = queuedRun(root);
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port)));
    const s = startSupervisor(port, root);
    try {
      expect(await settled(s), s.output()).toBe('exited');
      expect(await s.exited).toBe(1);
      expect(s.output()).toMatch(/already in use/);
      expect(statusOf(root, leftover.id)).toBe('queued');
      // Its instance lock went with it: the next launch on this root is not refused.
      expect(fs.readdirSync(path.join(root, 'data', 'control-center')).filter((n) => n.endsWith('.lock'))).toEqual([]);
    } finally {
      await stop(s);
      await new Promise((r) => blocker.close(r));
    }
  });
});
