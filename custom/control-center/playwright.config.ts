import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = fileURLToPath(new URL('.', import.meta.url));

// The e2e suite never touches the real data root: the fixture root is copied
// into a fresh temp dir per Playwright invocation and handed to the app.
export const E2E_PORT = 4399;
export const E2E_TOKEN = 'e2e-fixed-token-only-honored-under-NODE_ENV-test';
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-root-'));
// Session policies and revert bookkeeping: outside the data root, never the real ~/Library.
const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-guard-'));
fs.cpSync(path.join(here, 'tests/fixtures/root'), dataRoot, { recursive: true });
// A synthetic Claude Code usage log so the token meter has something to read (never the real ~/.claude).
fs.mkdirSync(path.join(dataRoot, '.claude-projects', 'synthetic'), { recursive: true });
fs.writeFileSync(
  path.join(dataRoot, '.claude-projects', 'synthetic', 'session.jsonl'),
  JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'e2e-1', message: { usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 400 } } }) + '\n',
);

export default defineConfig({
  testDir: path.join(here, 'tests/e2e'),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(here, 'test-results'),
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    cwd: here,
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      CC_PORT: String(E2E_PORT),
      CC_TOKEN: E2E_TOKEN,
      CC_DATA_ROOT: dataRoot,
      CC_GUARD_DIR: guardRoot,
      CC_CLAUDE_BIN: path.join(here, 'tests/fakes/claude.mjs'),
      // Sessions in e2e use the fake CLI's per-mode scenarios and never touch the Keychain.
      FAKE_CLAUDE_SCENARIO_DIR: path.join(here, 'tests/fixtures/scenarios'),
      CC_FAKE_TOKEN: 'e2e-fake-oauth-token',
      // launchctl and plutil are faked (NODE_ENV=test only); plists land in the temp root, never ~/Library.
      CC_FAKE_LAUNCHD: '1',
      CC_LAUNCH_AGENTS_DIR: path.join(dataRoot, '.launch-agents'),
      CC_CLAUDE_PROJECTS_DIR: path.join(dataRoot, '.claude-projects'),
      CC_NO_OPEN: '1',
    },
  },
});
