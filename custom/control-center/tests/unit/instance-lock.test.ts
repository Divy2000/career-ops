import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstanceLock, instanceLockPath, UNREADABLE_LOCK_GRACE_MS, type LockResult } from '../../supervisor/instance-lock.js';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

/** Process start times by PID; a PID that is missing is not running. */
const procs = (table: Record<number, string>) => (pid: number) => table[pid] ?? null;

describe('supervisor instance lock (one Control Center per data root)', () => {
  it('the first instance takes the lock; a second, while the first runs, is refused and told which one holds it', () => {
    const root = tempDir('cc-lock-');
    const running = procs({ 100: 'Mon Oct  5 10:00:00 2026', 200: 'Mon Oct  5 10:05:00 2026' });
    const first = acquireInstanceLock(root, { pid: 100, port: 4400 }, running);
    expect(first.ok).toBe(true);
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, running)).toEqual({ ok: false, holder: { pid: 100, startedAt: 'Mon Oct  5 10:00:00 2026', port: 4400 } });
    if (first.ok) first.release();
    expect(fs.existsSync(instanceLockPath(root))).toBe(false);
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, running).ok).toBe(true);
  });

  it('a lock left by an instance that is gone is replaced: its PID is not running, or now belongs to a process started later', () => {
    for (const later of [procs({ 200: 'Mon Oct  5 11:00:00 2026' }), procs({ 100: 'Tue Oct  6 09:00:00 2026', 200: 'Mon Oct  5 11:00:00 2026' })]) {
      const root = tempDir('cc-lock-');
      expect(acquireInstanceLock(root, { pid: 100, port: 4400 }, procs({ 100: 'Mon Oct  5 10:00:00 2026' })).ok).toBe(true);
      const second = acquireInstanceLock(root, { pid: 200, port: 4401 }, later);
      expect(second.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(instanceLockPath(root), 'utf8'))).toMatchObject({ pid: 200, port: 4401 });
    }
  });

  it('release removes only its own lock, never one another instance took over since', () => {
    const root = tempDir('cc-lock-');
    const first = acquireInstanceLock(root, { pid: 100, port: 4400 }, procs({ 100: 'Mon Oct  5 10:00:00 2026' }));
    // The first instance looked dead to a later one (a PID check from another namespace), which took the lock.
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, procs({ 200: 'Mon Oct  5 11:00:00 2026' })).ok).toBe(true);
    if (first.ok) first.release();
    expect(JSON.parse(fs.readFileSync(instanceLockPath(root), 'utf8'))).toMatchObject({ pid: 200 });
  });

  it('a lock that cannot be parsed is an instance still writing it, unless it is old: then it is replaced', () => {
    const root = tempDir('cc-lock-');
    fs.mkdirSync(fs.realpathSync(root) + '/data/control-center', { recursive: true });
    fs.writeFileSync(instanceLockPath(root), '');
    const t0 = fs.statSync(instanceLockPath(root)).mtimeMs;
    const running = procs({ 200: 'Mon Oct  5 11:00:00 2026' });
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, running, () => t0 + 100)).toEqual({ ok: false, holder: null });
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, running, () => t0 + UNREADABLE_LOCK_GRACE_MS + 1).ok).toBe(true);
  });

  it('a holder whose start time could not be read counts as running while its PID is', () => {
    const root = tempDir('cc-lock-');
    expect(acquireInstanceLock(root, { pid: 100, port: 4400 }, () => null).ok).toBe(true);
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, procs({ 100: 'Mon Oct  5 10:00:00 2026' }))).toMatchObject({ ok: false, holder: { pid: 100, startedAt: null } });
    // ...and as gone once its PID is not running.
    expect(acquireInstanceLock(root, { pid: 200, port: 4401 }, procs({ 200: 'Mon Oct  5 11:00:00 2026' })).ok).toBe(true);
  });
});

describe('two supervisors taking over one stale lock (SW-claude-02 review)', () => {
  afterEach(() => vi.restoreAllMocks());
  const STALE = { pid: 100, port: 4400 };
  const A = { pid: 200, port: 4401 };
  const B = { pid: 300, port: 4402 };
  // 100 is gone; A and B are running.
  const alive = procs({ 200: 'Mon Oct  5 11:00:00 2026', 300: 'Mon Oct  5 11:00:01 2026' });
  const staleRoot = () => {
    const root = tempDir('cc-lock-race-');
    expect(acquireInstanceLock(root, STALE, procs({ 100: 'Mon Oct  5 10:00:00 2026' })).ok).toBe(true);
    return root;
  };
  const MUTATORS = ['writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'linkSync', 'openSync', 'mkdirSync', 'copyFileSync'] as const;

  /**
   * Runs taker A and, right before A's k-th file-system change in the lock folder, all of taker B: every point at which
   * a second supervisor can come in. Returns null once A finishes before its k-th change (B then simply runs after A).
   */
  function race(k: number): { a: LockResult; b: LockResult; root: string } | null {
    const root = staleRoot();
    const dir = path.dirname(instanceLockPath(root));
    let changes = 0;
    let inB = false;
    let b: LockResult | null = null;
    for (const name of MUTATORS) {
      const original = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
      vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (!inB && String(args[0]).startsWith(dir) && ++changes === k) {
          inB = true;
          try {
            b = acquireInstanceLock(root, B, alive);
          } finally {
            inB = false;
          }
        }
        return original.apply(fs, args);
      }) as never);
    }
    const a = acquireInstanceLock(root, A, alive);
    vi.restoreAllMocks();
    if (!b) return null;
    return { a, b, root };
  }

  it('wherever the second one comes in, exactly one wins, and the lock on disk is the winner\'s', () => {
    let points = 0;
    for (let k = 1; ; k++) {
      const r = race(k);
      if (!r) break;
      points++;
      const winners = [r.a, r.b].filter((x) => x.ok);
      expect(winners, `B came in before A's change #${k}`).toHaveLength(1);
      const winner = winners[0] as Extract<LockResult, { ok: true }>;
      const loser = [r.a, r.b].find((x) => !x.ok) as Extract<LockResult, { ok: false }>;
      expect(winner.verify(), `change #${k}`).toBe(true);
      expect(JSON.parse(fs.readFileSync(instanceLockPath(r.root), 'utf8')).pid, `change #${k}`).toBe(r.a.ok ? A.pid : B.pid);
      expect(loser.holder?.pid, `change #${k}`).toBe(r.a.ok ? A.pid : B.pid);
      // Nothing is left beside the lock.
      expect(fs.readdirSync(path.dirname(instanceLockPath(r.root))).filter((n) => n.startsWith('supervisor.lock'))).toEqual(['supervisor.lock']);
    }
    expect(points).toBeGreaterThan(1);
  });

  it('two real processes started at the same moment on a stale lock: exactly one wins', async () => {
    const script = path.join(tempDir('cc-lock-proc-'), 'take.mjs');
    fs.writeFileSync(script, [
      `import fs from 'node:fs';`,
      `import { acquireInstanceLock } from ${JSON.stringify(path.join(PACKAGE_ROOT, 'supervisor', 'instance-lock.ts'))};`,
      `const [root, go, end] = process.argv.slice(2);`,
      `console.log('ready');`,
      `while (!fs.existsSync(go)) {}`,
      `const r = acquireInstanceLock(root, { pid: process.pid, port: 4500 });`,
      `console.log(JSON.stringify({ ok: r.ok }));`,
      // A winner stays alive until both have answered: once it exits its lock is stale, and the next one may take it.
      `const wait = () => (fs.existsSync(end) ? process.exit(0) : setTimeout(wait, 10));`,
      `wait();`,
    ].join('\n'));
    const run = (root: string, go: string, end: string) => {
      const child = spawn(process.execPath, [script, root, go, end], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      return { ready: () => out.includes('ready'), answered: () => /\{"ok":(true|false)\}/.test(out), done: new Promise<string>((resolve) => child.on('exit', () => resolve(out))) };
    };
    for (let round = 0; round < 5; round++) {
      const root = tempDir('cc-lock-proc-root-');
      // A lock naming this test process with another start time: the PID lives, but not the process that wrote it.
      fs.mkdirSync(path.dirname(instanceLockPath(root)), { recursive: true });
      fs.writeFileSync(instanceLockPath(root), JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970', port: 4399, nonce: 'stale' }));
      const go = path.join(root, 'go');
      const end = path.join(root, 'end');
      const takers = [run(root, go, end), run(root, go, end)];
      const deadline = Date.now() + 20_000;
      while (!takers.every((t) => t.ready())) {
        if (Date.now() > deadline) throw new Error('the takers did not start');
        await new Promise((r) => setTimeout(r, 20));
      }
      fs.writeFileSync(go, '');
      while (!takers.every((t) => t.answered())) {
        if (Date.now() > deadline) throw new Error('the takers did not answer');
        await new Promise((r) => setTimeout(r, 20));
      }
      fs.writeFileSync(end, '');
      const outs = await Promise.all(takers.map((t) => t.done));
      const results = outs.map((o) => JSON.parse(o.trim().split('\n').at(-1)!) as { ok: boolean });
      expect(results.filter((r) => r.ok), outs.join(' | ')).toHaveLength(1);
    }
  });
});
