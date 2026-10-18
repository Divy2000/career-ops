#!/usr/bin/env node
// Render a fork-template CV to PDF, tightening the layout until it fits the
// page budget. Each attempt sets html[data-density] (0 = 10pt, 3 = 8.5pt) on a
// draft copy of the HTML and runs upstream generate-pdf.mjs, so every upstream
// check (fact gate, section order, chronology, ATS normalization) still runs;
// the first density whose PDF fits wins, and the HTML keeps it so a re-render of
// that file reproduces the same PDF. A failing upstream check stops at once.
//
//   node custom/cv/render-pdf.mjs <input.html> <output.pdf> [--max-pages=N] [--strict-pages]
//        [--format=letter|a4] [--report=NNN] [--kind=cv|cover] [--allow-reorder]
//        [--allow-nonchronological] [--skip-fact-check]
//
// Without --strict-pages a CV that overflows even the tightest density is a
// warning (the densest PDF is kept), matching generate-pdf.mjs's own default.
//
// The density attempts render a draft HTML beside the input to a draft PDF in a
// scratch folder in the workspace root, with a scratch data/pdf-index.tsv, so the
// real input, output and index stay untouched until a layout is chosen. Only
// then is the chosen HTML written to the input and rendered once more to the
// output, which publishes the PDF for --report. A failed run, including a
// --strict-pages overflow, leaves an already indexed CV exactly as it was. So
// does a run stopped by SIGTERM, SIGINT or SIGHUP: a density render is stopped and
// the drafts are removed; a publishing render is let finish, and the input keeps
// the chosen layout only when that render published it.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fitToPages, countPdfPages } from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { resolveWorkspaceRootFor } from '../../tracker-utils.mjs';
import { validateFlags, flagValue, hasFlag } from '../../lib/cli-flags.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATE = path.join(CODE, 'generate-pdf.mjs');
// Preloaded into each generate-pdf.mjs child: the page loads only the HTML it renders, no other local file (a session's
// HTML may frame or embed file:///Users/me/.ssh/id_rsa, which would print into the PDF).
const LOCAL_FILE_GUARD = pathToFileURL(path.join(CODE, 'custom/control-center/server/claude/local-file-guard.mjs')).href;
const MAX_OUTPUT = 16 * 1024 * 1024;
const VALUE_FLAGS = ['--max-pages', '--format', '--report', '--kind'];
const PASS_THROUGH = ['--format', '--report', '--kind', '--allow-reorder', '--allow-nonchronological', '--skip-fact-check'];
// Preloaded into each generate-pdf.mjs child: logs the path of every temp HTML it writes, before writing it, to the
// file named by TEMP_LOG_ENV, so a stopped render removes its own temp and never one of a concurrent render.
const TEMP_LOG_ENV = 'CAREER_OPS_RENDER_TEMP_LOG';
const TEMP_HOOK = `data:text/javascript,${encodeURIComponent(`
import fsp from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.${TEMP_LOG_ENV};
const writeFile = fsp.writeFile;
if (log) {
  fsp.writeFile = (file, ...rest) => {
    if (typeof file === 'string' && basename(file).startsWith('.career-ops-render-')) appendFileSync(log, file + '\\n');
    return writeFile(file, ...rest);
  };
  syncBuiltinESMExports();
}
`)}`;
const USAGE = `Usage: node custom/cv/render-pdf.mjs <input.html> <output.pdf> [--max-pages=N] [--strict-pages] [${PASS_THROUGH.join('] [')}]`;

// generate-pdf.mjs's strict overflow (enforcePageBudget): the PDF is written, then refused before the index is.
const strictOverflow = (attempt) => attempt.status !== 0 && attempt.stderr.includes('(--strict-pages requested)');

class RenderFailed extends Error {
  constructor(attempt) {
    super(`generate-pdf.mjs exited ${attempt.status}`);
    this.attempt = attempt;
  }
}

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
  // The draft HTML sits beside the input so relative assets resolve the same;
  // the draft PDF keeps the output's file name, from which generate-pdf.mjs infers the kind.
  // The scratch folder sits in the workspace root generate-pdf.mjs confines output to, never beside an output it may
  // refuse (a new folder, or one linked outside); the final render to the output does that check and creates its folder.
  const scratch = mkdtempSync(path.join(resolveWorkspaceRootFor(getCareerOpsRoot()), '.render-pdf-'));
  const draftHtml = path.join(path.dirname(input), `.${path.basename(scratch)}-${path.basename(input)}`);
  const draftPdf = path.join(scratch, path.basename(output));
  // Every render's TMPDIR (Chromium's profile and artifacts) is in the scratch folder too: a render stopped before
  // Playwright could clean up leaves nothing in the system temp folder.
  const childTmp = path.join(scratch, 'tmp');
  mkdirSync(childTmp);
  const childEnv = { ...process.env, TMPDIR: childTmp };
  const draftEnv = { ...childEnv, CAREER_OPS_PDF_INDEX: path.join(scratch, 'pdf-index.tsv') };
  // Messages name the files the user passed, not the drafts.
  const real = (text) => (text ?? '').replaceAll(draftHtml, input).replaceAll(path.basename(draftHtml), path.basename(input))
    .replaceAll(draftPdf, output);
  const print = (attempt) => {
    process.stdout.write(real(attempt.stdout));
    process.stderr.write(real(attempt.stderr));
  };
  // A signal stops a density render in progress and removes the drafts. The final render that publishes the chosen
  // layout is let finish instead, so the input and the PDF agree: the input keeps the layout when it was published and
  // gets its own back when it was not (that render stopped by the same signal, as a process-group cancel does). The
  // renders run asynchronously so the handler can run while one is in progress; once stopping, no render result is
  // acted on and no new render starts.
  let running = null;
  let lastChild = null;
  let stopping = false;
  let restoreInput = false;
  // The output as it was before the final render. generate-pdf.mjs writes the PDF and then its index row in one
  // synchronous run, so a changed PDF means the chosen layout was published, even when that render then exited non-zero
  // (stopped while it closed its browser): the input must keep the layout the PDF shows.
  const outputBytes = () => {
    try {
      return statSync(output).isFile() ? readFileSync(output) : null;
    } catch {
      return null;
    }
  };
  let outputBefore = null;
  // A changed PDF whose page tree reads, so not one cut short by a stop in the middle of the write.
  const publishedOutput = () => {
    const now = outputBytes();
    if (now === null || (outputBefore !== null && now.equals(outputBefore))) return false;
    try {
      countPdfPages(now);
      return true;
    } catch {
      return false;
    }
  };
  // After the final render: the input keeps the chosen layout only when the PDF it shows was published. Otherwise the
  // input gets its layout back, and so does the output when the render left a PDF it never indexed: a strict overflow
  // writes its over-budget PDF and then refuses it, and a stop in the middle of the write leaves a truncated one.
  const settlePublish = (result) => {
    if (result?.status === 0 || (!(result && strictOverflow(result)) && publishedOutput())) return;
    writeFileSync(input, html);
    const now = outputBytes();
    if (now === null || (outputBefore !== null && now.equals(outputBefore))) return;
    if (outputBefore === null) rmSync(output, { force: true });
    else writeFileSync(output, outputBefore);
  };
  const removeDrafts = () => {
    rmSync(draftHtml, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    // A render ends at its 'close', not its exit: the temp cleanup and the result come only then, after its pipes close.
    if (running) {
      const closed = new Promise((resolve) => running.once('close', resolve));
      if (!restoreInput && running.exitCode === null && running.signalCode === null) running.kill(signal);
      await closed;
    }
    removeDrafts();
    if (restoreInput) settlePublish(lastChild?.result ?? null);
    process.exit(128 + os.constants.signals[signal]);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, onSignal);
  // The scratch folder lives until the last render ends, however the run ends.
  process.on('exit', removeDrafts);
  // generate-pdf.mjs writes .career-ops-render-<uuid>.html, a full copy of the CV, beside the HTML it renders, and
  // removes it in a finally that a stop can skip (a second SIGINT makes Playwright exit at once). Other renders write
  // theirs in the same folder at any time, so each child names its own: TEMP_HOOK logs every such path to that child's
  // log before writing it, and only the paths in the log are removed.
  let renders = 0;
  const ownTemps = (log) => {
    try {
      return readFileSync(log, 'utf8').split('\n').filter((f) => path.basename(f).startsWith('.career-ops-render-'));
    } catch {
      return [];
    }
  };
  const generate = (from, to, extra, env = process.env) => new Promise((resolve, reject) => {
    if (stopping) return;
    const tempLog = path.join(scratch, `temps-${++renders}.log`);
    const child = spawn(process.execPath, ['--import', LOCAL_FILE_GUARD, '--import', TEMP_HOOK, GENERATE, from, to, ...forwarded, `--max-pages=${maxPages}`, ...extra], {
      cwd: CODE, env: { ...env, [TEMP_LOG_ENV]: tempLog }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    running = child;
    lastChild = child;
    let stdout = '';
    let stderr = '';
    // Bounded like the spawnSync maxBuffer it replaced: a child printing without end is stopped, not buffered.
    let flooded = false;
    const collect = (append) => (d) => {
      if (flooded) return;
      append(d);
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        flooded = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.setEncoding('utf8').on('data', collect((d) => { stdout += d; }));
    child.stderr.setEncoding('utf8').on('data', collect((d) => { stderr += d; }));
    child.on('error', (err) => { if (!stopping) reject(err); });
    child.on('close', (status, signal) => {
      if (running === child) running = null;
      // generate-pdf.mjs removes its own temp HTML in a finally on a clean exit, but a killed child can exit without
      // running it (a group signal Playwright swallows), so clean up when the child was killed (its close signal) or
      // when this stop killed a density render. It is NOT killed while the final publish render runs (it is let finish
      // so the input and the PDF agree), so cleaning then would only delete a concurrent render's live temp.
      if (signal || (stopping && !restoreInput)) for (const f of ownTemps(tempLog)) rmSync(f, { force: true });
      child.result = { status, signal, stdout, stderr };
      if (stopping) return;
      if (flooded) reject(new Error(`generate-pdf.mjs printed more than ${MAX_OUTPUT / 1024 / 1024} MiB of output; stopped it`));
      else resolve(child.result);
    });
  });
  const render = async (candidate) => {
    writeFileSync(draftHtml, candidate);
    const attempt = await generate(draftHtml, draftPdf, ['--strict-pages'], draftEnv);
    if (attempt.status !== 0 && !strictOverflow(attempt)) throw new RenderFailed(attempt);
    return { pages: countPdfPages(readFileSync(draftPdf)) };
  };

  let result;
  try {
    result = await fitToPages({ html, maxPages, render });
  } catch (err) {
    if (err instanceof RenderFailed) {
      print(err.attempt);
      return err.attempt.status || 1;
    }
    throw err;
  } finally {
    rmSync(draftHtml, { force: true });
  }
  let published = null;
  if (result.fits || !strict) {
    // Publish the chosen layout: the input keeps its density and this render indexes the PDF.
    outputBefore = outputBytes();
    restoreInput = true;
    writeFileSync(input, result.html);
    try {
      published = await generate(input, output, result.fits ? ['--strict-pages'] : [], childEnv);
    } finally {
      // Unless the chosen layout was published, the input gets back the layout it had.
      settlePublish(published);
      restoreInput = false;
    }
    if (published.status !== 0) {
      print(published);
      return published.status || 1;
    }
    print(published);
  }
  const tried = result.attempts.map((a) => `d${a.density}=${a.pages}`).join(', ');
  const pages = `${result.pages} page${result.pages === 1 ? '' : 's'}`;
  if (result.fits) {
    process.stdout.write(`fit: density ${result.density}, ${pages} (budget ${maxPages}; tried ${tried})\n`);
    return 0;
  }
  const message = `CV does not fit ${maxPages} page${maxPages === 1 ? '' : 's'} even at the tightest density (${pages}; tried ${tried}). Drop the lowest-ranked project first, then older roles' bullets.`;
  if (strict) {
    process.stderr.write(`render-pdf failed: ${message}\n`);
    return 1;
  }
  process.stderr.write(`warning: ${message} Kept the density ${result.density} PDF; use --strict-pages to fail instead.\n`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  process.stderr.write(`render-pdf failed: ${err.message}\n`);
  process.exit(1);
});
