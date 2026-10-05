import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approvedClaudeVersions, parseClaudeVersion, unapprovedWarning } from '../server/claude/cli-version.js';

export const NODE_FLOOR = '22.6.0';

export interface PreflightInput {
  claudeBin: string;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  /** Injected runner: an exit code, or the code and stdout (`claude --version` needs its output). */
  exec?: (cmd: string, args: string[]) => Promise<number | { code: number; stdout: string }>;
  /** Per-attempt limit for `claude --version`; a cold first start can self-update before it answers. */
  claudeTimeoutMs?: number;
  /** Every claude binary found on this machine; more than one is a warning, since the first is pinned for the server. */
  claudeCandidates?: string[];
  /** Claude Code versions sessions may run on (default: contract.json, plus the test double under NODE_ENV=test). */
  approvedVersions?: string[];
  platform?: NodeJS.Platform;
  /** Where local managed settings live (default: the macOS locations from the managed-settings docs). */
  managedSettings?: { dir?: string; plists?: string[] };
}

export const CLAUDE_TIMEOUT_MS = 30_000;
const CLAUDE_ATTEMPTS = 2;

interface Probe {
  code: number;
  timedOut: boolean;
  enoent: boolean;
  stdout: string;
  stderr: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export const KEYCHAIN_HELP =
  'Keychain item "career-ops-claude-token" is missing. Run: claude setup-token, then\n  security add-generic-password -U -a "$USER" -s career-ops-claude-token -w';

function probe(cmd: string, args: string[], timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: false, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, timedOut: false, enoent: false, stdout: String(stdout ?? ''), stderr: '' });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      resolve({
        code: typeof e.code === 'number' ? e.code : 1,
        timedOut: e.killed === true,
        enoent: e.code === 'ENOENT',
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

async function exitCode(cmd: string, args: string[]): Promise<number | { code: number; stdout: string }> {
  const r = await probe(cmd, args, 8000);
  return r.enoent ? 127 : r.code;
}

const CLAUDE_FALLBACKS = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'];

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of the claude binary: a name with a slash is taken as given, a bare name is looked up on PATH,
 * then in the usual install locations. A bare name that is found nowhere is returned unchanged so the probe reports ENOENT.
 */
/** Every distinct executable (by real file) `bin` resolves to, in pick order: PATH, the native installer's ~/.local/bin, then Homebrew and /usr/local. */
export function claudeCandidates(bin: string, opts: { env?: NodeJS.ProcessEnv; home?: string; candidates?: string[] } = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const all = [...dirs.map((d) => path.join(d, bin)), path.join(home, '.local', 'bin', bin), ...(opts.candidates ?? CLAUDE_FALLBACKS)];
  // Two paths to the same file (a symlink into ~/.local/bin is common) are one install; the first path listed stands for it.
  const seen = new Set<string>();
  return all.filter((c) => {
    if (!path.isAbsolute(c) || !isExecutable(c)) return false;
    const real = fs.realpathSync(c);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/**
 * Absolute path of the claude binary: an absolute path is kept as given, a relative one with a slash is joined to the
 * folder the user started from (INIT_CWD, which npm sets, else the cwd), a bare name is looked up in claudeCandidates
 * order. A bare name that is found nowhere is returned unchanged so the probe reports ENOENT.
 * The join is textual: path.resolve collapses `..` on paper, and through a symlinked folder that names a different file
 * than the kernel opens (and than launchd/install.sh pins). Only `.` and empty segments go, as they name the same folder.
 */
export function resolveClaudeBin(bin: string, opts: { env?: NodeJS.ProcessEnv; home?: string; candidates?: string[] } = {}): string {
  if (path.isAbsolute(bin)) return bin;
  if (bin.includes('/')) {
    const from = (opts.env ?? process.env).INIT_CWD;
    const base = from && path.isAbsolute(from) ? from : process.cwd();
    return [base.replace(/\/+$/, ''), ...bin.split('/').filter((seg) => seg !== '.' && seg !== '')].join('/');
  }
  return claudeCandidates(bin, opts)[0] ?? bin;
}

function claudeFailure(bin: string, p: Probe, timeoutMs: number): string {
  const detail = p.enoent
    ? 'not found (ENOENT)'
    : p.timedOut
      ? `timed out after ${timeoutMs / 1000}s`
      : `exit code ${p.code}${p.stderr ? `: ${p.stderr.slice(-300)}` : ''}`;
  return `Claude CLI not runnable at "${bin}" (${detail}, ${CLAUDE_ATTEMPTS} attempts). Install Claude Code or set CC_CLAUDE_BIN.`;
}

/**
 * What `claude --version` says about sessions: an error when claude does not run or its version cannot be read; a
 * warning when it is not an approved version, since every turn refuses it anyway (assertApprovedClaude) and the
 * tracker, pipeline and editors need no Claude.
 */
async function probeClaude(input: PreflightInput): Promise<{ error: string } | { warning: string } | null> {
  const timeoutMs = input.claudeTimeoutMs ?? CLAUDE_TIMEOUT_MS;
  let stdout: string;
  if (input.exec) {
    const out = await input.exec(input.claudeBin, ['--version']);
    const code = typeof out === 'number' ? out : out.code;
    if (code !== 0) return { error: claudeFailure(input.claudeBin, { code, timedOut: false, enoent: code === 127, stdout: '', stderr: '' }, timeoutMs) };
    stdout = typeof out === 'number' ? '' : out.stdout;
  } else {
    let last: Probe = { code: 1, timedOut: false, enoent: false, stdout: '', stderr: '' };
    for (let attempt = 0; attempt < CLAUDE_ATTEMPTS; attempt++) {
      last = await probe(input.claudeBin, ['--version'], timeoutMs);
      if (last.code === 0 && !last.timedOut) break;
      if (last.enoent) break;
    }
    if (last.code !== 0 || last.timedOut) return { error: claudeFailure(input.claudeBin, last, timeoutMs) };
    stdout = last.stdout;
  }
  const version = parseClaudeVersion(stdout);
  if (!version) return { error: `could not read the Claude Code version from "${input.claudeBin}" (got ${JSON.stringify(stdout.trim().slice(0, 80))}); sessions run only on an approved version.` };
  const approved = input.approvedVersions ?? approvedClaudeVersions(input.env.NODE_ENV ?? 'development');
  return approved.includes(version) ? null : { warning: unapprovedWarning(version, approved) };
}

export const MANAGED_SETTINGS_DIR = '/Library/Application Support/ClaudeCode';

/** The macOS managed preferences (MDM configuration profile) for Claude Code: machine-wide and per user. */
export function managedPlistPaths(user: string = os.userInfo().username): string[] {
  return ['/Library/Managed Preferences/com.anthropic.claudecode.plist', path.join('/Library/Managed Preferences', user, 'com.anthropic.claudecode.plist')];
}

/**
 * Managed settings outrank the session's --settings file: these keys would turn the guard hook off, drop the
 * session's deny rules, or widen what a session may run or read, so no session could be confined.
 */
const UNCONFINABLE: Array<{ key: string; set: (doc: Record<string, unknown>) => boolean; why: string }> = [
  { key: 'allowManagedHooksOnly', set: (d) => isSet(d.allowManagedHooksOnly), why: 'only managed hooks would run, so the session guard hook never would' },
  { key: 'allowManagedPermissionRulesOnly', set: (d) => isSet(d.allowManagedPermissionRulesOnly), why: "the sessions' own deny rules would be ignored" },
  { key: 'disableAllHooks', set: (d) => isSet(d.disableAllHooks), why: 'hooks are off, so the session guard hook would never run' },
  { key: 'permissions.allow', set: (d) => nonEmpty(permissionsOf(d).allow), why: 'managed allow rules widen what every session may do' },
  { key: 'permissions.additionalDirectories', set: (d) => nonEmpty(permissionsOf(d).additionalDirectories), why: 'managed additional directories widen what every session may read' },
];

// Claude Code reads a restrictive key it cannot parse as set, so anything but false or absent counts here too.
const isSet = (v: unknown) => v !== undefined && v !== null && v !== false;
const nonEmpty = (v: unknown) => Array.isArray(v) ? v.length > 0 : isSet(v);
const permissionsOf = (d: Record<string, unknown>) => (d.permissions && typeof d.permissions === 'object' ? (d.permissions as Record<string, unknown>) : {});

function plutilJson(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('plutil', ['-convert', 'json', '-o', '-', file], { shell: false, timeout: 10_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout))));
  });
}

/** Every local managed-settings document that would leave sessions unconfined, or that cannot be read (fails closed). */
export async function managedSettingsProblems(opts: { dir?: string; plists?: string[] } = {}): Promise<string[]> {
  const dir = opts.dir ?? MANAGED_SETTINGS_DIR;
  const sources: Array<{ file: string; read: () => Promise<string> }> = [];
  const main = path.join(dir, 'managed-settings.json');
  if (fs.existsSync(main)) sources.push({ file: main, read: async () => fs.readFileSync(main, 'utf8') });
  const dropIns = path.join(dir, 'managed-settings.d');
  if (fs.existsSync(dropIns)) {
    let names: string[];
    try {
      names = fs.readdirSync(dropIns);
    } catch (err) {
      return [`could not read managed settings in ${dropIns}: ${(err as Error).message}. Sessions are refused until it can be checked.`];
    }
    for (const name of names.filter((n) => !n.startsWith('.') && n.endsWith('.json')).sort()) {
      const file = path.join(dropIns, name);
      sources.push({ file, read: async () => fs.readFileSync(file, 'utf8') });
    }
  }
  for (const file of opts.plists ?? managedPlistPaths()) if (fs.existsSync(file)) sources.push({ file, read: () => plutilJson(file) });
  const problems: string[] = [];
  for (const src of sources) {
    let doc: unknown;
    try {
      doc = JSON.parse(await src.read());
    } catch (err) {
      problems.push(`could not read managed settings in ${src.file}: ${(err as Error).message}. Sessions are refused until it can be checked.`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`could not read managed settings in ${src.file}: not a JSON object. Sessions are refused until it can be checked.`);
      continue;
    }
    for (const rule of UNCONFINABLE) if (rule.set(doc as Record<string, unknown>)) problems.push(`managed Claude Code settings in ${src.file} set ${rule.key}: ${rule.why}. Remove it, or sessions cannot be confined to the repo and data roots.`);
  }
  return problems;
}

export function versionAtLeast(actual: string, floor: string): boolean {
  const a = actual.replace(/^v/, '').split('.').map(Number);
  const f = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = f[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const exec = input.exec ?? exitCode;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!versionAtLeast(input.nodeVersion, NODE_FLOOR)) {
    errors.push(`Node ${input.nodeVersion} is below the floor ${NODE_FLOOR}. Install a newer Node.`);
  }
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') errors.push(`The Control Center runs on macOS only (this is ${platform}): it reads the session token from the macOS Keychain and confines sessions with macOS paths.`);
  const claude = await probeClaude(input);
  if (claude && 'error' in claude) errors.push(claude.error);
  if (claude && 'warning' in claude) warnings.push(claude.warning);
  // Tests point CC_CLAUDE_BIN at the fake and must not depend on this machine's Keychain.
  const skipKeychain = input.env.NODE_ENV === 'test' && input.env.CC_SKIP_KEYCHAIN !== '0';
  if (!skipKeychain) {
    const r = await exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w']);
    if ((typeof r === 'number' ? r : r.code) !== 0) errors.push(KEYCHAIN_HELP);
  }
  errors.push(...(await managedSettingsProblems(input.managedSettings)));
  const others = (input.claudeCandidates ?? []).filter((c) => c !== input.claudeBin);
  if (others.length > 0) {
    warnings.push(`Several claude binaries are installed. Using ${input.claudeBin}; also found ${others.join(', ')}. Set CC_CLAUDE_BIN to choose another.`);
  }
  if (input.env.ANTHROPIC_API_KEY) {
    warnings.push('ANTHROPIC_API_KEY is set in this shell. Sessions force it empty and use the Keychain token.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function formatPreflight(r: PreflightResult): string {
  const lines = [...r.errors.map((e) => `error: ${e}`), ...r.warnings.map((w) => `warning: ${w}`)];
  return lines.join('\n');
}
