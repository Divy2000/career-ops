import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import type { ServerConfig } from '../config.js';
import { childEnv } from '../system/child-env.js';
import { approvedClaudeVersions, parseClaudeVersion, unapprovedWarning } from '../claude/cli-version.js';

export type KeychainTokenStatus = { state: 'present' | 'missing'; reason: null } | { state: 'unreadable'; reason: string };

export interface SystemStatus {
  node: string;
  /** `approved`: sessions may run on this version; `problem` says why not when claude runs but is not approved. */
  claude: { bin: string; version: string | null; error: string | null; approved: boolean; problem: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  /** `unreadable`: the reader failed for a reason other than an absent token (a locked keychain, a timeout), given in `reason`. */
  keychainToken: KeychainTokenStatus;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}

/** `timedOut`: the command ran past `timeoutMs` and was killed; its code is then TIMEOUT_EXIT_CODE. */
export type Exec = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;

/** timeout(1)'s exit code: no script exits with it, so an exit map or explainFailure never reads a timeout as its own failure. */
export const TIMEOUT_EXIT_CODE = 124;

/** spawn() with shell:false, resolving with the exit code instead of throwing. */
export const execNoShell: Exec = (cmd, args, { cwd, timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: false, env: childEnv(env), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // execFile kills a command that runs past its timeout (killed, no exit code): that is a timeout, not exit 1.
      const timedOut = Boolean(err?.killed) && typeof err?.code !== 'number';
      const code = timedOut ? TIMEOUT_EXIT_CODE : err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      const note = timedOut ? `\n${cmd} timed out after ${timeoutMs / 1000} s` : err?.code === 'ENOENT' ? `\n${cmd}: not found` : '';
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + note, timedOut });
    });
  });

/**
 * `readToken` is the reader the sessions use (the Keychain, or the test token), so the status and a session agree on
 * whether a token is stored. The token value is discarded and never leaves this process.
 */
export async function readSystemStatus(cfg: ServerConfig, readToken: () => Promise<string>, exec: Exec = execNoShell): Promise<SystemStatus> {
  const [claude, keychainToken, version] = await Promise.all([exec(cfg.claudeBin, ['--version'], { timeoutMs: 8000 }), readKeychainToken(readToken), readCareerOpsVersion(cfg)]);
  const approvedList = approvedClaudeVersions(cfg.nodeEnv);
  const parsed = claude.code === 0 ? parseClaudeVersion(claude.stdout) : null;
  const approved = parsed !== null && approvedList.includes(parsed);
  return {
    node: process.version,
    claude: {
      bin: cfg.claudeBin,
      version: claude.code === 0 ? claude.stdout.trim() : null,
      error: claude.code === 0 ? null : claude.stderr.trim() || `exit ${claude.code}`,
      approved,
      problem: claude.code !== 0 || approved ? null : parsed ? unapprovedWarning(parsed, approvedList) : `could not read the Claude Code version from ${JSON.stringify(claude.stdout.trim().slice(0, 80))}; sessions are refused until it reports an approved version.`,
    },
    roots: { code: cfg.codeRoot, data: cfg.dataRoot },
    keychainTokenPresent: keychainToken.state === 'present',
    keychainToken,
    anthropicApiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    careerOps: { version },
  };
}

/**
 * The reader's own error tells an absent token from one it could not read (keychainTokenReader in server/claude/manager.ts):
 * only an absent or empty token's error says to run claude setup-token. Any other error is the reason the read failed.
 */
async function readKeychainToken(readToken: () => Promise<string>): Promise<KeychainTokenStatus> {
  try {
    return (await readToken()).length > 0 ? { state: 'present', reason: null } : { state: 'missing', reason: null };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).trim() || 'the token reader failed without saying why';
    return message.includes('claude setup-token') ? { state: 'missing', reason: null } : { state: 'unreadable', reason: message };
  }
}

async function readCareerOpsVersion(cfg: ServerConfig): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    const pkg = JSON.parse(await fs.readFile(`${cfg.codeRoot}/package.json`, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export async function systemRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; readToken: () => Promise<string>; exec?: Exec }): Promise<void> {
  app.get('/api/system/status', async () => readSystemStatus(opts.cfg, opts.readToken, opts.exec));
}
