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

// The report numbers the turn holds, logged in its turn folder (manager.ts HELD_REPORT_NUMS_FILE): `+N;` from the app,
// `-N;` from here once a release lets one go, each on a line of its own. A record cut short (no `;`) holds nothing, and
// the next one starts its own line rather than joining it.
const HELD_REPORT_NUMS_FILE = 'held-report-nums.log';
const HELD_RECORD = /^([+-])(\d+);$/;
// The allocator's CLI reads --release <NNN>[-<MMM>] this way; an argument it would refuse is left to its usage error.
const RELEASE_ARG = /^(\d+)(?:-(\d+))?$/;
const RELEASE_MAX = 50;
// The app records a number the turn reserved once the run's result reaches it (it polls the output): a release right
// after the reservation waits for that record this long before it is refused.
const HELD_WAIT_MS = 3000;

function heldReportNums(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
  const held = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(HELD_RECORD);
    if (m?.[1] === '+') held.add(Number(m[2]));
    else if (m) held.delete(Number(m[2]));
  }
  return held;
}

/**
 * reserve-report-num.mjs --release deletes the sentinels it names whoever reserved them, so a turn releases only the
 * numbers it holds: the one the app reserved for the session, and the ones its own reservations printed. A number let
 * go is no longer held: another evaluation may reserve it next.
 */
async function releaseReason(command, turnDir) {
  const tokens = tokenize(command);
  if (!tokens || tokens[0] !== 'node' || tokens[1] !== 'reserve-report-num.mjs' || tokens[2] !== '--release') return null;
  const m = (tokens[3] ?? '').match(RELEASE_ARG);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > RELEASE_MAX) return null;
  const nums = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const file = path.join(turnDir, HELD_REPORT_NUMS_FILE);
  for (const deadline = Date.now() + HELD_WAIT_MS; ; await new Promise((r) => setTimeout(r, 100))) {
    const held = heldReportNums(file);
    if (nums.every((n) => held.has(n))) {
      fs.appendFileSync(file, nums.map((n) => `\n-${n};`).join(''));
      return null;
    }
    if (Date.now() > deadline) break;
  }
  return 'Bash: a session releases only the report numbers it holds (the one reserved for it, or one its own reserve-report-num.mjs run printed); every other sentinel is another evaluation\'s reservation';
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
    const reason = checkBash(command, policy, cwd) ?? (await releaseReason(command, snapDir));
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
