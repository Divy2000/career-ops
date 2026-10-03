import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type BuiltApp } from '../../server/app.js';
import { SESSION_COOKIE } from '../../server/auth/plugin.js';
import { DEFAULT_CODE_ROOT, type ServerConfig } from '../../server/config.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_ROOT = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'root');
export const FAKE_CLAUDE = path.join(PACKAGE_ROOT, 'tests', 'fakes', 'claude.mjs');

/** Fresh copy of the synthetic data root; never the user's real one. */
export function copyFixtureRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-root-'));
  fs.cpSync(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

export const TEST_PORT = 4317;
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;
export const TEST_TOKEN = 'test-token-value';
export const TEST_SECRET = 'test-session-secret';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    codeRoot: DEFAULT_CODE_ROOT,
    dataRoot: copyFixtureRoot(),
    publicPort: TEST_PORT,
    token: TEST_TOKEN,
    sessionSecret: TEST_SECRET,
    client: 'none',
    claudeBin: FAKE_CLAUDE,
    nodeEnv: 'test',
    ...overrides,
  };
}

export interface TestApp extends BuiltApp {
  cfg: ServerConfig;
  /** Headers for an authenticated GET. */
  authed: Record<string, string>;
  /** Headers for an authenticated mutating request (Origin and X-CC included). */
  authedWrite: Record<string, string>;
}

export async function makeTestApp(overrides: Partial<ServerConfig> = {}): Promise<TestApp> {
  const cfg = testConfig(overrides);
  const built = await buildApp(cfg);
  const authed = { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${TEST_SECRET}` };
  return {
    ...built,
    cfg,
    authed,
    authedWrite: { ...authed, origin: `http://${TEST_HOST}`, 'x-cc': '1', 'content-type': 'application/json' },
  };
}
