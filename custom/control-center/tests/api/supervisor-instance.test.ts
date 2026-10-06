import { describe, expect, it } from 'vitest';
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
function startSupervisor(port: number, dataRoot: string, opts: { packageRoot?: string; reload?: boolean } = {}): Started {
  const pkg = opts.packageRoot ?? PACKAGE_ROOT;
  const proc = spawn(TSX, [path.join(pkg, 'supervisor', 'index.ts')], {
    cwd: pkg,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CC_PORT: String(port),
      CC_TOKEN: 'supervisor-instance-test-token',
      CC_DATA_ROOT: dataRoot,
      CC_GUARD_DIR: tempDir('cc-sup-guard-'),
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
