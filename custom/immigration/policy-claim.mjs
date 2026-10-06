// One AI policy pass at a time, whoever starts it: the scheduled daily job (run-daily.sh policy_watch) or a Control
// Center session (Sponsorship > Run AI policy pass). Two passes at once take the same queued items, which are
// acknowledged only when a pass ends done, and both append the same rows to policy-changes.tsv and company-alerts.tsv
// and a digest section. A pass takes the queue by holding data/immigration/.policy-pass.claim:
//   { owner, batch, at }  owner is session:<id>, daily:<pid>, or starting:<nonce> while a session is being created.
// A claim whose owner is gone is stale and taken over: a session that no longer exists or has a final status
// (done, error, cancelled; a paused awaiting_user pass keeps it), a daily job whose pid is dead, no longer the one
// .run-daily.pid names or no longer bash running run-daily.sh, or a start that never became a session within a few minutes. Every read-decide-write of the
// claim runs under a short mkdir lock, so two claimants never both win.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const IMM = path.join('data', 'immigration');
const LIVE_SESSION = new Set(['queued', 'running', 'awaiting_user']);
const STARTING_MS = 2 * 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

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
    const at = Date.parse(claim.at);
    return Number.isFinite(at) && now - at < STARTING_MS;
  }
  return false;
}

const DAILY_JOB_RE = /^([^ ]*\/)?bash ([^-].*\/)?run-daily\.sh( |$)/;

/**
 * Whether pid's command is bash running run-daily.sh. Only ps describing another command, or no process at all, is
 * proof the job is gone; a ps that cannot run says nothing, so the job is taken to hold its claim (a skipped pass is
 * retried, two passes at once append the same rows twice).
 */
function isDailyJob(pid) {
  let out;
  try {
    out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch (err) {
    // ps exits 1 with no output when no process has the pid (it ended after the liveness check).
    return !(err.status === 1 && !String(err.stdout ?? '').trim());
  }
  return DAILY_JOB_RE.test(out.trim());
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

/** Runs fn under the claim's mkdir lock; a lock left by a crashed holder is broken after LOCK_STALE_MS. */
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
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`${lock} is held by another claimant; try again`);
      else sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function write(dataRoot, claim) {
  const file = claimFile(dataRoot);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(claim));
  fs.renameSync(tmp, file);
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
    write(dataRoot, { owner, batch, at: held?.owner === owner ? held.at : new Date().toISOString() });
    return { ok: true };
  });
}

/** Hands the claim from `from` to `to` (a started session takes over its starting:<nonce> claim); false when `from` does not hold it. */
export function retagClaim(dataRoot, from, to) {
  return locked(dataRoot, () => {
    const held = readClaim(dataRoot);
    if (held?.owner !== from) return false;
    write(dataRoot, { ...held, owner: to });
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
