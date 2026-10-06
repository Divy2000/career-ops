// One supervisor per data root. Two instances on one root would both reconcile runs and sessions: the second
// marks the first one's queued runs lost and tracks its running sessions a second time. The lock is a file in the
// app's own state folder (no session may write there) naming its holder by PID and process start time, since PIDs
// are reused and start times are not. Lives under supervisor/ so a broken server cannot break it.
//
// Every change is atomic: a lock appears whole (a finished temp file linked into place, which fails if one is
// there), and one is removed only by renaming it away and then checking it is the lock that was meant (each lock
// carries a nonce). A lock taken by mistake, because it changed between reading and renaming, is linked back.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface LockHolder {
  pid: number;
  /** `ps -o lstart` of the holder when it took the lock; null when that could not be read. */
  startedAt: string | null;
  port: number;
}

export type LockResult =
  | {
      ok: true;
      /** Removes this lock, and only this lock. */
      release: () => void;
      /** Whether the lock on disk is still this one: checked before the instance starts the work only one may do. */
      verify: () => boolean;
    }
  | { ok: false; holder: LockHolder | null };

/** A lock file that cannot be parsed is damaged; one younger than this may still be settling and is left alone. */
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

const aside = (file: string, why: string) => `${file}.${why}-${process.pid}-${crypto.randomUUID()}`;

/** Creates `file` holding `text`, whole, or returns false when a lock is already there. */
function createWhole(file: string, text: string): boolean {
  const tmp = aside(file, 'new');
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Removes the lock at `file` if it is exactly `expected`, atomically: whatever is there is renamed away first, so no
 * other process can put a lock in between the check and the removal. A different lock that was renamed away by
 * mistake is linked back; if yet another lock took its place meanwhile, the displaced one stays out and its owner's
 * verify() fails before it starts any work.
 */
function removeIf(file: string, expected: string): void {
  const moved = aside(file, 'old');
  try {
    fs.renameSync(file, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    if (readOrNull(moved) === expected) return;
    try {
      fs.linkSync(moved, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    fs.rmSync(moved, { force: true });
  }
}

/**
 * Takes the data root's lock for this process, or names the live instance that holds it. A lock whose holder is
 * gone (the PID is dead or now another process) is stale and replaced, but only that lock: see removeIf.
 */
export function acquireInstanceLock(dataRoot: string, me: { pid: number; port: number }, startTimeOf: (pid: number) => string | null = processStartTime, now: () => number = Date.now): LockResult {
  const file = instanceLockPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ pid: me.pid, startedAt: startTimeOf(me.pid), port: me.port, nonce: crypto.randomUUID() } satisfies LockHolder & { nonce: string });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (createWhole(file, text)) {
      return {
        ok: true,
        // A quick look first, so an instance whose lock was displaced never even briefly moves the current one.
        release: () => {
          if (readOrNull(file) === text) removeIf(file, text);
        },
        verify: () => readOrNull(file) === text,
      };
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
    removeIf(file, seen);
  }
  return { ok: false, holder: null };
}
