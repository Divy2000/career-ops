import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from '../supervisor/preflight.js';

export type ClientMode = 'vite' | 'dist' | 'none';

export interface ServerConfig {
  /** career-ops checkout (upstream code). */
  codeRoot: string;
  /** User data root (CAREER_OPS_ROOT contract). */
  dataRoot: string;
  /** The data root came from CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR (set by the supervisor); only then do launchd plists pin it. */
  dataRootFromEnv: boolean;
  /** Session policies, hook settings and revert bookkeeping; outside both roots (CC_GUARD_DIR, set by the supervisor). */
  guardRoot: string;
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
  /** Replaces plugins/h1b-sponsor/check.mjs for the Sponsorship lookup (tests only; CC_H1B_CHECK_SCRIPT is honored under NODE_ENV=test). */
  h1bCheckScript?: string;
  /** The community plugins folder Audit plugins scans (default <codeRoot>/plugins.local; tests point it at a temp folder). */
  pluginsLocalDir?: string;
  /** Answers the "is run-daily.sh running" probe without looking at host processes (tests only; CC_FAKE_DAILY is honored under NODE_ENV=test). */
  fakeDaily?: 'idle' | 'running';
  /** The built client's folder (default <package>/dist; tests point it at a temp build). */
  distDir?: string;
}

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CODE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (the supervisor sets it)`);
  return v;
}

function fakeDailyFromEnv(env: NodeJS.ProcessEnv): Pick<ServerConfig, 'fakeDaily'> {
  if (env.NODE_ENV !== 'test' || !env.CC_FAKE_DAILY) return {};
  if (env.CC_FAKE_DAILY !== 'idle' && env.CC_FAKE_DAILY !== 'running') throw new Error(`CC_FAKE_DAILY must be idle or running (got ${env.CC_FAKE_DAILY})`);
  return { fakeDaily: env.CC_FAKE_DAILY };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const publicPort = Number(env.CC_PUBLIC_PORT);
  if (!Number.isInteger(publicPort) || publicPort <= 0) throw new Error('CC_PUBLIC_PORT must be a port number');
  const client = (env.CC_CLIENT ?? 'vite') as ClientMode;
  if (!['vite', 'dist', 'none'].includes(client)) throw new Error(`CC_CLIENT must be vite, dist or none (got ${client})`);
  return {
    codeRoot: env.CC_CODE_ROOT ?? DEFAULT_CODE_ROOT,
    dataRoot: requireEnv('CC_DATA_ROOT'),
    dataRootFromEnv: env.CC_DATA_ROOT_FROM_ENV !== '0',
    guardRoot: requireEnv('CC_GUARD_DIR'),
    publicPort,
    token: requireEnv('CC_TOKEN'),
    sessionSecret: requireEnv('CC_SESSION_SECRET'),
    client,
    // Absolute once, here: sessions, the daily plist and Run the daily job now all run this path.
    claudeBin: resolveClaudeBin(env.CC_CLAUDE_BIN ?? 'claude', { env }),
    nodeEnv: env.NODE_ENV ?? 'development',
    watch: env.CC_WATCH !== '0',
    launchAgentsDir: env.CC_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
    claudeProjectsDir: env.CC_CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects'),
    ...(env.NODE_ENV === 'test' && env.CC_H1B_CHECK_SCRIPT ? { h1bCheckScript: env.CC_H1B_CHECK_SCRIPT } : {}),
    ...fakeDailyFromEnv(env),
  };
}
