// A claim file another server process on the same roots (blue/green) honours: held by a live process, taken over once
// its holder is gone (dead, or a reused PID). The session turn claim and the posting claim both use it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWhole, processStartTime, readOrNull, removeIf, UNREADABLE_LOCK_GRACE_MS, type ProcessStart } from '../../supervisor/instance-lock.js';

let ownStart: ProcessStart | undefined;

/** The replacement lock beside a claim (`{file}.replace`), or null while another process holds it. Returns its release. */
function lockReplace(file: string, text: string): (() => void) | null {
  const lock = `${file}.replace`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createWhole(lock, text)) return () => removeIf(lock, text);
    const seen = readOrNull(lock);
    if (seen === null) continue;
    let age: number;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    // Replacing takes milliseconds, so a lock this old is a crashed holder's.
    if (age < UNREADABLE_LOCK_GRACE_MS) return null;
    removeIf(lock, seen);
  }
  return null;
}

/**
 * Whether the process a claim names is gone: dead or a reused PID. A live holder keeps its claim however long it
 * prepares (a slow token read), since a peer starting beside it would run two paid turns, and so does one ps cannot
 * date or that recorded no start of its own. A claim cut short is gone once the unreadable grace has passed.
 */
export function turnClaimGone(file: string, text: string, startOf: (pid: number) => ProcessStart = processStartTime): boolean {
  let holder: { pid?: unknown; start?: unknown; at?: unknown };
  try {
    holder = JSON.parse(text) as typeof holder;
  } catch {
    return unreadableClaimGone(file);
  }
  if (!Number.isInteger(holder.pid) || (holder.pid as number) <= 0 || typeof holder.at !== 'number') return unreadableClaimGone(file);
  const start = startOf(holder.pid as number);
  if (start === null) return true;
  // A holder that runs but whose start ps cannot tell is held: freeing a live one would start a second paid turn.
  if (start === 'unknown') return false;
  // Only a start that differs proves the PID reused; a live holder that recorded none keeps its claim.
  return typeof holder.start === 'number' && start !== holder.start;
}

/** A claim with no readable holder is gone once the unreadable grace has passed, or once its holder removed it. */
function unreadableClaimGone(file: string): boolean {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st === undefined || Date.now() - st.mtimeMs >= UNREADABLE_LOCK_GRACE_MS;
}

/**
 * Takes the claim at `file` for this process, or replaces one whose holder is gone. Returns the release, which removes
 * this claim and only this one, or null while a live process (this one or a peer) holds it.
 */
export function takeProcessClaim(file: string): (() => void) | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Asked again until ps dates this process: a claim with no start of its own is never freed while the PID runs.
  if (typeof ownStart !== 'number') ownStart = processStartTime(process.pid);
  const text = JSON.stringify({ pid: process.pid, start: ownStart, at: Date.now(), nonce: crypto.randomUUID() });
  const release = () => removeIf(file, text);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createWhole(file, text)) return release;
    const seen = readOrNull(file);
    if (seen === null) continue;
    if (!turnClaimGone(file, seen)) break;
    // Replaced under a lock of its own: two processes replacing one stale claim at once could otherwise move aside the
    // claim the other just took, and lose it when a third creates one meanwhile.
    const unlock = lockReplace(file, text);
    if (!unlock) break;
    try {
      if (readOrNull(file) === seen) removeIf(file, seen);
      if (createWhole(file, text)) return release;
    } finally {
      unlock();
    }
  }
  return null;
}

/** Whether a live process (this one or a peer) holds the claim at `file`. */
export function processClaimHeld(file: string): boolean {
  const seen = readOrNull(file);
  return seen !== null && !turnClaimGone(file, seen);
}

/**
 * Where a posting's evaluation claim lives: held while a process checks that no session evaluates the posting and
 * records the one that will, so two server processes cannot both pass the check and start two paid evaluations.
 */
export function postingClaimFile(guardRoot: string, key: string): string {
  return path.join(guardRoot, 'posting-claims', `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}.claim`);
}
