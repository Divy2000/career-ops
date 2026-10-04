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

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitToPages, countPdfPages } from './lib.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATE = path.join(CODE, 'generate-pdf.mjs');
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
    valueFlags: ['--max-pages', '--format', '--report', '--kind'],
  });
  const operands = args.filter((a) => !a.startsWith('-'));
  if (operands.length !== 2) throw new Error(`expected an input HTML and an output PDF\n${USAGE}`);
  const [input, output] = operands.map((p) => path.resolve(p));
  const maxArg = args.find((a) => a.startsWith('--max-pages='));
  const maxPages = maxArg ? Number(maxArg.slice('--max-pages='.length)) : 2;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`invalid --max-pages "${maxArg?.slice(12)}"; use a positive integer`);
  const strict = args.includes('--strict-pages');
  const forwarded = args.filter((a) => PASS_THROUGH.includes(a.split('=')[0]));

  const html = readFileSync(input, 'utf8');
  let lastAttempt = null;
  const render = async (candidate) => {
    writeFileSync(input, candidate);
    const attempt = spawnSync(process.execPath, [GENERATE, input, output, ...forwarded, `--max-pages=${maxPages}`], {
      cwd: CODE, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    if (attempt.error) throw attempt.error;
    if (attempt.status !== 0) throw new RenderFailed(attempt);
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
  print(lastAttempt);
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
