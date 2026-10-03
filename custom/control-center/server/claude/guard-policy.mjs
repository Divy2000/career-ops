// Pure path and command policy shared by the guard hook (guard-hook.mjs) and
// the change-set reverts (supervisor/recovery.ts). Plain .mjs with no side
// effects on import, so the hook entry itself can run unconditionally.
import fs from 'node:fs';
import path from 'node:path';

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

// ---- Bash ----
//
// The command string is refused outright when it contains anything a POSIX
// shell or zsh would treat specially (operators, expansions, globs, escapes,
// control characters, line breaks), even inside quotes. What is left can only
// be words, spaces and quotes, so the shell's word splitting equals tokenize()
// below and the first word is the program that runs. Each allowed prefix from
// the policy then has an exact grammar for the remaining arguments.

const FORBIDDEN_CHARS = /[;&|<>()$`\\*?[\]{}!#^]/;

/** C0 controls (line breaks and tabs included), DEL, NEL and the Unicode line and paragraph separators. */
function hasControlChar(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}
// Tilde expansion happens at the start of a word and after = or :; HEAD~1 is fine.
const TILDE_EXPANSION = /(^|[^A-Za-z0-9_])~/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// Flags that name a file to write. Only writer scripts that declare one may use it.
const OUTPUT_FLAG = /^(--out|--output|--outdir|--output-dir|--dest|--root|--dir|--vcf|--batch|--save|--write-to)(=|$)|^-o/;

/**
 * Scripts that write to a path their caller names. The first positional is the
 * input (anywhere inside the roots); every later positional and every value of
 * an `outFlags` flag is an output and must be inside the write scope, whether
 * or not it looks like a path (`LICENSE`, `cv`). `inputFlags` values are read
 * anywhere inside the roots, `valueFlags` values are plain values; any other
 * flag is taken to have no separate value.
 */
const WRITER_SCRIPTS = {
  'generate-pdf.mjs': { outFlags: [], denyFlags: ['--batch'] },
  'generate-cover-letter.mjs': { outFlags: ['--out'], inputFlags: ['--payload'], valueFlags: ['--format', '--report'] },
  'build-cv-latex.mjs': {},
  'generate-latex.mjs': {},
  'build-cv-html.mjs': {},
  'patch-latex-content.mjs': {},
  'extract-latex-content.mjs': { outFlags: ['--out'] },
  'application-artifacts.mjs': { outFlags: ['--root'], valueFlags: ['--report', '--company', '--role', '--version'] },
  'contacts.mjs': { outFlags: ['--vcf'] },
  'discover-new-companies.mjs': { outFlags: ['--out'], valueFlags: ['--since', '--min-rows', '--limit'] },
  'hired-share.mjs': { outFlags: ['--root'], valueFlags: ['--report', '--anonymity', '--story', '--weeks', '--feature', '--mark'] },
  'weekly-digest.mjs': { outFlags: ['--dir'], valueFlags: ['--from', '--to'] },
};

const GIT_FLAGS = {
  status: { exact: ['-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2', '--long', '-v', '--verbose', '-u', '-uno', '-unormal', '-uall', '--untracked-files', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '--ignored', '--show-stash', '--ahead-behind', '--no-ahead-behind', '--no-renames', '-z'], patterns: [] },
  diff: {
    exact: ['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '--cached', '--staged', '-p', '-u', '--patch', '--no-patch', '-w', '--ignore-all-space', '-b', '--ignore-space-change', '--ignore-blank-lines', '--word-diff', '--minimal', '--patience', '--histogram', '-M', '--find-renames', '-R', '--check', '--no-color', '--color=never', '--no-ext-diff', '--no-textconv', '--raw', '-z'],
    patterns: [/^--stat=\d+(,\d+){0,2}$/, /^-U\d+$/, /^--unified=\d+$/, /^--diff-filter=[ACDMRTUXBacdmrtuxb]+$/, /^--word-diff=(plain|porcelain|none)$/],
  },
  log: {
    exact: ['--oneline', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '-p', '--patch', '--graph', '--decorate', '--no-decorate', '--reverse', '--first-parent', '--follow', '--abbrev-commit', '--no-merges', '--merges', '--no-color', '--color=never', '--all', '-n', '-z'],
    patterns: [/^-n\d+$/, /^-\d+$/, /^--max-count=\d+$/, /^--skip=\d+$/, /^--(since|until|after|before|author|grep|format|pretty|date)=.+$/, /^-U\d+$/],
  },
};
const GIT_REV = /^[A-Za-z0-9_][A-Za-z0-9_./~-]*$/;

/** Words, quotes and single spaces only (checked before); null when a quote is unbalanced. */
export function tokenize(command) {
  const tokens = [];
  let cur = null;
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur = cur ?? '';
    } else if (ch === ' ') {
      if (cur !== null) tokens.push(cur);
      cur = null;
    } else cur = (cur ?? '') + ch;
  }
  if (quote) return null;
  if (cur !== null) tokens.push(cur);
  return tokens;
}

function isPathLike(v) {
  if (!v || URL_RE.test(v)) return false;
  return v.includes('/') || v.startsWith('.') || /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(v);
}

function isInsideDir(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Canonical absolute path of an argument, resolved against the session cwd (the code root). */
function argPath(policy, value) {
  return resolveReal(path.resolve(policy.codeRoot, value));
}

/** The value a flag token carries inline (--file=x) or null. */
function inlineValue(token) {
  const i = token.indexOf('=');
  return token.startsWith('-') && i !== -1 ? token.slice(i + 1) : null;
}

function readable(policy, value, label) {
  const found = locate(policy, value);
  if (!found) return `${label}: ${value} is outside the repo and data roots`;
  if (matches(found.rel, policy.deny)) return `${label}: ${found.rel} is protected and may not be passed to a command`;
  return null;
}

function writable(policy, value, label) {
  const found = locate(policy, value);
  if (!found) return `${label}: ${value} is outside the repo and data roots`;
  if (matches(found.rel, policy.deny)) return `${label}: ${found.rel} is protected and may not be passed to a command`;
  if (!matches(found.rel, policy.allow)) return `${label}: ${found.rel} is outside the write scope (${policy.allow.join(', ') || 'none'})`;
  return null;
}

function checkExact(args, label) {
  return args.length === 0 ? null : `${label} takes no extra arguments`;
}

function checkVitest(policy, args, label) {
  const testsDir = argPath(policy, 'custom/control-center/tests');
  for (const a of args) {
    if (a.startsWith('-')) return `${label}: vitest flags are not allowed (${a})`;
    if (a.includes('/') || a.startsWith('.')) {
      if (!isInsideDir(testsDir, argPath(policy, a))) return `${label}: ${a} is not inside custom/control-center/tests`;
    } else if (!/^[A-Za-z0-9_.-]+$/.test(a)) return `${label}: ${a} is not a test name filter`;
  }
  return null;
}

function checkGit(policy, sub, args, label) {
  const spec = GIT_FLAGS[sub];
  if (!spec) return `${label}: git ${sub} is not allowed`;
  let pathsOnly = false;
  for (const a of args) {
    if (!pathsOnly && a === '--') {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && a.startsWith('-')) {
      if (/^--output/.test(a) || /^-o/.test(a)) return `${label}: git output files (${a}) are not allowed`;
      if (a === '--no-index') return `${label}: git --no-index is not allowed`;
      if (!spec.exact.includes(a) && !spec.patterns.some((re) => re.test(a))) return `${label}: git ${sub} ${a} is not an allowed read-only flag`;
      continue;
    }
    if (pathsOnly || a.includes('/') || a.includes('..') || !GIT_REV.test(a)) {
      if (!isInsideDir(fs.realpathSync.native(policy.codeRoot), argPath(policy, a))) return `${label}: ${a} is outside the repo`;
    }
  }
  return null;
}

function checkWriterScript(policy, script, writer, args, label) {
  const outFlags = writer.outFlags ?? [];
  const inputFlags = writer.inputFlags ?? [];
  const valueFlags = writer.valueFlags ?? [];
  const role = (flag) => (outFlags.includes(flag) ? 'output' : inputFlags.includes(flag) ? 'input' : valueFlags.includes(flag) ? 'value' : null);
  const check = (kind, value) => (kind === 'output' ? writable(policy, value, label) : kind === 'input' ? readable(policy, value, label) : null);
  let pending = null; // a declared value flag whose separate value token comes next
  let positionals = 0;
  for (const a of args) {
    if (a.startsWith('-')) {
      const flag = a.split('=')[0];
      if (writer.denyFlags?.includes(flag)) return `${label}: ${script} ${flag} is not allowed in sessions`;
      if (OUTPUT_FLAG.test(a) && !outFlags.includes(flag)) return `${label}: ${script} does not write to a caller-chosen file (${a})`;
      const value = inlineValue(a);
      const kind = role(flag);
      pending = value === null && kind ? kind : null;
      if (value !== null) {
        const why = kind ? check(kind, value) : isPathLike(value) ? writable(policy, value, label) : null;
        if (why) return why;
      }
      continue;
    }
    if (pending) {
      const why = check(pending, a);
      pending = null;
      if (why) return why;
      continue;
    }
    positionals += 1;
    const why = positionals === 1 ? readable(policy, a, label) : writable(policy, a, label);
    if (why) return why;
  }
  return null;
}

function checkScript(policy, script, args, label) {
  const writer = WRITER_SCRIPTS[script];
  if (writer) return checkWriterScript(policy, script, writer, args, label);
  // Scripts that write only to their own fixed files: path arguments are read inside the roots and never protected.
  for (const a of args) {
    if (a.startsWith('-')) {
      if (OUTPUT_FLAG.test(a)) return `${label}: ${script} does not write to a caller-chosen file (${a})`;
      const value = inlineValue(a);
      const why = value !== null && isPathLike(value) ? readable(policy, value, label) : null;
      if (why) return why;
      continue;
    }
    const why = isPathLike(a) ? readable(policy, a, label) : null;
    if (why) return why;
  }
  return null;
}

/** Exact grammar for the arguments after an allowed prefix, chosen by the prefix's shape; unknown shapes never match. */
function checkArgs(policy, prefix, args, label) {
  const [bin, second] = prefix;
  if (bin === 'npm' && prefix.length === 5 && prefix[1] === '--prefix' && prefix[3] === 'run') return checkExact(args, label);
  if (bin === 'npx' && prefix.length === 5 && prefix[1] === '--prefix' && prefix[3] === 'vitest' && prefix[4] === 'run') return checkVitest(policy, args, label);
  if (bin === 'git' && prefix.length === 2) return checkGit(policy, second, args, label);
  if ((bin === 'node' || bin === 'bash') && prefix.length === 2 && !second.startsWith('-')) return checkScript(policy, second, args, label);
  return `${label}: unsupported command shape`;
}

/**
 * Null when the command is allowed, else the reason. `policy` carries the roots,
 * the write scope (allow minus deny) and the allowed prefixes; `cwd` is the
 * session's working directory from the hook payload.
 */
export function checkBash(command, policy, cwd) {
  const allowed = policy.bash ?? [];
  if (hasControlChar(command) || FORBIDDEN_CHARS.test(command)) return 'Bash: line breaks, control characters, shell operators, expansions, globs and escapes are not allowed (; & | < > ( ) $ ` \\ * ? [ ] { } ! # ^)';
  if (TILDE_EXPANSION.test(command)) return 'Bash: ~ expansion is not allowed';
  const tokens = tokenize(command);
  if (tokens === null) return 'Bash: unbalanced quotes';
  if (tokens.some((t) => t.startsWith('='))) return 'Bash: words starting with = are not allowed (zsh expands them)';
  const first = tokens[0];
  if (!first) return 'Bash: empty command';
  if (NETWORK_BINS.has(first)) return `Bash: ${first} is not allowed (network tools are denied)`;
  if (cwd !== undefined && cwd !== null && resolveReal(path.resolve(String(cwd))) !== fs.realpathSync.native(policy.codeRoot)) return 'Bash: the session must run from the repo root';
  const candidates = allowed.filter((prefix) => prefix.every((p, i) => tokens[i] === p));
  if (candidates.length === 0) {
    if (first === 'git') return 'Bash: git is not allowed in sessions (Dev Chat may run git status, diff and log)';
    return `Bash: only these commands are allowed: ${allowed.map((p) => p.join(' ')).join(', ')}`;
  }
  let reason = null;
  for (const prefix of candidates) {
    const why = checkArgs(policy, prefix, tokens.slice(prefix.length), `Bash: ${prefix.join(' ')}`);
    if (!why) return null;
    reason ??= why;
  }
  return reason;
}

/** First-touch snapshot keyed by the absolute path, so code-root and data-root files never collide. */
export function snapshotKey(sessionDir, abs) {
  return path.join(sessionDir, 'before', encodeURIComponent(abs));
}
