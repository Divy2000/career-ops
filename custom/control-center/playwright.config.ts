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
fs.cpSync(path.join(here, 'tests/fixtures/root'), dataRoot, { recursive: true });

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
      CC_CLAUDE_BIN: path.join(here, 'tests/fakes/claude.mjs'),
      // Sessions in e2e use the fake CLI's per-mode scenarios and never touch the Keychain.
      CC_FAKE_SCENARIO_DIR: path.join(here, 'tests/fixtures/scenarios'),
      CC_FAKE_TOKEN: 'e2e-fake-oauth-token',
      CC_NO_OPEN: '1',
    },
  },
});
