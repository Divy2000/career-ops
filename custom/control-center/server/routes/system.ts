import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import type { ServerConfig } from '../config.js';

export interface SystemStatus {
  node: string;
  claude: { bin: string; version: string | null; error: string | null };
  roots: { code: string; data: string };
  keychainTokenPresent: boolean;
  anthropicApiKeySet: boolean;
  careerOps: { version: string | null };
}

export type Exec = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** spawn() with shell:false, resolving with the exit code instead of throwing. */
export const execNoShell: Exec = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, shell: false, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as NodeJS.ErrnoException).code as unknown as number) : err ? 1 : 0;
      const stderrText = String(stderr ?? '') + (err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? `\n${cmd}: not found` : '');
      resolve({ code, stdout: String(stdout ?? ''), stderr: stderrText });
    });
  });

export async function readSystemStatus(cfg: ServerConfig, exec: Exec = execNoShell): Promise<SystemStatus> {
  const [claude, keychain, version] = await Promise.all([
    exec(cfg.claudeBin, ['--version'], { timeoutMs: 8000 }),
    exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'], { timeoutMs: 5000 }),
    readCareerOpsVersion(cfg),
  ]);
  return {
    node: process.version,
    claude: {
      bin: cfg.claudeBin,
      version: claude.code === 0 ? claude.stdout.trim() : null,
      error: claude.code === 0 ? null : claude.stderr.trim() || `exit ${claude.code}`,
    },
    roots: { code: cfg.codeRoot, data: cfg.dataRoot },
    // Exit code only: the token value is discarded and never leaves this process.
    keychainTokenPresent: keychain.code === 0,
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

export async function systemRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; exec?: Exec }): Promise<void> {
  app.get('/api/system/status', async () => readSystemStatus(opts.cfg, opts.exec));
}
