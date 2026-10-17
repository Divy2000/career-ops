#!/usr/bin/env node
// Releases or refreshes a session's report-number reservation sentinel only while it is still the session's, under the
// tracker lock reserve-report-num.mjs takes to reserve, release and garbage-collect sentinels. Checked outside the lock,
// the sentinel could be collected and claimed by another reservation between the check and the unlink or touch.
//
//   node reservation-sentinel.mjs --release <num> --since <ms>
//   node reservation-sentinel.mjs --refresh <num> --since <ms>
//
// The sentinel is the session's when its created_at is no later than `since`, when the session got the number. Prints
// one JSON line {"outcome": ...}: released / refreshed, gone (no sentinel), not-owned (another reservation's) or
// unreadable (left alone: whose it is cannot be told). Exits 1 when the lock or the file cannot be handled.
import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from '../../../../path-resolver.mjs';
import { acquireTrackerLock, resolveTrackerPath, trackerLockDirFor } from '../../../../tracker-utils.mjs';
import { isMainModule } from '../../../../lib/is-main-module.mjs';

/** Under the exec timeout the server gives this script, so a busy lock is reported as a failure the server retries. */
const LOCK_TIMEOUT_MS = 15_000;

function readCreatedAt(sentinel) {
  let text;
  try {
    text = fs.readFileSync(sentinel, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { gone: true };
    throw err;
  }
  try {
    const at = Date.parse(JSON.parse(text).created_at ?? '');
    return Number.isNaN(at) ? { at: null } : { at };
  } catch {
    return { at: null };
  }
}

function settle(action, sentinel, since) {
  const read = readCreatedAt(sentinel);
  if (read.gone) return 'gone';
  if (read.at === null) return 'unreadable';
  if (read.at > since) return 'not-owned';
  if (action === 'release') {
    fs.unlinkSync(sentinel);
    return 'released';
  }
  const now = new Date();
  fs.utimesSync(sentinel, now, now);
  return readCreatedAt(sentinel).at === read.at ? 'refreshed' : 'not-owned';
}

async function main(argv) {
  const [flag, numArg, sinceFlag, sinceArg] = argv;
  const action = flag === '--release' ? 'release' : flag === '--refresh' ? 'refresh' : null;
  const num = Number(numArg);
  const since = Number(sinceArg);
  if (!action || !/^\d+$/.test(numArg ?? '') || num < 1 || sinceFlag !== '--since' || !Number.isFinite(since)) {
    process.stderr.write('Usage: node reservation-sentinel.mjs --release|--refresh <num> --since <ms>\n');
    return 1;
  }
  const root = getCareerOpsRoot();
  const tracker = resolveTrackerPath(root);
  const sentinel = path.join(root, 'reports', `${String(num).padStart(3, '0')}-RESERVED.md`);
  const lock = await acquireTrackerLock(trackerLockDirFor(tracker), {
    // Never above its own bound: a child the server's exec timeout kills while it holds the lock leaves the lock behind.
    timeoutMs: Math.min(Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || LOCK_TIMEOUT_MS, LOCK_TIMEOUT_MS),
    retryMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75,
    staleMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000,
    tracker,
  });
  try {
    process.stdout.write(`${JSON.stringify({ outcome: settle(action, sentinel, since) })}\n`);
  } finally {
    lock.release();
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`reservation-sentinel: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
