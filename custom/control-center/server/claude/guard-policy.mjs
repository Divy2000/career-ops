// Pure path and command policy shared by the guard hook (guard-hook.mjs) and
// the change-set reverts (supervisor/recovery.ts). Plain .mjs with no side
// effects on import, so the hook entry itself can run unconditionally.
import fs from 'node:fs';
import path from 'node:path';
import { parse as shellParse } from 'shell-quote';

const NETWORK_BINS = new Set(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'rsync']);

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
  // macOS volumes are case-insensitive by default: data/Blacklist.md is data/blacklist.md.
  return new RegExp(`^${re}$`, 'i');
}

export function matches(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

/**
 * Realpath with a possibly missing tail: resolve the deepest existing ancestor
 * with realpathSync.native (it returns the on-disk case), then re-append.
 */
export function resolveReal(p) {
  let dir = p;
  const tail = [];
  while (!fs.existsSync(dir)) {
    tail.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(fs.realpathSync.native(dir), ...tail);
}

export function relativeToRoot(codeRoot, target) {
  const root = fs.realpathSync.native(codeRoot);
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
  // Glob tokens (node --test custom/immigration/*) are kept as their pattern; operators are rejected.
  const tokens = shellParse(command).map((t) => (t && typeof t === 'object' && t.op === 'glob' ? t.pattern : t));
  if (tokens.some((t) => typeof t !== 'string')) return 'Bash: operators (; && | > <) and comments are not allowed';
  const first = tokens[0];
  if (!first) return 'Bash: empty command';
  if (NETWORK_BINS.has(first)) return `Bash: ${first} is not allowed (network tools are denied)`;
  // A prefix ending in "/" matches the start of the next token (node --test custom/immigration/...).
  const ok = allowed.some((prefix) => prefix.every((p, i) => (p.endsWith('/') ? typeof tokens[i] === 'string' && tokens[i].startsWith(p) : tokens[i] === p)));
  if (first === 'git' && !ok) return 'Bash: git is not allowed in sessions (Dev Chat may run git status, diff and log)';
  return ok ? null : `Bash: only these commands are allowed: ${allowed.map((p) => p.join(' ')).join(', ')}`;
}

/** First-touch snapshot keyed by the absolute path, so code-root and data-root files never collide. */
export function snapshotKey(sessionDir, abs) {
  return path.join(sessionDir, 'before', encodeURIComponent(abs));
}
