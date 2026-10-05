import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import type { ServerConfig } from '../config.js';
import { childEnv } from '../system/child-env.js';
import { approvedClaudeVersions, parseClaudeVersion, unapprovedWarning } from '../claude/cli-version.js';

export interface SystemStatus {
  node: string;
  /** `approved`: sessions may run on this version; `problem` says why not when claude runs but is not approved. */
  claude: { bin: string; version: string | null; error: string | null; approved: boolean; problem: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}

export type Exec = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** spawn() with shell:false, resolving with the exit code instead of throwing. */
export const execNoShell: Exec = (cmd, args, { cwd, timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: false, env: childEnv(env), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as NodeJS.ErrnoException).code as unknown as number) : err ? 1 : 0;
      const stderrText = String(stderr ?? '') + (err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? `\n${cmd}: not found` : '');
      resolve({ code, stdout: String(stdout ?? ''), stderr: stderrText });
    });
  });

/**
 * `readToken` is the reader the sessions use (the Keychain, or the test token), so the status and a session agree on
 * whether a token is stored. The token value is discarded and never leaves this process.
 */
export async function readSystemStatus(cfg: ServerConfig, readToken: () => Promise<string>, exec: Exec = execNoShell): Promise<SystemStatus> {
  const [claude, tokenStored, version] = await Promise.all([
    exec(cfg.claudeBin, ['--version'], { timeoutMs: 8000 }),
    readToken().then(
      (token) => token.length > 0,
      () => false,
    ),
    readCareerOpsVersion(cfg),
  ]);
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
    keychainTokenPresent: tokenStored,
    anthropicApiKeySet: Boolean(process.env.ANTHROPIC_API_KEY),
    careerOps: { version },
  };
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
