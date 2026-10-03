import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ClientMode = 'vite' | 'dist' | 'none';

export interface ServerConfig {
  /** career-ops checkout (upstream code). */
  codeRoot: string;
  /** User data root (CAREER_OPS_ROOT contract). */
  dataRoot: string;
  /** Port the supervisor listens on; Host headers must name it. */
  publicPort: number;
  /** One-time URL token printed by the supervisor. */
  token: string;
  /** Value of the cc_session cookie once the token was redeemed. */
  sessionSecret: string;
  client: ClientMode;
  claudeBin: string;
  nodeEnv: string;
  /** Start the data-root file watcher (off in API tests). */
  watch: boolean;
  /** Where the launchd plists live (tests point this at a temp dir). */
  launchAgentsDir: string;
  /** Claude Code local logs read by the usage meter (read-only). */
  claudeProjectsDir: string;
}

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CODE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (the supervisor sets it)`);
  return v;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicPort = Number(env.CC_PUBLIC_PORT);
  if (!Number.isInteger(publicPort) || publicPort <= 0) throw new Error('CC_PUBLIC_PORT must be a port number');
  const client = (env.CC_CLIENT ?? 'vite') as ClientMode;
  if (!['vite', 'dist', 'none'].includes(client)) throw new Error(`CC_CLIENT must be vite, dist or none (got ${client})`);
  return {
    codeRoot: env.CC_CODE_ROOT ?? DEFAULT_CODE_ROOT,
    dataRoot: requireEnv('CC_DATA_ROOT'),
    publicPort,
    token: requireEnv('CC_TOKEN'),
    sessionSecret: requireEnv('CC_SESSION_SECRET'),
    client,
    claudeBin: env.CC_CLAUDE_BIN ?? 'claude',
    nodeEnv: env.NODE_ENV ?? 'development',
    watch: env.CC_WATCH !== '0',
    launchAgentsDir: env.CC_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
    claudeProjectsDir: env.CC_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects'),
  };
}
