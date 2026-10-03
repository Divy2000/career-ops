import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NODE_FLOOR = '22.6.0';

export interface PreflightInput {
  claudeBin: string;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  exec?: (cmd: string, args: string[]) => Promise<number>;
  /** Per-attempt limit for `claude --version`; a cold first start can self-update before it answers. */
  claudeTimeoutMs?: number;
  /** Every claude binary found on this machine; more than one is a warning, since the first is pinned for the server. */
  claudeCandidates?: string[];
}

export const CLAUDE_TIMEOUT_MS = 30_000;
const CLAUDE_ATTEMPTS = 2;

interface Probe {
  code: number;
  timedOut: boolean;
  enoent: boolean;
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
    execFile(cmd, args, { shell: false, timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (!err) return resolve({ code: 0, timedOut: false, enoent: false, stderr: '' });
      const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
      resolve({
        code: typeof e.code === 'number' ? e.code : 1,
        timedOut: e.killed === true,
        enoent: e.code === 'ENOENT',
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

async function exitCode(cmd: string, args: string[]): Promise<number> {
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
/** Every distinct executable `bin` resolves to, in pick order: PATH, the native installer's ~/.local/bin, then Homebrew and /usr/local. */
export function claudeCandidates(bin: string, opts: { env?: NodeJS.ProcessEnv; home?: string; candidates?: string[] } = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const all = [...dirs.map((d) => path.join(d, bin)), path.join(home, '.local', 'bin', bin), ...(opts.candidates ?? CLAUDE_FALLBACKS)];
  return [...new Set(all.filter((c) => path.isAbsolute(c) && isExecutable(c)))];
}

/**
 * Absolute path of the claude binary: a name with a slash is taken as given, a bare name is looked up in claudeCandidates order.
 * A bare name that is found nowhere is returned unchanged so the probe reports ENOENT.
 */
export function resolveClaudeBin(bin: string, opts: { env?: NodeJS.ProcessEnv; home?: string; candidates?: string[] } = {}): string {
  if (bin.includes('/')) return bin;
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

async function probeClaude(input: PreflightInput): Promise<string | null> {
  const timeoutMs = input.claudeTimeoutMs ?? CLAUDE_TIMEOUT_MS;
  if (input.exec) {
    const code = await input.exec(input.claudeBin, ['--version']);
    return code === 0 ? null : claudeFailure(input.claudeBin, { code, timedOut: false, enoent: code === 127, stderr: '' }, timeoutMs);
  }
  let last: Probe = { code: 1, timedOut: false, enoent: false, stderr: '' };
  for (let attempt = 0; attempt < CLAUDE_ATTEMPTS; attempt++) {
    last = await probe(input.claudeBin, ['--version'], timeoutMs);
    if (last.code === 0 && !last.timedOut) return null;
    if (last.enoent) break;
  }
  return claudeFailure(input.claudeBin, last, timeoutMs);
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
  const claudeError = await probeClaude(input);
  if (claudeError) errors.push(claudeError);
  // Tests point CC_CLAUDE_BIN at the fake and must not depend on this machine's Keychain.
  const skipKeychain = input.env.NODE_ENV === 'test' && input.env.CC_SKIP_KEYCHAIN !== '0';
  if (!skipKeychain && (await exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'])) !== 0) {
    errors.push(KEYCHAIN_HELP);
  }
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
