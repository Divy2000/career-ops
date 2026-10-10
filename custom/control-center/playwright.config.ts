import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { e2eTempParent, writeDemoTutorials, writeEmptyRoot, writeStressRoot } from './tests/e2e/roots.js';
import { dropCareerOpsOverrides } from './tests/helpers/env.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// The app servers get process.env too: a CAREER_OPS_TRACKER or _PIPELINE from the shell would outrank their data root.
dropCareerOpsOverrides(process.env);

// The e2e suite never touches the real data root: the fixture root is copied
// into a fresh temp dir per Playwright invocation and handed to the app.
// CC_E2E_PORT_BASE moves all three e2e servers (base, base-1, base-2) when another process already holds these ports.
const PORT_BASE = Number(process.env.CC_E2E_PORT_BASE ?? 4399);
export const E2E_PORT = PORT_BASE;
export const E2E_TOKEN = 'e2e-fixed-token-only-honored-under-NODE_ENV-test';
// Every root lives under one parent that the Playwright process removes when it exits; workers re-import
// this file and only compute the same paths.
const tmp = e2eTempParent();
const dataRoot = path.join(tmp.dir, 'root');
// Session policies and revert bookkeeping: outside the data root, never the real ~/Library.
const guardRoot = path.join(tmp.dir, 'guard');

// Two more apps on their own ports: a first launch with an empty tracker, and a root with real-world sized rows for layout checks.
export const EMPTY_PORT = PORT_BASE - 1;
export const STRESS_PORT = PORT_BASE - 2;
const FIXTURE_ROOT = path.join(here, 'tests/fixtures/root');
export const EMPTY_ROOT = path.join(tmp.dir, 'empty');
const stressRoot = path.join(tmp.dir, 'stress');
if (tmp.cleanup) {
  process.on('exit', tmp.cleanup);
  fs.cpSync(FIXTURE_ROOT, dataRoot, { recursive: true });
  writeDemoTutorials(dataRoot, { padding: true });
  for (const d of ['guard', 'guard-empty', 'guard-stress', 'empty', 'stress']) fs.mkdirSync(path.join(tmp.dir, d));
  writeEmptyRoot(EMPTY_ROOT, FIXTURE_ROOT);
  writeStressRoot(stressRoot, FIXTURE_ROOT);
  // A synthetic Claude Code usage log so the token meter has something to read (never the real ~/.claude).
  fs.mkdirSync(path.join(dataRoot, '.claude-projects', 'synthetic'), { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, '.claude-projects', 'synthetic', 'session.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'e2e-1', message: { usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 400 } } }) + '\n',
  );
}

function serverFor(port: number, root: string, guard: string) {
  return {
    command: 'npm start',
    cwd: here,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      CC_PORT: String(port),
      CC_TOKEN: E2E_TOKEN,
      CC_DATA_ROOT: root,
      CC_GUARD_DIR: guard,
      CC_CLAUDE_BIN: path.join(here, 'tests/fakes/claude.mjs'),
      // Sessions in e2e use the fake CLI's per-mode scenarios and never touch the Keychain.
      FAKE_CLAUDE_SCENARIO_DIR: path.join(here, 'tests/fixtures/scenarios'),
      CC_FAKE_TOKEN: 'e2e-fake-oauth-token',
      // launchctl and plutil are faked (NODE_ENV=test only); plists land in the temp root, never ~/Library.
      CC_FAKE_LAUNCHD: '1',
      CC_LAUNCH_AGENTS_DIR: path.join(root, '.launch-agents'),
      CC_CLAUDE_PROJECTS_DIR: path.join(root, '.claude-projects'),
      CC_NO_OPEN: '1',
      // The daily-job probe never looks at host processes, so a real run-daily.sh cannot put its banner into the suite (NODE_ENV=test only).
      CC_FAKE_DAILY: 'idle',
      // The sponsor lookup answers from a synthetic employer table, never the real DOL index (NODE_ENV=test only).
      CC_H1B_CHECK_SCRIPT: path.join(here, 'tests/fakes/h1b-check.mjs'),
      // Plugin discovery never scans the developer's real plugins.local checkout; an empty (absent) temp dir stands in (NODE_ENV=test only).
      CC_PLUGINS_LOCAL_DIR: path.join(tmp.dir, 'plugins-local'),
      // The preflight checks a pinned host, not this machine's platform or its Claude Code MDM settings (NODE_ENV=test only).
      CC_FAKE_PLATFORM: 'darwin',
      CC_FAKE_MANAGED_SETTINGS_DIR: path.join(tmp.dir, 'managed-settings'),
    },
  };
}

export default defineConfig({
  testDir: path.join(here, 'tests/e2e'),
  timeout: 60_000,
  fullyParallel: false,
  // One data root for every spec: global-setup.ts refuses any other worker count.
  workers: 1,
  globalSetup: path.join(here, 'tests/e2e/global-setup.ts'),
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(here, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'main', testIgnore: [/empty\.spec\.ts/, /layout\.spec\.ts/] },
    { name: 'empty', testMatch: /empty\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${EMPTY_PORT}` } },
    { name: 'layout', testMatch: /layout\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${STRESS_PORT}` } },
  ],
  webServer: [
    serverFor(E2E_PORT, dataRoot, guardRoot),
    serverFor(EMPTY_PORT, EMPTY_ROOT, path.join(tmp.dir, 'guard-empty')),
    serverFor(STRESS_PORT, stressRoot, path.join(tmp.dir, 'guard-stress')),
  ],
});
