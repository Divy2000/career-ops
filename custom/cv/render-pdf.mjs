#!/usr/bin/env node
// Render a fork-template CV to PDF, tightening the layout until it fits the
// page budget. Each attempt sets html[data-density] (0 = 10pt, 3 = 8.5pt) in
// the HTML file and runs upstream generate-pdf.mjs, so every upstream check
// (fact gate, section order, chronology, ATS normalization) still runs; the
// first density whose PDF fits wins, and the HTML keeps it so a re-render of
// that file reproduces the same PDF. A failing upstream check stops at once.
//
//   node custom/cv/render-pdf.mjs <input.html> <output.pdf> [--max-pages=N] [--strict-pages]
//        [--format=letter|a4] [--report=NNN] [--kind=cv|cover] [--allow-reorder]
//        [--allow-nonchronological] [--skip-fact-check]
//
// Without --strict-pages a CV that overflows even the tightest density is a
// warning (the densest PDF is kept), matching generate-pdf.mjs's own default.
//
// Each density attempt runs generate-pdf.mjs with --strict-pages, so an attempt
// that overflows leaves its PDF on disk to count but publishes nothing to
// data/pdf-index.tsv; only the attempt that fits, or (without --strict-pages)
// one more render of the densest layout, indexes the PDF for --report.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitToPages, countPdfPages } from './lib.mjs';
import { validateFlags, flagValue, hasFlag } from '../../lib/cli-flags.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATE = path.join(CODE, 'generate-pdf.mjs');
const VALUE_FLAGS = ['--max-pages', '--format', '--report', '--kind'];
const PASS_THROUGH = ['--format', '--report', '--kind', '--allow-reorder', '--allow-nonchronological', '--skip-fact-check'];
const USAGE = `Usage: node custom/cv/render-pdf.mjs <input.html> <output.pdf> [--max-pages=N] [--strict-pages] [${PASS_THROUGH.join('] [')}]`;

class RenderFailed extends Error {
  constructor(attempt) {
    super(`generate-pdf.mjs exited ${attempt.status}`);
    this.attempt = attempt;
  }
}

const print = (attempt) => {
  process.stdout.write(attempt.stdout ?? '');
  process.stderr.write(attempt.stderr ?? '');
};

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--max-pages', '--strict-pages', ...PASS_THROUGH, '--help', '-h'], USAGE, {
    valueFlags: VALUE_FLAGS,
    requireOperand: true,
  });
  // A value flag may be written `--flag value`; that value is not a file operand.
  const values = new Set(args.flatMap((a, i) => (VALUE_FLAGS.includes(a) ? [i + 1] : [])));
  const operands = args.filter((a, i) => !a.startsWith('-') && !values.has(i));
  if (operands.length !== 2) throw new Error(`expected an input HTML and an output PDF\n${USAGE}`);
  const [input, output] = operands.map((p) => path.resolve(p));
  const maxRaw = flagValue(args, '--max-pages');
  const maxPages = maxRaw === undefined ? 2 : Number(maxRaw);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`invalid --max-pages "${maxRaw}"; use a positive integer`);
  const strict = args.includes('--strict-pages');
  // generate-pdf.mjs reads only the --flag=value form.
  const forwarded = PASS_THROUGH.filter((f) => hasFlag(args, f))
    .map((f) => (VALUE_FLAGS.includes(f) ? `${f}=${flagValue(args, f)}` : f));

  const html = readFileSync(input, 'utf8');
  let lastAttempt = null;
  const generate = (extra) => {
    const attempt = spawnSync(process.execPath, [GENERATE, input, output, ...forwarded, `--max-pages=${maxPages}`, ...extra], {
      cwd: CODE, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (attempt.error) throw attempt.error;
    return attempt;
  };
  const render = async (candidate) => {
    writeFileSync(input, candidate);
    const attempt = generate(['--strict-pages']);
    // generate-pdf.mjs's strict overflow (enforcePageBudget): the PDF is written, nothing else is.
    const overflowed = attempt.status !== 0 && attempt.stderr.includes('(--strict-pages requested)');
    if (attempt.status !== 0 && !overflowed) throw new RenderFailed(attempt);
    lastAttempt = attempt;
    return { pages: countPdfPages(readFileSync(output)) };
  };

  let result;
  try {
    result = await fitToPages({ html, maxPages, render });
  } catch (err) {
    if (err instanceof RenderFailed) {
      print(err.attempt);
      process.exit(err.attempt.status || 1);
    }
    throw err;
  }
  if (!result.fits && !strict) {
    // The densest layout is what the input holds after the last attempt; render it once more to publish it.
    lastAttempt = generate([]);
    if (lastAttempt.status !== 0) {
      print(lastAttempt);
      process.exit(lastAttempt.status || 1);
    }
  }
  if (result.fits || !strict) print(lastAttempt);
  const tried = result.attempts.map((a) => `d${a.density}=${a.pages}`).join(', ');
  const pages = `${result.pages} page${result.pages === 1 ? '' : 's'}`;
  if (result.fits) {
    process.stdout.write(`fit: density ${result.density}, ${pages} (budget ${maxPages}; tried ${tried})\n`);
    return;
  }
  const message = `CV does not fit ${maxPages} page${maxPages === 1 ? '' : 's'} even at the tightest density (${pages}; tried ${tried}). Drop the lowest-ranked project first, then older roles' bullets.`;
  if (strict) {
    process.stderr.write(`render-pdf failed: ${message}\n`);
    process.exit(1);
  }
  process.stderr.write(`warning: ${message} Kept the density ${result.density} PDF; use --strict-pages to fail instead.\n`);
}

main().catch((err) => {
  process.stderr.write(`render-pdf failed: ${err.message}\n`);
  process.exit(1);
});
