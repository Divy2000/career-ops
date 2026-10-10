#!/usr/bin/env node
// Mutation testing for one custom/<package> node:test suite: Stryker's command runner runs `node --test` on the
// package's specs once per mutant, in place, so spawned children see the mutant too (they inherit its env switch).
// Usage: node custom/test-support/mutate.mjs <package> [stryker options, e.g. --mutate lib.mjs --force]
// Stryker comes from custom/control-center's devDependencies; results go to custom/test-support/reports/<package>/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const custom = path.dirname(here);
const stryker = path.join(custom, 'control-center/node_modules/@stryker-mutator/core/bin/stryker.js');

function fail(msg) {
  console.error(`mutate: ${msg}`);
  process.exit(2);
}

const [pkg, ...rest] = process.argv.slice(2);
if (!pkg || pkg.startsWith('-')) fail('usage: node custom/test-support/mutate.mjs <package> [stryker options]');
const pkgDir = path.join(custom, pkg);
const testsDir = path.join(pkgDir, 'tests');
const specs = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.mjs')).sort() : [];
if (path.dirname(pkgDir) !== custom || specs.length === 0) fail(`custom/${pkg} has no tests/*.spec.mjs`);
if (!fs.existsSync(stryker)) fail('Stryker is not installed: run `npm ci` in custom/control-center first');

const guard = spawnSync(process.execPath, [path.join(here, 'stryker-leftovers.mjs'), pkgDir], { stdio: 'inherit' });
if (guard.status !== 0) process.exit(guard.status ?? 1);

const out = path.join(here, 'reports', pkg);
fs.mkdirSync(out, { recursive: true });
const config = {
  testRunner: 'command',
  commandRunner: { command: `node --test ${specs.map((f) => `tests/${f}`).join(' ')}` },
  // The specs import ../../lib and the repo root, which a copied sandbox would not have.
  inPlace: true,
  disableTypeChecks: false,
  mutate: ['**/*.mjs', '!tests/**', '!node_modules/**'],
  coverageAnalysis: 'off',
  incremental: true,
  incrementalFile: path.join(out, 'stryker-incremental.json'),
  concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)),
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: path.join(out, 'mutation.html') },
  jsonReporter: { fileName: path.join(out, 'mutation.json') },
  clearTextReporter: { allowColor: false, logTests: false, maxTestsToLog: 0 },
  tempDirName: path.join(out, '.stryker-tmp'),
};
const configFile = path.join(out, 'stryker.config.json');
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

const run = spawnSync(process.execPath, [stryker, 'run', configFile, ...rest], { cwd: pkgDir, stdio: 'inherit' });
if (run.error) fail(run.error.message);
process.exit(run.status ?? 1);
