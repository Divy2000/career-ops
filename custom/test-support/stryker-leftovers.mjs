#!/usr/bin/env node
// Stryker mutates in place and restores the files when it ends; a run that is killed leaves them instrumented.
// Run before a mutation run so it never instruments, tests or reports on already-instrumented code.
// Usage: node custom/test-support/stryker-leftovers.mjs <folder> [<folder> ...]  (exit 1 lists the files)
import fs from 'node:fs';
import path from 'node:path';

const MARKER = /\bfunction stryNS_[0-9a-f]+\(/;
const SKIP = new Set(['node_modules', '.stryker-tmp', 'reports', '.git']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function* sources(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(p);
    else if (entry.isFile() && SOURCE.test(entry.name)) yield p;
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node custom/test-support/stryker-leftovers.mjs <folder> [...]');
  process.exit(2);
}
const found = dirs.flatMap((d) => [...sources(d)].filter((f) => MARKER.test(fs.readFileSync(f, 'utf8'))));
if (found.length > 0) {
  console.error(`These files carry Stryker instrumentation: another run is still going, or a killed one left them. Wait for it, or restore them (git checkout -- <file>), before mutating:\n${found.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
