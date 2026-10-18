// One AI policy pass at a time, whoever starts it: the scheduled daily job (run-daily.sh policy_watch) or a Control
// Center session (Sponsorship > Run AI policy pass). Two passes at once take the same queued items, which are
// acknowledged only when a pass ends done, and both append the same rows to policy-changes.tsv and company-alerts.tsv
// and a digest section. A pass takes the queue by holding data/immigration/.policy-pass.claim:
//   { owner, batch, at }  owner is session:<id>, daily:<pid>, or starting:<nonce> while a session is being created;
//   a starting claim also names the process creating it: { pid, pidStart, pidAt } (its pid, when it wrote them, and its
//   start time in seconds since the epoch, read under a pinned TZ and locale: ps text depends on the caller's zone, and
//   the Control Center and the launchd daily job run in different ones; an earlier claim's string pidStart holds when
//   it is that start in some zone).
// A claim whose owner is gone is stale and taken over: a session that no longer exists or has a final status
// (done, error, cancelled; a paused awaiting_user pass keeps it), a daily job whose pid is dead, no longer the one
// .run-daily.pid names or no longer bash running run-daily.sh, or a start whose process has exited (a start can wait on a Keychain prompt
// for as long as it is left open, so no time limit applies while that process runs; an earlier-format claim, whose
// zone-ambiguous start can match a reused pid by chance, or one whose writer could not read its own start time, holds
// for at most a day). Every read-decide-write of the
// claim runs under a short mkdir lock, so two claimants never both win.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const IMM = path.join('data', 'immigration');
const LIVE_SESSION = new Set(['queued', 'running', 'awaiting_user']);
const STARTING_MS = 2 * 60_000;
const LEGACY_START_MS = 24 * 60 * 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
// The recover guard lives for a stat and an rm, so one older than this was left by a claimant killed while breaking.
const GUARD_STALE_MS = 5_000;

export const claimFile = (dataRoot) => path.join(dataRoot, IMM, '.policy-pass.claim');

/** The current claim, or null when there is none or it cannot be read (a torn or hand-edited file holds nothing). */
export function readClaim(dataRoot) {
  let text;
  try {
    text = fs.readFileSync(claimFile(dataRoot), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const c = JSON.parse(text);
    return c && typeof c.owner === 'string' ? c : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Whether the claim's owner can still be running its pass. */
export function ownerLive(dataRoot, claim, now = Date.now()) {
  const [kind, ...rest] = claim.owner.split(':');
  const id = rest.join(':');
  if (kind === 'session') {
    if (!/^[\w-]+$/.test(id)) return false;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', 'control-center', 'sessions', id, 'meta.json'), 'utf8'));
      // A cancelled session's Claude process can outlive its status for seconds (SIGTERM, then SIGKILL): it still holds.
      return LIVE_SESSION.has(meta.status) || runUnfinished(dataRoot, meta.turns?.at(-1)?.runId);
    } catch {
      return false;
    }
  }
  if (kind === 'daily') {
    const pid = Number(id);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
    // A reused pid is not the job: the job's lock holder writes its own pid to .run-daily.pid, and its command is bash
    // running run-daily.sh (the pattern the Control Center's daily probe uses, server/system/daily.ts).
    try {
      if (fs.readFileSync(path.join(dataRoot, IMM, '.run-daily.pid'), 'utf8').trim() !== String(pid)) return false;
    } catch {
      return false;
    }
    return isDailyJob(pid);
  }
  if (kind === 'starting') {
    if (claim.pid === undefined) {
      // A claim written before starts named their process: only a recent one holds.
      const at = Date.parse(claim.at);
      return Number.isFinite(at) && now - at < STARTING_MS;
    }
    if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || !pidAlive(claim.pid)) return false;
    const started = processStart(claim.pid);
    if (typeof claim.pidStart === 'string') {
      // A claim written before start times were epoch seconds holds ps text in its writer's zone, which cannot be
      // pinned now: it names this process when it is the same start in some zone (a whole quarter-hour offset of at
      // most 14 hours). Text that does not parse proves nothing while the claim is recent.
      if (started === undefined || started === null) return started === undefined;
      const wall = lstartSeconds(claim.pidStart);
      if (wall === undefined) {
        const at = Date.parse(claim.at);
        return Number.isFinite(at) && now - at < STARTING_MS;
      }
      // A reused pid started a whole quarter-hour away matches by chance, so the match holds for a day, not for good.
      const offset = wall - started;
      const at = Date.parse(claim.at);
      return Math.abs(offset) <= 14 * 3600 && offset % 900 === 0 && Number.isFinite(at) && now - at < LEGACY_START_MS;
    }
    // Only ps naming another start time is proof the pid was reused; a ps that cannot run says nothing.
    if (started === undefined) return true;
    if (typeof claim.pidStart === 'number') return started === claim.pidStart;
    // Its writer could not read its own start time. A process started after the claim was written cannot be that
    // writer; one started before may be, but a reused pid matches that too, so it holds for a day, not for good. A
    // retag keeps the claim's at, so the time the writer named itself is pidAt (an earlier claim has only at).
    const at = Date.parse(claim.pidAt ?? claim.at);
    return started !== null && Number.isFinite(at) && started * 1000 <= at && now - at < LEGACY_START_MS;
  }
  return false;
}

// The Control Center server calls these checks in-process, so ps must not inherit its environment (CC_TOKEN, the
// session secret, Anthropic credentials) or be looked up through a PATH that npm puts node_modules/.bin on (as
// server/runner/runner.ts runs it). The pinned locale and zone keep lstart text comparable across callers.
const PS = '/bin/ps';
const PS_ENV = { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' };

const DAILY_JOB_RE = /^([^ ]*\/)?bash ([^-].*\/)?run-daily\.sh( |$)/;

/**
 * Whether pid's command is bash running run-daily.sh. Only ps describing another command, or no process at all, is
 * proof the job is gone; a ps that cannot run says nothing, so the job is taken to hold its claim (a skipped pass is
 * retried, two passes at once append the same rows twice).
 */
function isDailyJob(pid) {
  let out;
  try {
    out = execFileSync(PS, ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: PS_ENV });
  } catch (err) {
    // ps exits 1 with no output when no process has the pid (it ended after the liveness check).
    return !(err.status === 1 && !String(err.stdout ?? '').trim());
  }
  return DAILY_JOB_RE.test(out.trim());
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * pid's start time in seconds since the epoch, from ps run with LC_ALL=C and TZ=UTC whatever this process's environment
 * is (as supervisor/instance-lock.ts reads it); null when no process has the pid, undefined when ps cannot tell.
 */
function processStart(pid) {
  let out;
  try {
    out = execFileSync(PS, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: PS_ENV }).trim();
  } catch (err) {
    return err.status === 1 && !String(err.stdout ?? '').trim() ? null : undefined;
  }
  return lstartSeconds(out);
}

/** ps lstart text read as a UTC wall clock, in seconds since the epoch; undefined when it does not parse. */
function lstartSeconds(text) {
  const m = LSTART.exec(text);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month === -1) return undefined;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

let ownStart;
/** This process, as a starting claim names it; a start time ps could not give is asked for again next time. */
function self() {
  if (typeof ownStart !== 'number') ownStart = processStart(process.pid);
  return { pid: process.pid, pidStart: ownStart ?? null, pidAt: new Date().toISOString() };
}

/**
 * Whether a Control Center run has not ended yet: its record has no end time and its wrapper wrote no exit record. A
 * run with no record has ended (the runner writes it before it spawns); one whose record cannot be read for another
 * reason is taken to be running still.
 */
export function runUnfinished(dataRoot, runId) {
  if (typeof runId !== 'string' || !/^[\w-]+$/.test(runId)) return false;
  const dir = path.join(dataRoot, 'data', 'control-center', 'runs', runId);
  if (fs.existsSync(path.join(dir, 'exit.json'))) return false;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  } catch (err) {
    return !(err.code === 'ENOENT' || err.code === 'ENOTDIR');
  }
  try {
    return !JSON.parse(text).endedAt;
  } catch {
    // The runner replaces its record by rename, so text that is not JSON was edited by hand: it holds nothing.
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const statOrNull = (dir) => fs.statSync(dir, { throwIfNoEntry: false }) ?? null;
// The same directory, not one removed and made again at the path (pipeline-lock.mjs's sameLockDirectory).
const sameLockDirectory = (a, b) => a.dev === b.dev && a.ino === b.ino && (a.ino !== 0 || a.birthtimeMs === b.birthtimeMs);
const isStale = (stat, ms = LOCK_STALE_MS) => Date.now() - stat.mtimeMs > ms;

/** The lock's owner record, { token, pid }, or null while it is not written yet or cannot be read. */
function lockOwner(lock) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8'));
    return o && typeof o.token === 'string' && Number.isSafeInteger(o.pid) && o.pid > 0 ? o : null;
  } catch {
    return null;
  }
}

// A lock is broken once it is old, or at once when the process it names has exited (killed inside the lock, its
// finally never ran). A reused pid reads as alive, so that lock still waits out LOCK_STALE_MS.
function breakable(lock, stat) {
  if (isStale(stat)) return true;
  const o = lockOwner(lock);
  return o !== null && !pidAlive(o.pid);
}

/**
 * Breaks the lock when it is stale; true when it was removed. The verdict and the removal run under a recover guard,
 * and the lock is judged again under it and removed only when it is still the stale directory first judged: another
 * claimant may have broken it meanwhile and taken a new one, which is live (pipeline-lock.mjs, same race).
 */
function breakStale(lock) {
  const judged = statOrNull(lock);
  if (!judged || !breakable(lock, judged)) return false;
  const guard = `${lock}.recover`;
  let mine;
  try {
    fs.mkdirSync(guard);
    mine = statOrNull(guard);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // A guard left by a claimant killed while breaking would block recovery for good, so an old one is removed. A
    // mkdir lock cannot compare and remove in one step, so a fresh guard taken between the stat and the rm can be lost
    // (pipeline-lock.mjs has the same limit); the lock itself is still judged again under whichever guard wins.
    const held = statOrNull(guard);
    if (held && isStale(held, GUARD_STALE_MS)) fs.rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    const now = statOrNull(lock);
    if (!now || !sameLockDirectory(judged, now) || !breakable(lock, now)) return false;
    // A claimant paused past GUARD_STALE_MS has had its guard taken over; it then decides nothing.
    const guardNow = statOrNull(guard);
    if (!mine || !guardNow || !sameLockDirectory(mine, guardNow)) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    return true;
  } finally {
    const guardNow = statOrNull(guard);
    if (mine && guardNow && sameLockDirectory(mine, guardNow)) fs.rmSync(guard, { recursive: true, force: true });
  }
}

/**
 * Runs fn under the claim's mkdir lock; a lock left by a crashed holder is broken once its process is gone, or after
 * LOCK_STALE_MS when that cannot be told.
 */
function locked(dataRoot, fn) {
  const lock = `${claimFile(dataRoot)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (breakStale(lock)) continue;
      if (Date.now() > deadline) throw new Error(`${lock} is held by another claimant; try again`);
      sleep(25);
    }
  }
  // A token inside the lock names this claimant: one held so long it was broken as stale may now be another
  // claimant's, even at the same inode (a file system that reuses inodes at once), and only this token proves it is not.
  // The pid lets a claimant that finds the lock tell that its holder was killed inside it.
  const token = randomUUID();
  const owner = path.join(lock, 'owner');
  try {
    fs.writeFileSync(owner, JSON.stringify({ token, pid: process.pid }));
  } catch (err) {
    fs.rmSync(lock, { recursive: true, force: true });
    throw err;
  }
  try {
    return fn();
  } finally {
    // Unreadable proves nothing about who holds it: it is left to age out rather than fail fn's own outcome.
    if (lockOwner(lock)?.token === token) fs.rmSync(lock, { recursive: true, force: true });
  }
}

function write(dataRoot, claim) {
  const file = claimFile(dataRoot);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(claim));
    fs.renameSync(tmp, file);
  } finally {
    // The write or rename error is the one to report; a temp file that cannot be removed too is only noted.
    try {
      fs.rmSync(tmp, { force: true });
    } catch (err) {
      process.stderr.write(`note: could not remove the temp file ${tmp}: ${err.message}\n`);
    }
  }
}

/**
 * Takes the claim for `owner` (or keeps it, when `owner` already holds it): { ok: true }, or { ok: false, holder } when
 * a live owner holds it. A stale claim is taken over, and so is one `takeFrom` holds (a fork continues the pass of the
 * paused session it forks).
 *
 * @param {string} dataRoot
 * @param {{ owner: string, batch?: string | null, takeFrom?: string | null }} claimant
 * @returns {{ ok: true } | { ok: false, holder: { owner: string, batch: string | null, at: string } }}
 */
export function tryClaim(dataRoot, { owner, batch = null, takeFrom = null }) {
  return locked(dataRoot, () => {
    const held = readClaim(dataRoot);
    if (held && held.owner !== owner && held.owner !== takeFrom && ownerLive(dataRoot, held)) return { ok: false, holder: held };
    write(dataRoot, { owner, batch, at: held?.owner === owner ? held.at : new Date().toISOString(), ...(owner.startsWith('starting:') ? self() : {}) });
    return { ok: true };
  });
}

/** Hands the claim from `from` to `to` (a started session takes over its starting:<nonce> claim); false when `from` does not hold it. */
export function retagClaim(dataRoot, from, to) {
  return locked(dataRoot, () => {
    const held = readClaim(dataRoot);
    if (held?.owner !== from) return false;
    write(dataRoot, { owner: to, batch: held.batch ?? null, at: held.at, ...(to.startsWith('starting:') ? self() : {}) });
    return true;
  });
}

/** Releases the claim when `owner` holds it; false otherwise (another pass's claim is never removed). */
export function releaseClaim(dataRoot, owner) {
  return locked(dataRoot, () => {
    if (readClaim(dataRoot)?.owner !== owner) return false;
    fs.rmSync(claimFile(dataRoot), { force: true });
    return true;
  });
}
