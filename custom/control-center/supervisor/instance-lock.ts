// One supervisor per data root. Two instances on one root would both reconcile runs and sessions: the second
// marks the first one's queued runs lost and tracks its running sessions a second time. The lock is a file in the
// app's own state folder (no session may write there) naming its holder by PID and process start time, since PIDs
// are reused and start times are not. Lives under supervisor/ so a broken server cannot break it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface LockHolder {
  pid: number;
  /** `ps -o lstart` of the holder when it took the lock; null when that could not be read. */
  startedAt: string | null;
  port: number;
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockHolder | null };

/** A lock file that cannot be parsed is being written by a starting instance, unless it is older than this. */
export const UNREADABLE_LOCK_GRACE_MS = 5000;

/** `ps -o lstart` of a live process, null when there is none. */
export function processStartTime(pid: number): string | null {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

export function instanceLockPath(dataRoot: string): string {
  return path.join(dataRoot, 'data', 'control-center', 'supervisor.lock');
}

function parseHolder(text: string): LockHolder | null {
  try {
    const h = JSON.parse(text) as Partial<LockHolder>;
    if (!Number.isInteger(h.pid) || (h.pid as number) <= 0 || !Number.isInteger(h.port)) return null;
    return { pid: h.pid as number, startedAt: typeof h.startedAt === 'string' ? h.startedAt : null, port: h.port as number };
  } catch {
    return null;
  }
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Takes the data root's lock for this process, or names the live instance that holds it. A lock whose holder is
 * gone (the PID is dead or now another process) is stale and replaced, but only while it still holds what was read.
 */
export function acquireInstanceLock(dataRoot: string, me: { pid: number; port: number }, startTimeOf: (pid: number) => string | null = processStartTime, now: () => number = Date.now): LockResult {
  const file = instanceLockPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ pid: me.pid, startedAt: startTimeOf(me.pid), port: me.port } satisfies LockHolder);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          if (readOrNull(file) === text) fs.rmSync(file, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const seen = readOrNull(file);
    if (seen === null) continue;
    const holder = parseHolder(seen);
    if (holder) {
      const started = startTimeOf(holder.pid);
      if (started !== null && (holder.startedAt === null || holder.startedAt === started)) return { ok: false, holder };
    } else {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (now() - mtimeMs < UNREADABLE_LOCK_GRACE_MS) return { ok: false, holder: null };
    }
    if (readOrNull(file) === seen) fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: null };
}
