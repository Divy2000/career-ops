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
import { checkBash, locate, matches, snapshotKey } from './guard-policy.mjs';

const SUBMIT_RE = /submit|send application|apply now|confirm and submit|finish application/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function snapshot(sessionDir, abs) {
  fs.mkdirSync(path.join(sessionDir, 'before'), { recursive: true });
  const key = snapshotKey(sessionDir, abs);
  if (fs.existsSync(key) || fs.existsSync(`${key}.absent`)) return;
  if (fs.existsSync(abs)) fs.copyFileSync(abs, key);
  else fs.writeFileSync(`${key}.absent`, '');
}

function main() {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const policyFile = process.env.CC_POLICY_FILE;
  if (!policyFile) deny('guard hook: CC_POLICY_FILE is not set');
  const expected = process.env.CC_POLICY_SHA256;
  if (!expected) deny('guard hook: CC_POLICY_SHA256 is not set, so the session policy cannot be verified');
  const bytes = fs.readFileSync(policyFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) deny('guard hook: the session policy file changed after the turn started; every tool call is refused');
  const policy = JSON.parse(bytes.toString('utf8'));
  const sessionDir = process.env.CC_SESSION_DIR || policy.sessionDir;
  // Snapshots are per turn (CC_TURN_DIR) so a turn can be reverted on its own; files.ndjson stays per session.
  const snapDir = process.env.CC_TURN_DIR || sessionDir;
  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const event = payload.hook_event_name;

  if (event === 'PostToolUse') {
    if (WRITE_TOOLS.has(tool)) {
      const target = input.file_path ?? input.notebook_path;
      const found = typeof target === 'string' ? locate(policy, target) : null;
      // The bytes this write left, hashed now: a revert later refuses to overwrite anything that differs.
      const sha256 = found && fs.existsSync(found.abs) ? crypto.createHash('sha256').update(fs.readFileSync(found.abs)).digest('hex') : null;
      if (found) fs.appendFileSync(path.join(sessionDir, 'files.ndjson'), JSON.stringify({ path: found.rel, abs: found.abs, root: found.root, tool, sha256, ts: new Date().toISOString() }) + '\n');
    }
    process.exit(0);
  }

  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== 'string' || !target) deny(`${tool}: no file path`);
    const found = locate(policy, target);
    if (!found) deny(`${tool}: ${target} is outside the repo and data roots; sessions may only write inside them`);
    const { rel, abs } = found;
    if (matches(rel, policy.deny)) deny(`${tool}: ${rel} is always protected (blacklist and tracker are edited only through the app or core CLIs)`);
    if (!matches(rel, policy.allow)) deny(`${tool}: ${rel} is not in the write scope (${policy.allow.join(', ') || 'none'})`);
    snapshot(snapDir, abs);
    process.exit(0);
  }

  if (tool === 'Bash') {
    const reason = checkBash(String(input.command ?? ''), policy, typeof payload.cwd === 'string' ? payload.cwd : undefined);
    if (reason) deny(reason);
    process.exit(0);
  }

  if (tool === 'mcp__playwright__browser_click' || tool === 'mcp__playwright__browser_press_key') {
    const text = [input.element, input.ref, input.text].filter((v) => typeof v === 'string').join(' ');
    if (SUBMIT_RE.test(text)) deny('Playwright: this looks like a submit control. The user presses Submit, never the session.');
    process.exit(0);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  deny(`guard hook failed: ${err && err.message}`);
}
