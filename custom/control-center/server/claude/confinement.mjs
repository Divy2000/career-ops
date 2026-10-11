// Confinement shared by the session invocation builder (invocation.ts, modes.ts) and the daily job's headless
// policy pass (custom/immigration/run-daily.sh), which runs outside the app: read deny rules, the guard policy file
// and the guard hook wiring. Plain .mjs with no dependencies, so that script can import it with nothing but node.
// Dev Chat cannot edit it (server/claude/** is protected).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GUARD_HOOK_PATH = path.join(here, 'guard-hook.mjs');
// Preloaded into every child the app starts (server/system/child-env.ts): rendered HTML reads no local file but itself.
export const LOCAL_FILE_GUARD_PATH = path.join(here, 'local-file-guard.mjs');
const CONTRACT_FILE = path.join(here, '..', 'core', 'contract.json');

/** The leading x.y.z (with an optional -tag) of `claude --version` output. */
export function parseClaudeVersion(out) {
  const m = String(out).trim().match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:\s|$)/);
  return m ? m[1] : null;
}

/** The Claude Code versions whose confinement was probed (contract.json claude.approvedVersions). */
export function contractApprovedVersions(contractFile = CONTRACT_FILE) {
  const listed = JSON.parse(fs.readFileSync(contractFile, 'utf8'))?.claude?.approvedVersions;
  if (!Array.isArray(listed)) throw new Error(`${contractFile} lists no claude.approvedVersions`);
  return listed;
}

/**
 * Asks `bin --version` (autoupdater off, so asking cannot update it) and says whether that version may run outside
 * the app: `problem` is null for an approved version, else why not. `identity` (real path @ version) lets a caller
 * check right before a spawn that the binary is still the one it approved. Throws when the version cannot be read.
 */
export function claudeVersionGate(bin, approved = contractApprovedVersions()) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } });
  const version = r.status === 0 ? parseClaudeVersion(r.stdout) : null;
  if (!version) throw new Error(`could not read the Claude Code version from ${bin} (exit ${r.status ?? r.error?.code}${r.stdout?.trim() ? `: ${JSON.stringify(r.stdout.trim().slice(0, 80))}` : ''})`);
  let real = bin;
  try {
    // .native asks the OS; fs.realpathSync collapses `..` on paper first, which through a symlinked folder is another file.
    real = fs.realpathSync.native(bin);
  } catch {
    /* a bare name that spawn found on PATH: its spelling stands for it */
  }
  const list = approved.length ? approved.join(', ') : 'none yet';
  return { version, identity: `${real}@${version}`, problem: approved.includes(version) ? null : `Claude Code ${version} is not approved for the confined pass (approved: ${list}); install an approved one (claude install ${approved[0] ?? '<version>'}) or approve it with npm --prefix custom/control-center run probe:reads -- --record` };
}

/**
 * Write globs that name files of the code checkout (System Layer: the app's own custom/ code and the CV and cover
 * templates cv-templates.mjs reads from templates/). Every other write glob names user files (User Layer), which live
 * in the data root: with a separate data root the guard allows them there and nowhere else, whoever wrote the policy.
 */
export const CODE_ROOT_WRITE_GLOBS = Object.freeze(['custom/**', 'templates/cv-*.html', 'templates/cover-*.html']);

/** Denied for every non Dev Chat session and for the daily policy pass, regardless of class (enforced by the hook). */
export const ALWAYS_DENIED_WRITES = ['data/blacklist.md', 'data/applications.md', 'applications.md', 'data/control-center/**'];

/**
 * Extra write-deny globs for the tracker file when CAREER_OPS_TRACKER points it somewhere other than the hardcoded
 * defaults, so a session whose write scope covers that path (Dev Chat's data/** included) still cannot hand-edit the
 * tracker: it changes only through set-status.mjs (its lock, validation and status-log). Returns the tracker's path
 * relative to each root that contains it (relative overrides resolve against the code root, the repo); empty without
 * an override, since the default data/applications.md and applications.md are already denied above.
 */
export function trackerDenyGlobs(dataRoot, codeRoot = dataRoot, env = process.env) {
  const override = String(env?.CAREER_OPS_TRACKER ?? '').trim();
  if (!override) return [];
  const abs = path.isAbsolute(override) ? path.resolve(override) : path.resolve(codeRoot, override);
  // Both the given spelling and the real one (a symlinked folder, macOS /var for /private/var), as the hook compares
  // real paths: the real path of the deepest folder on disk, with the rest of the name appended.
  let realAbs = abs;
  for (let dir = abs, rest = ''; ; rest = path.join(path.basename(dir), rest), dir = path.dirname(dir)) {
    try {
      realAbs = path.join(fs.realpathSync.native(dir), rest);
      break;
    } catch {
      if (dir === path.dirname(dir)) break;
    }
  }
  const out = [];
  for (const root of [...new Set([dataRoot, codeRoot])]) {
    let real = root;
    try {
      real = fs.realpathSync.native(root);
    } catch {
      /* a root not on disk: the given spelling only */
    }
    for (const target of new Set([abs, realAbs])) {
      const rel = path.relative(real, target);
      if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) out.push(rel.split(path.sep).join('/'));
    }
  }
  return [...new Set(out)];
}

/**
 * Secret files no session may read, relative to each root and matched case-insensitively (an over-deny on
 * case-sensitive volumes, by design). Enforced as Read deny rules in the per-turn settings file (under each
 * root's given and real path) and by the guard hook. File-name based: a secret under another name is readable.
 */
export const READ_DENY = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.ppk',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.git/config',
  '**/credentials*.json',
  '**/client_secret*.json',
  '**/service-account*.json',
  '**/*.token',
];

/** Credential stores in the home directory, denied as Read rules (they are outside every root anyway). */
export const HOME_READ_DENY = [
  '~/.ssh/**',
  '~/.aws/**',
  '~/.gnupg/**',
  '~/.azure/**',
  '~/.kube/**',
  '~/.config/gh/**',
  '~/.config/gcloud/**',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/.claude.json',
  '~/.claude/.credentials.json',
  '~/Library/Keychains/**',
  '~/Library/Cookies/**',
  '~/Library/Safari/**',
  '~/Library/Application Support/Google/Chrome/**',
  '~/Library/Application Support/Firefox/**',
];

/** `//abs/path` permission-rule spelling of an absolute path. */
export function absRule(p) {
  return `//${p.replace(/^\/+/, '')}`;
}

/** A path and its real path when they differ (a root reached through a symlink), so rules hold for either spelling. */
export function spellings(p) {
  let real = p;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    /* not on disk (unit tests): the given spelling only */
  }
  return [...new Set([p, real])];
}

/** Read deny rules: the home credential stores, the guard root when there is one, and READ_DENY under every root. */
export function buildReadDenyRules(roots, guardRoot) {
  const out = HOME_READ_DENY.map((p) => `Read(${p})`);
  if (guardRoot !== undefined) for (const g of spellings(guardRoot)) out.push(`Read(${absRule(g)}/**)`);
  for (const root of [...new Set(roots)]) for (const spelled of spellings(root)) for (const glob of READ_DENY) out.push(`Read(${absRule(spelled)}/${glob})`);
  return [...new Set(out)];
}

/** POSIX single-quoting: the hook command runs through a shell, and checkouts can live under paths with spaces. */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude Code blocks a tool call only when a hook exits 2; any other failure
 * (a split path, a missing file, a crash before the hook's own try/catch) is
 * non-blocking. `|| exit 2` turns every failure into a block.
 */
export function guardHookCommand(nodePath = process.execPath, hookPath = GUARD_HOOK_PATH) {
  return `${shellQuote(nodePath)} ${shellQuote(hookPath)} || exit 2`;
}

/** Tools the guard hook sees before they run. The matcher holds only names and `|`, so the CLI matches each name exactly. */
export const PRE_TOOL_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Glob|Grep|WebFetch|Agent|Task|PowerShell|mcp__playwright__browser_click|mcp__playwright__browser_press_key';
/**
 * Every Playwright MCP tool, so the hook can refuse the ones it does not know. Any other character makes the CLI
 * (2.1.289) read a matcher as a regular expression tested against the tool name; ^ anchors it to the server prefix.
 */
export const PLAYWRIGHT_TOOL_MATCHER = '^mcp__playwright__';
/**
 * A hook that times out does not block (Claude Code docs, probe C14): the CLI flags and the settings
 * permissions are the gate, and the hook is the second layer. 30 s bounds its DNS lookups with room to spare.
 */
export const HOOK_TIMEOUT_S = 30;

/** The settings `hooks` block: the guard before every matched tool call and after every write. */
export function guardHooks(command = guardHookCommand()) {
  const hook = { type: 'command', command, timeout: HOOK_TIMEOUT_S };
  return {
    PreToolUse: [
      { matcher: PRE_TOOL_MATCHER, hooks: [hook] },
      { matcher: PLAYWRIGHT_TOOL_MATCHER, hooks: [hook] },
    ],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [hook] }],
  };
}

/** Writes the guard policy JSON into `dir` and returns its path and the sha256 of its exact bytes (CC_POLICY_SHA256). */
export function writeGuardPolicy(dir, policy) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'policy.json');
  // Every writer of a policy (a session turn, the daily job's policy pass) gets the tracker's own deny.
  const tracker = policy.codeRoot ? trackerDenyGlobs(policy.dataRoot ?? policy.codeRoot, policy.codeRoot) : [];
  const deny = [...new Set([...(policy.deny ?? []), ...tracker])];
  const bytes = JSON.stringify(tracker.length ? { ...policy, deny } : policy, null, 2);
  fs.writeFileSync(file, bytes);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Refuses roots a session could not be confined to: the filesystem root, the home directory, or a parent of it,
 * compared by real path (the on-disk case on macOS). A root that cannot be resolved is refused too.
 */
export function assertRootsConfinable(codeRoot, dataRoot, home) {
  const real = (label, p) => {
    try {
      return fs.realpathSync.native(p);
    } catch (err) {
      throw new Error(`the ${label} ${p} cannot be resolved (${err.message}); sessions are refused`, { cause: err });
    }
  };
  const homeReal = real('home directory', home);
  for (const [label, p] of [['repo root', codeRoot], ['data root', dataRoot]]) {
    const r = real(label, p);
    if (r === path.parse(r).root) throw new Error(`the ${label} is the filesystem root, so a session could read every file; sessions are refused`);
    const rel = path.relative(r, homeReal);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      throw new Error(`the ${label} ${r} is or contains your home directory (${homeReal}), so a session could read all of it; sessions are refused. Point CAREER_OPS_ROOT at a dedicated folder.`);
    }
  }
}
