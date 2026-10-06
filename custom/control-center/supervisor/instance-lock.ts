// One supervisor per data root. Two instances on one root would both reconcile runs and sessions: the second
// marks the first one's queued runs lost and tracks its running sessions a second time. The lock is a file in the
// app's own state folder (no session may write there) naming its holder by PID and process start time, since PIDs
// are reused and start times are not. The start time is seconds since the epoch, read in a pinned environment: the
// text ps prints depends on the caller's TZ and locale, so two supervisors started differently would disagree about
// one live holder. Lives under supervisor/ so a broken server cannot break it.
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
  /**
   * When the holder started, in seconds since the epoch; null when it could not be read, or the lock is in the earlier
   * format (a ps string in the writer's TZ and locale, which cannot be compared): then the PID alone decides.
   */
  start: number | null;
  port: number;
}

/** A process's start in seconds since the epoch; 'unknown' when it runs but its start cannot be read; null when it does not run. */
export type ProcessStart = number | 'unknown' | null;

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `ps -o lstart` in the C locale: "Mon Oct  5 17:09:12 2026". */
const LSTART = /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** macOS's ps, by its absolute path: what PATH holds never decides which program answers, or whether one does. */
export const PS_PATH = '/bin/ps';

/** Signal 0 to a PID: what process.kill does, injected in tests (as root, or as PID 1 in a container, no real PID answers EPERM). */
export type KillProbe = (pid: number, signal: 0) => void;

/** Whether `pid` runs, asked of the kernel: ESRCH is gone; success or EPERM (another user's process) is running. */
function runningByKill(pid: number, kill: KillProbe): 'unknown' | null {
  try {
    kill(pid, 0);
    return 'unknown';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? null : 'unknown';
  }
}

/**
 * When a process started, from `ps -o lstart` run with LC_ALL=C and TZ=UTC whatever this process's environment is.
 * ps's own "no such process" (exit 1, nothing printed) is not running. When ps fails any other way (cannot start,
 * times out, dies) or prints a start that does not parse, the kernel is asked whether the PID runs: 'unknown' when
 * it does, which callers treat as running, null when it does not, so a crashed holder's lock never blocks a restart.
 */
export function processStartTime(pid: number, psPath: string = PS_PATH, kill: KillProbe = (p, s) => process.kill(p, s)): ProcessStart {
  let out: string;
  try {
    out = execFileSync(psPath, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { LC_ALL: 'C', TZ: 'UTC' } }).trim();
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; stdout?: string };
    return e.status === 1 && !e.signal && !String(e.stdout ?? '').trim() ? null : runningByKill(pid, kill);
  }
  const m = LSTART.exec(out);
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month === -1) return runningByKill(pid, kill);
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

export function instanceLockPath(dataRoot: string): string {
  return path.join(dataRoot, 'data', 'control-center', 'supervisor.lock');
}

function parseHolder(text: string): LockHolder | null {
  try {
    const h = JSON.parse(text) as Partial<LockHolder>;
    if (!Number.isInteger(h.pid) || (h.pid as number) <= 0 || !Number.isInteger(h.port)) return null;
    const start = (h as { start?: unknown }).start;
    return { pid: h.pid as number, start: typeof start === 'number' && Number.isFinite(start) ? start : null, port: h.port as number };
  } catch {
    return null;
  }
}

export function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

const aside = (file: string, why: string) => `${file}.${why}-${process.pid}-${crypto.randomUUID()}`;

/** Creates `file` holding `text`, whole, or returns false when a lock is already there. */
export function createWhole(file: string, text: string): boolean {
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
export function removeIf(file: string, expected: string): void {
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
export function acquireInstanceLock(dataRoot: string, me: { pid: number; port: number }, startTimeOf: (pid: number) => ProcessStart = processStartTime, now: () => number = Date.now): LockResult {
  const file = instanceLockPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const own = startTimeOf(me.pid);
  const text = JSON.stringify({ pid: me.pid, start: typeof own === 'number' ? own : null, port: me.port, nonce: crypto.randomUUID() } satisfies LockHolder & { nonce: string });
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
      // Stale only when the PID does not run, or runs a process that started at another time than the holder.
      const live = startTimeOf(holder.pid);
      if (live !== null && (holder.start === null || live === 'unknown' || live === holder.start)) return { ok: false, holder };
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
