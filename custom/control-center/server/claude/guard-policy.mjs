// Pure path and command policy shared by the guard hook (guard-hook.mjs) and
// the change-set reverts (supervisor/recovery.ts). Plain .mjs with no side
// effects on import, so the hook entry itself can run unconditionally.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';

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

// ---- Reads: Read, Glob, Grep ----

function isWithin(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The session cwd is the code root, compared by real path (the same rule Bash uses). */
function isCodeRoot(policy, cwd) {
  return resolveReal(path.resolve(String(cwd))) === fs.realpathSync.native(policy.codeRoot);
}

/**
 * Where a read lands, by its real path: inside the data root, the code root or a read-only root (the
 * session's own oversized tool results), the root itself included. Relative paths resolve against the
 * code root (the session cwd). A symlink that leads outside every root is null.
 */
export function locateRead(policy, target) {
  const abs = resolveReal(path.isAbsolute(target) ? target : path.resolve(policy.codeRoot, target));
  const roots = [...new Set([policy.dataRoot || policy.codeRoot, policy.codeRoot])].map((r) => ({ real: fs.realpathSync.native(r), kind: r === policy.codeRoot ? 'code' : 'data' }));
  for (const r of policy.readOnlyRoots ?? []) roots.push({ real: resolveReal(r), kind: 'readonly' });
  for (const { real, kind } of roots) if (isWithin(real, abs)) return { rel: path.relative(real, abs).split(path.sep).join('/'), abs, root: kind };
  return null;
}

/** Null when a read of `input.file_path` is allowed, else the reason. */
export function checkRead(policy, input, cwd, label = 'Read') {
  if (!Array.isArray(policy.readDeny)) return `${label}: the session policy predates read confinement, so every read is refused`;
  const target = input?.file_path;
  if (typeof target !== 'string' || !target) return `${label}: no file path`;
  if (target.startsWith('~')) return `${label}: ${target} starts with ~; use the absolute path`;
  // After a symlink, .. resolves differently on disk than on paper: refuse it rather than guess which the tool opens.
  if (target.split(/[\\/]/).includes('..')) return `${label}: ${target} has a .. segment; use the absolute path`;
  if (!path.isAbsolute(target) && cwd !== undefined && cwd !== null && !isCodeRoot(policy, cwd)) return `${label}: ${target} is a relative path, it resolves against the repo root and the session is not running from it; use the absolute path`;
  const found = locateRead(policy, target);
  if (!found) return `${label}: ${target} is outside the repo and data roots; sessions read only inside them`;
  if (matches(found.rel, policy.readDeny)) return `${label}: ${found.rel} is a protected secret file (.env, keys, credentials) and sessions never read it`;
  return null;
}

const SEARCH_ESCAPES = ['{/', ',/', '{~', ',~'];

/** A Glob pattern or Grep glob: no climbing out, no home, no brace alternative that starts an absolute or home path. */
function checkSearchPattern(policy, value, label) {
  const p = value.replace(/\\/g, '/');
  if (p.includes('..')) return `${label}: ${value} contains ..; search inside the repo and data roots`;
  if (p.startsWith('~')) return `${label}: ${value} starts with ~; search inside the repo and data roots`;
  const escape = SEARCH_ESCAPES.find((e) => p.includes(e));
  if (escape) return `${label}: ${value} contains ${escape}; brace alternatives may not start a new path`;
  if (p.startsWith('/')) {
    const meta = p.search(/[*?[\]{}]/);
    const head = meta === -1 ? p : p.slice(0, meta);
    const prefix = head.slice(0, head.lastIndexOf('/')) || '/';
    if (!locateRead(policy, prefix)) return `${label}: ${value} searches ${prefix}, outside the repo and data roots`;
  }
  return null;
}

/** Glob and Grep (granted to every class): the search path passes the read checks, the patterns stay inside it. */
export function checkSearch(policy, tool, input, cwd) {
  if (policy.search !== true) return `${tool}: not granted to sessions`;
  const dir = input?.path;
  if (dir !== undefined && dir !== null && dir !== '') {
    if (typeof dir !== 'string') return `${tool}: path must be a string`;
    const why = checkRead(policy, { file_path: dir }, cwd, tool);
    if (why) return why;
  } else {
    if (!Array.isArray(policy.readDeny)) return `${tool}: the session policy predates read confinement, so every search is refused`;
    if (cwd !== undefined && cwd !== null && !isCodeRoot(policy, cwd)) return `${tool}: the session must run from the repo root`;
  }
  const key = tool === 'Glob' ? 'pattern' : 'glob';
  const value = input?.[key];
  if (value === undefined || value === null || value === '') return tool === 'Glob' ? `${tool}: no pattern` : null;
  if (typeof value !== 'string') return `${tool}: ${key} must be a string`;
  return checkSearchPattern(policy, value, `${tool} ${key}`);
}

// ---- URLs: WebFetch, and URL arguments of scripts ----

const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([a, bits]) => [v4ToInt(a), bits]);

function v4ToInt(s) {
  return s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

function publicV4(n) {
  return !V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** Eight 16-bit groups of an address net.isIP already accepted as IPv6 (a trailing dotted IPv4 included). */
function v6Groups(s) {
  let str = s.toLowerCase();
  const dotted = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    str = `${str.slice(0, -dotted[1].length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [l, r] = str.split('::');
  const left = l ? l.split(':') : [];
  const right = r === undefined ? null : r ? r.split(':') : [];
  const groups = right === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((g) => parseInt(g, 16));
}

function publicV6(s) {
  const g = v6Groups(s);
  const embedded = (hi, lo) => g[hi] * 65536 + g[lo];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(embedded(6, 7)); // ::ffff:0:0/96, IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return false; // ::/96: unspecified, loopback, IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicV4(embedded(6, 7)); // NAT64
  if (g[0] === 0x2002) return publicV4(embedded(1, 2)); // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return false; // outside global unicast: ULA, link-local, site-local, multicast, discard
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 protocol assignments (Teredo, ORCHID, benchmarking)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/** A globally routable unicast address; loopback, private, CGNAT, link-local (metadata), multicast and reserved are not. */
export function isPublicAddress(ip) {
  const s = String(ip).replace(/%.*$/, '');
  const v = net.isIP(s);
  if (v === 4) return publicV4(v4ToInt(s));
  if (v === 6) return publicV6(s);
  return false;
}

function hostOf(u) {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * What the URL alone shows: http or https only, and no local host name or non-public literal address. The
 * WHATWG parser already turns forms such as 2130706433 and 0x7f.1 into dotted IPv4.
 */
export function checkUrlLiteral(raw, label = 'WebFetch') {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return `${label}: ${raw} is not a valid URL`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${label}: only http and https URLs may be fetched (${u.protocol})`;
  const host = hostOf(u);
  if (!host) return `${label}: ${raw} has no host`;
  if (net.isIP(host)) return isPublicAddress(host) ? null : `${label}: ${host} is a private, loopback or link-local address`;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) return `${label}: ${host} is a local host name`;
  return null;
}

const lookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * One deadline for every lookup a single tool call needs. A hook still running at its own timeout (30 s) does
 * not block, so the DNS check must always answer, and refuse, well before that.
 */
export const DNS_BUDGET_MS = 20_000;
/** Distinct names one call may need resolved: each lookup takes a getaddrinfo thread, and libuv's pool has four. */
export const MAX_URL_HOSTS = 4;
/** Distinct destinations (names and literal addresses) one call may name; literal addresses need no lookup. */
export const MAX_URL_DESTINATIONS = 16;

/**
 * Null when every URL may be fetched: each passes checkUrlLiteral, the call names at most MAX_URL_DESTINATIONS
 * distinct hosts of which at most MAX_URL_HOSTS need a lookup, and every address each name resolves to is public. All names are resolved in parallel under
 * one shared budget; a lookup that fails, answers nothing or is still pending when the budget ends is refused.
 */
export async function checkFetchUrls(urls, lookup = lookupAll, opts = {}) {
  const label = opts.label ?? 'WebFetch';
  const hosts = new Set();
  for (const raw of urls) {
    const literal = checkUrlLiteral(raw, label);
    if (literal) return literal;
    hosts.add(hostOf(new URL(String(raw))));
  }
  if (hosts.size > MAX_URL_DESTINATIONS) return `${label}: ${hosts.size} different destinations in one call; at most ${MAX_URL_DESTINATIONS} are checked, so the call is refused`;
  const names = [...hosts].filter((h) => !net.isIP(h));
  const maxHosts = opts.maxHosts ?? MAX_URL_HOSTS;
  if (names.length > maxHosts) return `${label}: ${names.length} different hosts to resolve in one call; at most ${maxHosts} are resolved, so the call is refused`;
  if (names.length === 0) return null;
  const budget = opts.budgetMs ?? opts.timeoutMs ?? DNS_BUDGET_MS;
  const verdict = (host) =>
    Promise.resolve()
      .then(() => lookup(host))
      .then(
        (addrs) => {
          if (!Array.isArray(addrs) || addrs.length === 0) return `could not resolve ${host} (no addresses)`;
          const bad = addrs.map((a) => a && a.address).find((a) => typeof a !== 'string' || !isPublicAddress(a));
          return bad === undefined ? null : `${host} resolves to ${bad}, a private, loopback or link-local address`;
        },
        (err) => `could not resolve ${host} (${err && err.message})`,
      );
  let reasons;
  try {
    reasons = await withTimeout(Promise.all(names.map(verdict)), budget);
  } catch (err) {
    return `${label}: could not resolve ${names.join(', ')} (${err && err.message}); refused`;
  }
  const reason = reasons.find((r) => r !== null);
  if (!reason) return null;
  return `${label}: ${reason}${reason.startsWith('could not resolve') ? '; refused' : ''}`;
}

/** checkFetchUrls for one URL (WebFetch). */
export function checkFetchUrl(raw, lookup = lookupAll, opts = {}) {
  return checkFetchUrls([raw], lookup, opts);
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
 * Scripts that write to a path their caller names, modelled on their own
 * argument parsers so the guard reads every token the way the script will:
 * - switches: exact flag tokens with no value;
 * - next: flags whose value is the next token (taken even when it starts with a
 *   single dash, as the scripts do) and its role;
 * - eq: flags accepted as --flag=value and the value's role;
 * - positionals: the role of each positional, in order (no more are accepted);
 *   rest: the role of every positional after those (a name in several words);
 * - indexed: the script reads positionals by raw argv index, so no flag may sit
 *   in any of those slots (with fewer paths given, a trailing flag would be read
 *   as the missing path); modes: a first token that switches to other roles;
 * - readOnlyWith: switches that make the script write nothing (its read modes),
 *   so with any of them present its outputs are only read;
 * - outputSuffixes: each output is also written with these suffixes appended.
 * Roles: 'input' (read inside the roots), 'output' (inside the write scope),
 * 'value' (plain). Any other dash token is refused: these parsers would treat it
 * as a path (path.resolve turns -x/../cv.md into cv.md).
 */
const COVER_FLAGS = { '--payload': 'input', '--out': 'output', '--format': 'value', '--report': 'value' };
const ARTIFACT_FLAGS = { '--report': 'value', '--company': 'value', '--role': 'value', '--version': 'value', '--root': 'output' };
const HIRED_FLAGS = { '--report': 'value', '--anonymity': 'value', '--story': 'value', '--weeks': 'value', '--feature': 'value', '--mark': 'value', '--root': 'output' };
const RENDER_VALUES = { '--format': 'value', '--report': 'value', '--kind': 'value', '--max-pages': 'value' };
const DIGEST_FLAGS = { '--from': 'value', '--to': 'value', '--dir': 'input' };
// Every other --flag takes the next token as its value; there is no --flag=value form.
const ANSWERS_FLAGS = { '--report': 'output', '--input': 'input', '--state': 'value', '--date': 'value' };
const RECONCILE_FLAGS = { '--pipeline': 'output', '--state': 'input' };
const WRITER_SCRIPTS = {
  // Its --cache-dir makes that directory and writes cache files into it; sessions use the default cache.
  'plugins/h1b-sponsor/check.mjs': { switches: ['--json', '--summary', '--refresh', '--search'], positionals: [], rest: 'value' },
  // Upserts the answers it is given into --report; --read and --read-draft only print a section of it.
  'application-answers.mjs': { switches: ['--read', '--read-draft', '--strict', '--help', '-h'], next: ANSWERS_FLAGS, positionals: [], readOnlyWith: ['--read', '--read-draft'] },
  'generate-pdf.mjs': {
    switches: ['--report', '--kind', '--allow-reorder', '--allow-nonchronological', '--strict-pages', '--skip-fact-check'],
    eq: { '--format': 'value', '--report': 'value', '--kind': 'value', '--max-pages': 'value' },
    positionals: ['input', 'output'],
  },
  'generate-cover-letter.mjs': { switches: ['--help', '-h'], next: COVER_FLAGS, eq: COVER_FLAGS, positionals: [] },
  'build-cv-latex.mjs': { switches: ['--help', '--test'], eq: { '--template': 'value' }, positionals: ['input', 'output'], indexed: true },
  // Compiles in the input's directory: see latexCompileSiblings.
  'generate-latex.mjs': { switches: ['--compile-only', '--help', '-h'], positionals: ['input', 'output'], compilesNextToInput: true },
  'build-cv-html.mjs': { switches: ['--help', '--test'], positionals: ['input', 'output', 'input'], indexed: true, modes: { '--preview': ['input', 'input'] } },
  'patch-latex-content.mjs': { switches: ['--help'], positionals: ['input', 'input', 'output'] },
  'extract-latex-content.mjs': { switches: ['--help'], next: { '--out': 'output' }, positionals: ['input'] },
  // Rewrites --pipeline (by default data/pipeline.md, its own file) after copying it to <file>.pre-reconcile.bak.
  'reconcile-pipeline.mjs': { switches: ['--dry-run', '--help', '-h'], next: RECONCILE_FLAGS, eq: RECONCILE_FLAGS, positionals: [], readOnlyWith: ['--dry-run'], outputSuffixes: ['.pre-reconcile.bak'] },
  'application-artifacts.mjs': { switches: ['--init', '--help', '-h'], next: ARTIFACT_FLAGS, eq: ARTIFACT_FLAGS, positionals: [] },
  'contacts.mjs': { switches: ['--summary', '--self-test', '--caller-id', '--vcf', '--help', '-h'], optionalNext: { '--vcf': 'output' }, eq: { '--vcf': 'output' }, positionals: [] },
  'discover-new-companies.mjs': { switches: ['--added-only', '--summary', '--json', '--help', '-h'], next: { '--since': 'value', '--min-rows': 'value', '--limit': 'value', '--out': 'output' }, positionals: [] },
  'hired-share.mjs': { switches: ['--open', '--dry-run', '--status', '--help', '-h'], next: HIRED_FLAGS, eq: HIRED_FLAGS, positionals: [] },
  'weekly-digest.mjs': { switches: ['--summary', '--self-test', '--help', '-h'], next: DIGEST_FLAGS, eq: DIGEST_FLAGS, positionals: [] },
  'custom/cv/build-html.mjs': { switches: ['--help', '-h'], positionals: ['input', 'output'] },
  // Rewrites its input HTML with the fitted density, so both paths are outputs.
  'custom/cv/render-pdf.mjs': {
    switches: ['--strict-pages', '--allow-reorder', '--allow-nonchronological', '--skip-fact-check', '--help', '-h'],
    next: RENDER_VALUES,
    eq: RENDER_VALUES,
    positionals: ['output', 'output'],
  },
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
  if (matches(found.rel, policy.readDeny ?? [])) return `${label}: ${found.rel} is a protected secret file and may not be passed to a command`;
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

/**
 * generate-latex.mjs compiles in the input's directory whether or not an output
 * path is given: <base>.pdf (the default output, and pdflatex's intermediate),
 * the aux and log files, and tectonic's <base>._tectonic.* copies are written
 * there and then deleted. All of them must be inside the write scope.
 */
function latexCompileSiblings(input) {
  const dir = path.dirname(input);
  const base = path.basename(input, '.tex');
  const exts = ['.pdf', '.aux', '.log', '.out', '.fls', '.fdb_latexmk', '.synctex.gz'];
  return [...exts.map((e) => `${base}${e}`), `${base}._tectonic.tex`, ...exts.map((e) => `${base}._tectonic${e}`)].map((name) => path.join(dir, name));
}

function checkWriterScript(policy, script, spec, args, label) {
  // A read-mode switch is never consumed as a value: like the scripts, the walk below refuses a value that starts with --.
  const readOnly = (spec.readOnlyWith ?? []).some((s) => args.includes(s));
  const check = (role, value) => {
    if (role === 'output' && !readOnly) {
      for (const target of [value, ...(spec.outputSuffixes ?? []).map((suffix) => `${value}${suffix}`)]) {
        const why = writable(policy, target, label);
        if (why) return why;
      }
      return null;
    }
    return role === 'input' || role === 'output' ? readable(policy, value, label) : null;
  };
  let roles = spec.positionals;
  let rest = args;
  if (spec.modes && args[0] !== undefined && Object.hasOwn(spec.modes, args[0])) {
    roles = spec.modes[args[0]];
    rest = args.slice(1);
  }
  let positionals = 0;
  const given = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (spec.indexed && i < roles.length && a.startsWith('-')) return `${label}: ${script} reads argument ${i + 1} as the ${roles[i]} path, so a flag cannot go there (${a}); give all ${roles.length} paths first`;
    if (a.startsWith('-')) {
      const eqAt = a.indexOf('=');
      const name = eqAt === -1 ? a : a.slice(0, eqAt);
      // A flag the spec declares is checked by its own role below (weekly-digest --dir only reads); others named like outputs are refused.
      const declared = Boolean(spec.next?.[name] || spec.eq?.[name] || spec.optionalNext?.[name]);
      if (OUTPUT_FLAG.test(a) && !declared) return `${label}: ${script} does not write to a caller-chosen file (${a})`;
      if (eqAt !== -1) {
        const role = spec.eq?.[name];
        if (!role) return `${label}: ${script} does not accept ${name}=...; it would read the token as a path`;
        const why = check(role, a.slice(eqAt + 1));
        if (why) return why;
        continue;
      }
      const role = spec.next?.[name] ?? spec.optionalNext?.[name];
      if (role) {
        const value = rest[i + 1];
        // Like the scripts' own parsers: the next token is the value unless it is another --flag.
        if (value === undefined || value.startsWith('--')) {
          if (spec.optionalNext?.[name]) continue;
          return `${label}: ${script} ${name} needs a value`;
        }
        i += 1;
        const why = check(role, value);
        if (why) return why;
        continue;
      }
      if (!spec.switches?.includes(a)) return `${label}: ${script} does not accept ${a}; it would read the token as a path`;
      continue;
    }
    const role = roles[positionals] ?? spec.rest;
    positionals += 1;
    if (!role) return `${label}: ${script} takes at most ${roles.length} path argument${roles.length === 1 ? '' : 's'} (${a})`;
    given.push(a);
    const why = check(role, a);
    if (why) return why;
  }
  if (spec.compilesNextToInput && given[0] !== undefined) {
    for (const sibling of latexCompileSiblings(given[0])) {
      const why = writable(policy, sibling, label);
      if (why) return `${why} (${script} compiles next to its input)`;
    }
  }
  return null;
}

// A dash token a script will parse as a flag: a name without path characters, or a number.
const FLAG_SHAPE = /^(--?[A-Za-z][A-Za-z0-9_-]*(=.*)?|-\d+(\.\d+)?)$/;

// Schemes a Playwright- or fetch-based script would open locally, or that are not plain web fetches.
const LOCAL_SCHEME = /^(file|view-source|chrome|chrome-extension|about|blob|filesystem|jar|ftp|ws|wss|data|javascript):/i;

/** URL arguments and inline flag values: no local or non-web scheme, and http(s) only to a public-looking host. */
function checkUrlArgs(args, label) {
  for (const a of args) {
    for (const v of [a, inlineValue(a)]) {
      if (v === null) continue;
      const scheme = v.match(LOCAL_SCHEME);
      if (scheme) return `${label}: ${scheme[1].toLowerCase()}: URLs may not be passed to a script`;
      if (/^https?:/i.test(v)) {
        const why = checkUrlLiteral(v, label);
        if (why) return why;
      }
    }
  }
  return null;
}

/** The http(s) arguments and inline flag values of a command, for the hook's DNS check after checkBash. */
export function httpUrlsIn(command) {
  const out = [];
  for (const t of tokenize(command) ?? []) for (const v of [t, inlineValue(t)]) if (v !== null && /^https?:/i.test(v)) out.push(v);
  return out;
}

/**
 * Flags whose value names a file the script reads URLs from and then opens or fetches, from an audit of every
 * script a session may run: a 'lines' file is opened line by line, each line as a URL; a 'text' file (a portals
 * or company YAML) carries URLs among other fields. Each one gets the same URL checks as an argument.
 */
const URL_LIST_FLAGS = {
  'check-liveness.mjs': { '--file': 'lines' },
  'audit-portals.mjs': { '--file': 'text' },
  'verify-portals.mjs': { '--file': 'text' },
  'discover-ats.mjs': { '--in': 'text' },
};
/** A list file larger than this is refused rather than partly checked. */
export const URL_LIST_MAX_BYTES = 256 * 1024;
const URL_IN_TEXT = /https?:\/\/[^\s'"<>`)\]}]+/gi;
// A local scheme used as a value (file:///x, about:blank), not a YAML key followed by a space.
const LOCAL_SCHEME_IN_TEXT = /(?:^|[^A-Za-z0-9+.-])(file|view-source|chrome|chrome-extension|about|blob|filesystem|jar|ftp|ws|wss|data|javascript):(?=\S)/im;

/** The URL list files a command names, with how each is read; empty for every other script. */
export function urlListFilesIn(command) {
  const tokens = tokenize(command) ?? [];
  const spec = tokens[0] === 'node' ? URL_LIST_FLAGS[tokens[1]] : undefined;
  if (!spec) return [];
  const out = [];
  for (let i = 2; i < tokens.length; i++) {
    for (const [flag, format] of Object.entries(spec)) {
      if (tokens[i] === flag && tokens[i + 1] !== undefined) out.push({ file: tokens[i + 1], format });
      else if (tokens[i].startsWith(`${flag}=`)) out.push({ file: tokens[i].slice(flag.length + 1), format });
    }
  }
  return out;
}

/**
 * The URLs a list file holds, or the reason the call is refused: the file must pass the read checks, be a
 * regular file no larger than URL_LIST_MAX_BYTES, and hold only web URLs (every line of a 'lines' file must be one).
 */
export function readUrlList(policy, file, cwd, format, label = 'Bash') {
  const why = checkRead(policy, { file_path: file }, cwd, label);
  if (why) return { reason: why };
  const { abs } = locateRead(policy, file);
  let text;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { reason: `${label}: ${file} is not a regular file, so its URLs cannot be checked` };
    if (st.size > URL_LIST_MAX_BYTES) return { reason: `${label}: ${file} is larger than ${URL_LIST_MAX_BYTES} bytes, so its URLs cannot be checked` };
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { reason: `${label}: cannot read ${file} to check its URLs (${(err && err.code) || (err && err.message)})` };
  }
  if (format === 'lines') {
    const urls = [];
    for (const [i, raw] of text.split('\n').entries()) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (!/^https?:\/\//i.test(line)) return { reason: `${label}: line ${i + 1} of ${file} is not an http or https URL (${line.slice(0, 80)})` };
      urls.push(line);
    }
    return { urls };
  }
  const local = text.match(LOCAL_SCHEME_IN_TEXT);
  if (local) return { reason: `${label}: ${file} holds ${local[1].toLowerCase()}: URLs, which may not reach a script` };
  return { urls: text.match(URL_IN_TEXT) ?? [] };
}

function checkScript(policy, script, args, label) {
  const urlWhy = checkUrlArgs(args, label);
  if (urlWhy) return urlWhy;
  const writer = WRITER_SCRIPTS[script];
  if (writer) return checkWriterScript(policy, script, writer, args, label);
  // Scripts that write only to their own fixed files: path arguments are read inside the roots and never protected.
  // A dash token that is not a plain flag name (-x/../../etc) is refused: lax parsers take it as a path.
  for (const a of args) {
    if (a.startsWith('-')) {
      if (!FLAG_SHAPE.test(a)) return `${label}: ${a} is not a flag; a path may not start with -`;
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

/**
 * Scripts no session may run, whatever its policy lists: each starts an agent CLI of its own outside the session
 * guard, read confinement and the Bash allowlist (batch-runner.sh runs `claude -p --dangerously-skip-permissions`
 * workers; rank-pipeline.mjs runs `claude -p`, or whatever binary `--cli` names). Paths relative to the code root.
 */
export const AGENT_SPAWNING_SCRIPTS = Object.freeze(['batch/batch-runner.sh', 'rank-pipeline.mjs']);

/** The agent-spawning script a `node` or `bash` command runs, compared without case (macOS volumes ignore it). */
function agentSpawningScript(tokens) {
  if ((tokens[0] !== 'node' && tokens[0] !== 'bash') || tokens[1] === undefined) return null;
  const script = path.posix.normalize(tokens[1]).toLowerCase();
  return AGENT_SPAWNING_SCRIPTS.find((s) => s.toLowerCase() === script) ?? null;
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
  const spawner = agentSpawningScript(tokens);
  if (spawner) return `Bash: ${spawner} starts agent CLIs outside the session guard, so no session may run it`;
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
