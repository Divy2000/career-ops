#!/usr/bin/env node
// Validates the Markdown inputs of install.sh before anything is written.
// Usage: node validate-md.mjs [--resume f.md] [--docs a.md b.md ...] [--cv <target cv.md>]
// Prints JSON { ok, errors, warnings } on stdout, human messages on stderr; exit 0 ok, 2 rejected.
import { parseFlags, validateInputs } from './lib.mjs';

let flags;
try {
  flags = parseFlags(process.argv.slice(2), ['--docs']);
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(2);
}
const result = validateInputs({
  resume: typeof flags.get('--resume') === 'string' ? flags.get('--resume') : undefined,
  docs: flags.get('--docs') ?? [],
  targetCv: typeof flags.get('--cv') === 'string' ? flags.get('--cv') : undefined,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
for (const e of result.errors) process.stderr.write(`error: ${e}\n`);
for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
process.exit(result.ok ? 0 : 2);
