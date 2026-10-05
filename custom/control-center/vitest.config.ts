import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Local-time assertions only mean something away from UTC, where the UTC slice of an ISO string equals local time.
process.env.TZ = 'America/Los_Angeles';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': `${here}shared`,
      '@web': `${here}web`,
    },
  },
  test: {
    env: { NODE_ENV: 'test', TZ: 'America/Los_Angeles' },
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-tmp.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['tests/web/**/*.test.tsx', 'tests/web/**/*.test.ts'],
        },
      },
    ],
  },
});
