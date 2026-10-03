#!/usr/bin/env node
// PreToolUse / PostToolUse guard (spec 4.4). Plain .mjs: the Claude CLI runs it
// with the hook JSON on stdin; CC_POLICY_FILE points at the session policy.
// Exit 2 blocks the tool call and the stderr text becomes the reason.
import fs from 'node:fs';
import path from 'node:path';
import { parse as shellParse } from 'shell-quote';

const SUBMIT_RE = /submit|send application|apply now|confirm and submit|finish application/i;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NETWORK_BINS = new Set(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'rsync']);

function deny(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matches(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

/** Realpath with a possibly missing tail: resolve the deepest existing ancestor, then re-append. */
export function resolveReal(p) {
  let dir = p;
  const tail = [];
  while (!fs.existsSync(dir)) {
    tail.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...tail);
}

export function relativeToRoot(codeRoot, target) {
  const root = fs.realpathSync(codeRoot);
  const abs = resolveReal(path.resolve(codeRoot, target));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** The data root wins when it differs from the code root (relative paths resolve against the code root, the session cwd). */
export function locate(policy, target) {
  const roots = [...new Set([policy.dataRoot || policy.codeRoot, policy.codeRoot])];
  for (const root of roots) {
    const rel = relativeToRoot(root, path.isAbsolute(target) ? target : path.resolve(policy.codeRoot, target));
    if (rel) return { rel, abs: path.resolve(root, rel), root: root === policy.codeRoot ? 'code' : 'data' };
  }
  return null;
}

export function checkBash(command, allowed) {
  if (/[`]|\$\(/.test(command)) return 'Bash: command substitution is not allowed';
  const tokens = shellParse(command);
  if (tokens.some((t) => typeof t !== 'string')) return 'Bash: operators (; && | > <), globs and comments are not allowed';
  const first = tokens[0];
  if (!first) return 'Bash: empty command';
  if (first === 'git') return 'Bash: git is not allowed in sessions';
  if (NETWORK_BINS.has(first)) return `Bash: ${first} is not allowed (network tools are denied)`;
  const ok = allowed.some((prefix) => prefix.every((p, i) => tokens[i] === p));
  return ok ? null : `Bash: only these commands are allowed: ${allowed.map((p) => p.join(' ')).join(', ')}`;
}

/** First-touch snapshot keyed by the absolute path, so code-root and data-root files never collide. */
export function snapshotKey(sessionDir, abs) {
  return path.join(sessionDir, 'before', encodeURIComponent(abs));
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
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const sessionDir = process.env.CC_SESSION_DIR || policy.sessionDir;
  const tool = String(payload.tool_name ?? '');
  const input = payload.tool_input ?? {};
  const event = payload.hook_event_name;

  if (event === 'PostToolUse') {
    if (WRITE_TOOLS.has(tool)) {
      const target = input.file_path ?? input.notebook_path;
      const found = typeof target === 'string' ? locate(policy, target) : null;
      if (found) fs.appendFileSync(path.join(sessionDir, 'files.ndjson'), JSON.stringify({ path: found.rel, abs: found.abs, root: found.root, tool, ts: new Date().toISOString() }) + '\n');
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
    snapshot(sessionDir, abs);
    process.exit(0);
  }

  if (tool === 'Bash') {
    const reason = checkBash(String(input.command ?? ''), policy.bash ?? []);
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (err) {
    deny(`guard hook failed: ${err && err.message}`);
  }
}
