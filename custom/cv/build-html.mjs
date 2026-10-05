#!/usr/bin/env node
// Build a CV's HTML with the fork template pack (custom/cv/pack). Checks the
// payload against cv.md and the projects library first (no paper under
// Projects, no project from nowhere), turns project descriptions into bullets,
// titles the awards section "Recent Achievements", then hands off to upstream
// build-cv-html.mjs, whose validation, output and exit code pass through.
//
//   node custom/cv/build-html.mjs <payload.json> <output.html>

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload, normalizePayload } from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = getCareerOpsRoot();
const TEMPLATE = path.join(CODE, 'custom', 'cv', 'pack', 'cv-template.fork.html');
const USAGE = 'Usage: node custom/cv/build-html.mjs <payload.json> <output.html>';

function fail(message) {
  process.stderr.write(`build-html failed: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
validateFlags(args, ['--help', '-h'], USAGE);
const operands = args.filter((a) => !a.startsWith('-'));
if (operands.length !== 2) fail(`expected a payload and an output path\n${USAGE}`);
const [input, output] = operands.map((p) => path.resolve(p));

let payload;
try {
  payload = JSON.parse(readFileSync(input, 'utf8'));
} catch (err) {
  fail(`could not read payload ${input}: ${err.message}`);
}

const read = (name) => (existsSync(path.join(DATA, name)) ? readFileSync(path.join(DATA, name), 'utf8') : null);
const { errors, warnings } = checkPayload(payload, { cvText: read('cv.md') ?? '', libraryText: read('article-digest.md') });
for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
if (errors.length) {
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  fail('payload rejected; no HTML written');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cv-build-'));
try {
  const staged = path.join(tmp, 'payload.json');
  writeFileSync(staged, JSON.stringify(normalizePayload(payload)));
  const r = spawnSync(process.execPath, [path.join(CODE, 'build-cv-html.mjs'), staged, output, TEMPLATE], { cwd: CODE, stdio: 'inherit' });
  if (r.error) fail(`could not run build-cv-html.mjs: ${r.error.message}`);
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
