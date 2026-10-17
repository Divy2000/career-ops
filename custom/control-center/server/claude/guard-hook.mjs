#!/usr/bin/env node
// PreToolUse / PostToolUse guard (spec 4.4). Plain .mjs: the Claude CLI runs it
// with the hook JSON on stdin; CC_POLICY_FILE points at the session policy.
// Exit 2 blocks the tool call and the stderr text becomes the reason.
// This file is only ever an entry point: it runs unconditionally, so no
// argv/URL comparison (which a symlink or a space in the path defeats) can
// turn the guard into a silent no-op. Importable helpers live in guard-policy.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HOOK_TIMEOUT_S } from './confinement.mjs';
import { checkBash, checkFetchUrl, checkFetchUrls, checkPlaywright, checkRead, checkSearch, httpUrlsIn, locate, narrowGrepInput, PLAYWRIGHT_TOOL_PREFIX, readUrlList, findSnapshot, snapshotKey, tokenize, urlListFilesIn, writeTarget } from './guard-policy.mjs';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function snapshot(sessionDir, abs) {
  fs.mkdirSync(path.join(sessionDir, 'before'), { recursive: true });
  // The first write of the turn keeps the bytes: one taken under the older name (a turn that began before the rename) counts.
  if (findSnapshot(sessionDir, abs)) return;
  const key = snapshotKey(sessionDir, abs);
  if (fs.existsSync(abs)) fs.copyFileSync(abs, key);
  else fs.writeFileSync(`${key}.absent`, '');
}

/** True when the file exists, is non-empty and its last byte is not a newline. */
function endsTorn(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

// The report numbers the session holds, logged in its folder (manager.ts HELD_REPORT_NUMS_FILE), each record on a line
// of its own: `+N=<created_at ms>;` from the app, naming the reservation by its sentinel's created_at, `-N@<tool id>;`
// from here once a release lets one go, and the app's `+N@<tool id>;` that gives a failed release's hold back, honoured
// only right after that same call's `-N`. A record cut short (no `;`) holds nothing, and the next one starts its own
// line rather than joining it.
const HELD_REPORT_NUMS_FILE = 'held-report-nums.log';
const HELD_RECORD = /^([+-])(\d+)(?:=(\d+(?:~[A-Za-z0-9_-]{1,100})?)|@([A-Za-z0-9_-]{1,100}))?;$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SENTINEL_TOKEN = /^[A-Za-z0-9_-]{1,100}$/;
// Held while one release checks and consumes holds, so two releases of one number at once never both pass.
const HELD_LOCK_FILE = 'held-report-nums.lock';
// A lock whose content never got written (its hook died between creating and writing it) is replaced this old.
const HELD_LOCK_UNREADABLE_MS = 2_000;
// Waited out for the lock: past the age an unreadable lock is replaced at, and well inside the hook's own timeout.
const HELD_LOCK_WAIT_MS = 7_000;
const PS_PATH = '/bin/ps';
// The CLI stops a hook after HOOK_TIMEOUT_S: a lock older than that whose holder ps could not date is a dead hook's.
const HELD_LOCK_MAX_MS = (HOOK_TIMEOUT_S + 5) * 1000;
// Held while one waiter replaces a dead hook's lock, so two never replace it at once; replaced as a dead hook's lock is.
const HELD_TAKEOVER_FILE = 'held-report-nums.lock.takeover';
// The allocator's CLI reads --release <NNN>[-<MMM>] this way; an argument it would refuse is left to its usage error.
const RELEASE_ARG = /^(\d+)(?:-(\d+))?$/;
const RELEASE_MAX = 50;
// The app records a number the session reserved once the run's result reaches it (it polls the output): a release
// right after the reservation waits for that record this long before it is refused.
const HELD_WAIT_MS = 3000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** The numbers held, each with the created_at of the reservation it holds. */
function heldReportNums(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const held = new Map();
  // The release that last let each number go, and the reservation the hold it ended named.
  const letGo = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(HELD_RECORD);
    if (!m) continue;
    const num = Number(m[2]);
    if (m[1] === '-') {
      letGo.set(num, { id: m[4] ?? null, at: held.get(num) ?? null });
      held.delete(num);
    } else if (m[3] !== undefined) {
      held.set(num, m[3]);
      letGo.delete(num);
    } else if (m[4] !== undefined && letGo.get(num)?.id === m[4] && letGo.get(num).at !== null && !held.has(num)) {
      held.set(num, letGo.get(num).at);
      letGo.delete(num);
    }
  }
  return held;
}

// reserve-report-num.mjs --gc collects a sentinel untouched for 4 hours, outside any check made here; one this old is
// not released, so the release that runs after this check can never meet a sentinel collected and reserved again.
const RELEASE_MAX_SENTINEL_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * Which reservation report `num`'s sentinel is, `<created_at ms>~<token>` as the app records it (the token the allocator
 * gives each reservation tells apart two made in one millisecond): 'gone' without one, null when it cannot be read or
 * is old enough that the allocator may collect it before the release runs.
 */
function sentinelIdentity(dataRoot, num) {
  const file = path.join(dataRoot, 'reports', `${String(num).padStart(3, '0')}-RESERVED.md`);
  let text;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs >= RELEASE_MAX_SENTINEL_AGE_MS) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // One that cannot be read (a folder in its place, no permission) is no reservation this session can be shown to hold.
    return err.code === 'ENOENT' ? 'gone' : null;
  }
  try {
    const sentinel = JSON.parse(text);
    const at = Date.parse(sentinel.created_at ?? '');
    if (Number.isNaN(at)) return null;
    return typeof sentinel.token === 'string' && SENTINEL_TOKEN.test(sentinel.token) ? `${at}~${sentinel.token}` : String(at);
  } catch {
    return null;
  }
}

/**
 * When process `pid` started, as ps prints it: null when it does not run, 'unknown' when ps cannot tell (the kernel is
 * asked whether it runs instead).
 */
function processStart(pid) {
  try {
    const out = execFileSync(PS_PATH, ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { LC_ALL: 'C', TZ: 'UTC' } }).trim();
    if (out) return out;
  } catch (err) {
    if (err.status === 1 && !err.signal && !String(err.stdout ?? '').trim()) return null;
  }
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (err) {
    return err.code === 'ESRCH' ? null : 'unknown';
  }
}

/**
 * Whether the hook a lock names is gone: its process dead, or its pid since reused by a process that started at another
 * time. A live holder keeps the lock as long as it runs; one that recorded no start is gone once older than a hook may
 * live, and a lock with no readable holder once it is old.
 */
function lockHolderGone(lock, text) {
  let holder = null;
  try {
    holder = JSON.parse(text);
  } catch {
    /* written only partly */
  }
  const age = Date.now() - fs.statSync(lock).mtimeMs;
  if (!Number.isInteger(holder?.pid) || holder.pid <= 0) return age >= HELD_LOCK_UNREADABLE_MS;
  const start = processStart(holder.pid);
  if (start === null) return true;
  // A holder ps dated is replaced only once it is gone: a live one replaced could remove the new lock as it finishes.
  if (typeof holder.start === 'string') return start !== 'unknown' && start !== holder.start;
  return age >= HELD_LOCK_MAX_MS;
}

/** A file's text, or null once it is gone. */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Removes a dead holder's lock `seen`, holding the takeover marker so no other waiter replaces it meanwhile: while the
 * marker is held the lock changes only by its holder, and a dead holder never removes it.
 */
function takeOverLock(dir, lock, seen, mine) {
  const marker = path.join(dir, HELD_TAKEOVER_FILE);
  try {
    fs.writeFileSync(marker, mine, { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Another waiter's marker, gone already when it finished: the next try takes it.
    const other = readIfPresent(marker);
    try {
      if (other !== null && lockHolderGone(marker, other) && readIfPresent(marker) === other) fs.rmSync(marker, { force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return;
  }
  try {
    if (readIfPresent(lock) === seen) fs.rmSync(lock, { force: true });
  } finally {
    if (readIfPresent(marker) === mine) fs.rmSync(marker, { force: true });
  }
}

/** Runs `fn` holding the session's hold lock; one whose hook process died is replaced. */
async function withHeldLock(dir, fn) {
  const lock = path.join(dir, HELD_LOCK_FILE);
  const own = processStart(process.pid);
  const text = JSON.stringify({ pid: process.pid, start: typeof own === 'string' && own !== 'unknown' ? own : null, nonce: crypto.randomUUID() });
  for (const deadline = Date.now() + HELD_LOCK_WAIT_MS; ; await sleepMs(20)) {
    try {
      fs.writeFileSync(lock, text, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const seen = fs.readFileSync(lock, 'utf8');
      if (lockHolderGone(lock, seen)) takeOverLock(dir, lock, seen, text);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (Date.now() > deadline) throw new Error('the report number holds are locked by another release');
  }
  try {
    return fn();
  } finally {
    // Only this hook's own lock: a live holder's lock is never replaced, so it is still this one.
    if (readIfPresent(lock) === text) fs.rmSync(lock, { force: true });
  }
}

/**
 * reserve-report-num.mjs --release deletes the sentinels it names whoever reserved them, so a session releases only
 * the reservations it holds: the one the app reserved for it, and the ones its own reservations printed, each while
 * its sentinel is still that reservation's (a number released, collected and reserved again is someone else's). A
 * number let go is no longer held.
 */
async function releaseReason(command, policy, sessionDir, toolUseId) {
  const tokens = tokenize(command);
  if (!tokens || tokens[0] !== 'node' || tokens[1] !== 'reserve-report-num.mjs' || tokens[2] !== '--release') return null;
  const m = (tokens[3] ?? '').match(RELEASE_ARG);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > RELEASE_MAX) return null;
  const nums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const file = path.join(sessionDir, HELD_REPORT_NUMS_FILE);
  const tag = typeof toolUseId === 'string' && TOOL_USE_ID.test(toolUseId) ? `@${toolUseId}` : '';
  const dataRoot = policy.dataRoot || policy.codeRoot;
  const holds = (held, n) => {
    if (!held.has(n)) return false;
    // A sentinel gone holds nothing to release: the app dropped it, or another evaluation may reserve it next.
    return sentinelIdentity(dataRoot, n) === held.get(n);
  };
  let unheld;
  for (const deadline = Date.now() + HELD_WAIT_MS; ; await sleepMs(100)) {
    unheld = await withHeldLock(sessionDir, () => {
      const held = heldReportNums(file);
      const missing = nums.filter((n) => !holds(held, n));
      if (missing.length === 0) fs.appendFileSync(file, nums.map((n) => `\n-${n}${tag};`).join(''));
      return missing;
    });
    if (unheld.length === 0) return null;
    if (Date.now() > deadline) break;
  }
  // Named, so a range a failed release left partly deleted can be retried with the numbers still held.
  const named = unheld.map((n) => String(n).padStart(3, '0')).join(', ');
  return `Bash: a session releases only the report numbers it holds (the one reserved for it, or one its own reserve-report-num.mjs run printed); every other sentinel is another evaluation's reservation (not held: ${named})`;
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const policyFile = process.env.CC_POLICY_FILE;
  if (!policyFile) deny('guard hook: CC_POLICY_FILE is not set');
  const expected = process.env.CC_POLICY_SHA256;
  if (!expected) deny('guard hook: CC_POLICY_SHA256 is not set, so the session policy cannot be verified');
  const bytes = fs.readFileSync(policyFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) deny('guard hook: the session policy file changed after the turn started; every tool call is refused');
  const policy = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(policy.readDeny)) deny('guard hook: the session policy predates read confinement; every tool call is refused');
  const sessionDir = process.env.CC_SESSION_DIR || policy.sessionDir;
  // Snapshots are per turn (CC_TURN_DIR) so a turn can be reverted on its own; files.ndjson stays per session.
  const snapDir = process.env.CC_TURN_DIR || sessionDir;
  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const event = payload.hook_event_name;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;

  if (event === 'PostToolUse') {
    if (WRITE_TOOLS.has(tool)) {
      const target = input.file_path ?? input.notebook_path;
      const found = typeof target === 'string' ? locate(policy, target) : null;
      // The bytes this write left, hashed now: a revert later refuses to overwrite anything that differs.
      const sha256 = found && fs.existsSync(found.abs) ? crypto.createHash('sha256').update(fs.readFileSync(found.abs)).digest('hex') : null;
      if (found) {
        const log = path.join(sessionDir, 'files.ndjson');
        // A hook killed mid-append leaves a line with no newline; this record must not join it, or it is lost to a line
        // a turn offset (a raw line count) already gave the turn before.
        const lead = endsTorn(log) ? '\n' : '';
        fs.appendFileSync(log, `${lead}${JSON.stringify({ path: found.rel, abs: found.abs, root: found.root, tool, sha256, ts: new Date().toISOString() })}\n`);
      }
    }
    process.exit(0);
  }

  if (WRITE_TOOLS.has(tool)) {
    const { reason, found } = writeTarget(policy, tool, input.file_path ?? input.notebook_path);
    if (reason) deny(reason);
    snapshot(snapDir, found.abs);
    process.exit(0);
  }

  if (tool === 'Read') {
    const reason = checkRead(policy, input, cwd);
    if (reason) deny(reason);
    process.exit(0);
  }

  if (tool === 'Glob' || tool === 'Grep') {
    const reason = checkSearch(policy, tool, input, cwd);
    if (reason) deny(reason);
    if (tool === 'Grep') {
      const updatedInput = narrowGrepInput(input, policy.readDeny);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
    }
    process.exit(0);
  }

  if (tool === 'WebFetch') {
    const reason = await checkFetchUrl(String(input.url ?? ''));
    if (reason) deny(reason);
    process.exit(0);
  }

  if (tool === 'Agent' || tool === 'Task') {
    if (policy.allowsAgent !== true) deny(`${tool}: subagents are not granted to this session`);
    process.exit(0);
  }

  if (tool === 'PowerShell') deny('PowerShell is never granted to sessions');

  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    const reason = checkBash(command, policy, cwd) ?? (await releaseReason(command, policy, sessionDir, payload.tool_use_id));
    if (reason) deny(reason);
    // URLs a script reads from a list file it was given get the same checks as its URL arguments.
    const listed = [];
    for (const { file, format } of urlListFilesIn(command)) {
      const got = readUrlList(policy, file, cwd, format);
      if (got.reason) deny(got.reason);
      listed.push(...got.urls);
    }
    // checkBash already refused local schemes and literal private hosts in arguments; names are resolved here, all at once under one budget.
    const why = await checkFetchUrls([...httpUrlsIn(command), ...listed], undefined, { label: 'Bash' });
    if (why) deny(why);
    process.exit(0);
  }

  if (tool.startsWith(PLAYWRIGHT_TOOL_PREFIX)) {
    const reason = await checkPlaywright(policy, tool, input, cwd);
    if (reason) deny(reason);
    process.exit(0);
  }
  process.exit(0);
}

main().catch((err) => deny(`guard hook failed: ${err && err.message}`));
