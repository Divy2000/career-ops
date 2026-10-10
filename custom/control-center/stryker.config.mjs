// Mutation testing for the server-side code. `npm run mutate` runs every subtree; pass `-- --mutate '<glob>'` for one.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockClaude } from '../test-support/no-claude.mjs';

// The test runner processes inherit this PATH, so a mutant that drops a fake Claude path cannot reach the real CLI.
process.env.PATH = blockClaude(path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports/bin')).PATH;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.ts' },
  // In place: server code imports ../../../immigration and the repo root, which a copied sandbox would not have.
  inPlace: true,
  // Vitest does not typecheck, and the default would add @ts-nocheck to every file in the package, not just mutated ones.
  disableTypeChecks: false,
  mutate: [
    'server/**/*.ts',
    'supervisor/**/*.ts',
    'shared/**/*.ts',
    '!**/*.d.ts',
    '!web/**',
    '!tests/**',
  ],
  coverageAnalysis: 'perTest',
  // The dry run is the whole related suite in one vitest worker.
  dryRunTimeoutMinutes: 60,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)),
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: { allowColor: false, logTests: false, maxTestsToLog: 0 },
  tempDirName: '.stryker-tmp',
};
