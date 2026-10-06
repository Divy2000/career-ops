import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFixtureRoot, FAKE_CLAUDE, PACKAGE_ROOT } from '../helpers/app.js';
import { RunStore, type RunMeta } from '../../server/runner/store.js';
import { tempDir } from '../helpers/tmp.js';

const TSX = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
const SUPERVISOR = path.join(PACKAGE_ROOT, 'supervisor', 'index.ts');

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
function startSupervisor(port: number, dataRoot: string): Started {
  const proc = spawn(TSX, [SUPERVISOR], {
    cwd: PACKAGE_ROOT,
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
      CC_NO_RELOAD: '1',
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
