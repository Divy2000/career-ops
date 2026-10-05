import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { acquireInstanceLock, instanceLockPath, UNREADABLE_LOCK_GRACE_MS } from '../../supervisor/instance-lock.js';
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
