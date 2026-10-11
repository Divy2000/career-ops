#!/usr/bin/env node
// Compile a .tex CV to PDF without giving the TeX engine the rest of the disk. A .tex can read any file the engine can
// (\verbatiminput{/abs/path}, \input, a package file dropped beside it) and print it into the PDF and log, so the engine
// here sees only a copy of the .tex in a fresh temp folder and runs under macOS sandbox-exec: no reads or writes under
// the home folder, the code checkout, the data root, /Users, /Volumes or the temp folders, except the temp folder itself
// and the engine's own per-user TeX trees and caches. Only the PDF comes back, to a path under the data root's output/.
//
//   node custom/cv/compile-latex.mjs <input.tex> <output.pdf> [--compile-only]
//
// Engine choice, template validation and engine flags are generate-latex.mjs's (tectonic first, then pdflatex);
// --compile-only skips the career-ops template checks, as there. Refuses to run where sandbox-exec is not available.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLatexEngine, validateLatexContent } from '../../generate-latex.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { resolveWorkspaceRootFor } from '../../tracker-utils.mjs';
import { validateFlags } from '../../lib/cli-flags.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const TIMEOUT_MS = 120_000;
const JOB = 'cv';
const USAGE = 'Usage: node custom/cv/compile-latex.mjs <input.tex> <output.pdf> [--compile-only]';

// Later rules win. Reads and writes are denied in every folder that holds user files, then given back for the work
// folder and the engine's per-user trees and caches; writes are denied everywhere else too. Network stays open for
// tectonic's bundle downloads; neither engine can reach it from the document with shell escape off.
const PROFILE = `(version 1)
(allow default)
(deny file-read* file-write*
  (subpath (param "HOME")) (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders")
  (subpath (param "CODE")) (subpath (param "DATA")) (subpath (param "WORKSPACE")))
(deny file-write*)
(allow file-write* (subpath (param "WORK")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))
(allow file-read* file-write* (subpath (param "WORK")))`;

const NOT_FOUND_HINT = 'Files next to the .tex are not available here: only the .tex itself is compiled, so inline its \\input sections and local packages into it, or compile a multi-file CV on Overleaf.';

class Refused extends Error {}

const real = (p) => fs.realpathSync.native(p);
const inside = (dir, target) => {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The executable `name` on PATH, as generate-latex.mjs's execFileSync would find it. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* not here */ }
  }
  return null;
}

/** Per-user folders the engine reads (and, for caches, writes) under the home folder, which the profile otherwise denies. */
function engineTrees(engine, bin) {
  const home = os.homedir();
  if (engine === 'tectonic') {
    const cache = process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, 'Tectonic') : null;
    return {
      // The binary's own folder, for a tectonic installed under the home folder.
      read: [path.join(home, 'Library', 'Fonts'), path.dirname(real(bin))],
      write: [path.join(home, 'Library', 'Caches', 'Tectonic'), path.join(home, 'Library', 'Caches', 'fontconfig'), path.join(home, '.cache', 'Tectonic'), cache].filter(Boolean),
    };
  }
  const kpsewhich = path.join(path.dirname(bin), 'kpsewhich');
  const value = (name) => {
    const r = spawnSync(kpsewhich, [`-var-value=${name}`], { encoding: 'utf8' });
    const v = r.status === 0 ? r.stdout.trim() : '';
    return v && path.isAbsolute(v) ? v : null;
  };
  // SELFAUTOPARENT and TEXMFDIST: the distribution itself, under the home folder for a TinyTeX or user-local install.
  return {
    read: [value('SELFAUTOPARENT'), value('TEXMFDIST'), value('TEXMFHOME'), value('TEXMFCONFIG')].filter(Boolean),
    write: [value('TEXMFVAR')].filter(Boolean),
  };
}

/** The sandbox profile with every per-user tree the engine needs given back, and the -D parameters it reads. */
export function sandboxArgs(work, engine, bin, workspace) {
  const trees = engineTrees(engine, bin);
  // subpath rules match real paths, so a root reached through a link is denied by the folder it names.
  const canonical = (p) => (fs.existsSync(p) ? real(p) : p);
  const params = { HOME: canonical(os.homedir()), CODE: canonical(CODE), DATA: canonical(getCareerOpsRoot()), WORKSPACE: canonical(workspace), WORK: work };
  const extra = [];
  // A tree that is or holds the home folder or a root (a tectonic binary sitting directly in ~) would give it all back.
  const narrow = (dir) => ![params.HOME, params.CODE, params.DATA, params.WORKSPACE].some((p) => inside(canonical(dir), p));
  const add = (kind, list) => list.filter(narrow).forEach((dir, i) => {
    const key = `${kind.toUpperCase()}_${i}`;
    params[key] = canonical(dir);
    extra.push(`(allow ${kind === 'write' ? 'file-read* file-write*' : 'file-read*'} (subpath (param "${key}")))`);
  });
  add('read', trees.read);
  add('write', trees.write);
  return [...Object.entries(params).flatMap(([k, v]) => ['-D', `${k}=${v}`]), '-p', [PROFILE, ...extra].join('\n')];
}

/** The output path, refused unless it is a .pdf under the data root's output/ folder, canonical path included. */
function checkOutput(given, workspace) {
  const output = path.resolve(given);
  const outputRoot = path.join(workspace, 'output');
  if (path.extname(output).toLowerCase() !== '.pdf') throw new Refused(`the output must be a .pdf file (${given})`);
  if (!inside(outputRoot, output) || output === outputRoot) throw new Refused(`the output must be under ${outputRoot} (${given})`);
  fs.mkdirSync(outputRoot, { recursive: true });
  let existing = path.dirname(output);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!inside(real(outputRoot), real(existing))) throw new Refused(`the output folder resolves outside ${outputRoot} (${given})`);
  // lstat, not exists: a dangling link reads as missing and copyFileSync would write through it.
  if (fs.lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refused(`the output is a symbolic link (${given})`);
  return output;
}

/**
 * The canonical input path, refused unless it is a regular .tex file inside the data root or the code checkout. The
 * file it names is the one read, so a link named .tex cannot stand in for another file.
 */
function checkInput(given, workspace) {
  const input = path.resolve(given);
  let canonical;
  try {
    canonical = real(input);
  } catch (err) {
    throw new Refused(`cannot read ${given}: ${err.code ?? err.message}`);
  }
  if (path.extname(input).toLowerCase() !== '.tex' || path.extname(canonical).toLowerCase() !== '.tex') throw new Refused(`the input must be a .tex file (${given})`);
  if (!fs.statSync(canonical).isFile()) throw new Refused(`the input is not a regular file (${given})`);
  if (![workspace, getCareerOpsRoot(), CODE].some((root) => fs.existsSync(root) && inside(real(root), canonical))) {
    throw new Refused(`the input must be inside the data root or the code checkout (${given})`);
  }
  return canonical;
}

/** Runs one engine pass in the sandbox; a signal to this process stops it. */
function runPass(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => { if (out.length < 1024 * 1024) out += d; };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    const stop = () => child.kill('SIGKILL');
    process.once('compile-latex:stop', stop);
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 1, out: `${out}${err.message}` }); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      process.removeListener('compile-latex:stop', stop);
      resolve({ status: status ?? 1, out: signal ? `${out}\nstopped by ${signal}` : out });
    });
  });
}

/** The engine's error lines from its log, or its output when there is no log (as generate-latex.mjs reports them). */
function errorSummary(work, out, input) {
  let text = out;
  try {
    const lines = fs.readFileSync(path.join(work, `${JOB}.log`), 'utf8').split('\n');
    const errors = lines.flatMap((l, i) => (l.startsWith('!') ? [l, ...lines.slice(i + 1, i + 3).filter((n) => /^l\.\d+/.test(n))] : []));
    if (errors.length) text = errors.join('\n');
  } catch { /* no log */ }
  const summary = text.replaceAll(path.join(work, `${JOB}.tex`), input).replaceAll(work, path.dirname(input)).trim() || 'the engine failed without a message';
  return /not found/i.test(summary) ? `${summary}\n${NOT_FOUND_HINT}` : summary;
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, ['--compile-only', '--help', '-h'], USAGE);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const compileOnly = args.includes('--compile-only');
  const operands = args.filter((a) => a !== '--compile-only');
  if (operands.length !== 2) throw new Refused(`expected an input .tex and an output .pdf\n${USAGE}`);
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC)) {
    throw new Refused(`${SANDBOX_EXEC} is not available, so the .tex cannot be compiled without access to the rest of the disk; compile it on Overleaf or with generate-latex.mjs outside a session`);
  }
  const workspace = resolveWorkspaceRootFor(getCareerOpsRoot());
  const input = checkInput(operands[0], workspace);
  const output = checkOutput(operands[1], workspace);

  const content = fs.readFileSync(input, 'utf8');
  const engine = resolveLatexEngine();
  const { issues, counts } = validateLatexContent(content, compileOnly, engine);
  const report = { file: path.basename(input), path: input, counts, issues, valid: issues.length === 0, compileOnly };
  if (!report.valid) return finish(report, 1);
  if (!engine) return finish({ ...report, compiled: false, compileError: 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.' }, 1);
  report.engine = engine;
  const bin = onPath(engine);
  if (!bin) return finish({ ...report, compiled: false, compileError: `${engine} answered --version but is not an executable on PATH` }, 1);

  const work = real(fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-latex-')));
  const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
  process.on('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => {
      process.emit('compile-latex:stop');
      cleanup();
      process.exit(128 + os.constants.signals[signal]);
    });
  }
  try {
    // tectonic has no \pdfgentounicode or glyphtounicode, so generate-latex.mjs drops them for it.
    const source = engine === 'tectonic'
      ? content.replace(/\\pdfgentounicode\s*=\s*\d+[^\n]*\n?/g, '').replace(/\\input\{glyphtounicode\}[^\n]*\n?/g, '')
      : content;
    fs.writeFileSync(path.join(work, `${JOB}.tex`), source);
    const sandbox = sandboxArgs(work, engine, bin, workspace);
    const env = { ...process.env, openin_any: 'p', openout_any: 'p', TEXMFOUTPUT: work };
    const engineArgs = engine === 'tectonic'
      ? ['--untrusted', '--outdir', work, `${JOB}.tex`]
      : ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `-output-directory=${work}`, `${JOB}.tex`];
    const passes = engine === 'tectonic' ? 1 : 2;
    for (let i = 0; i < passes; i++) {
      const r = await runPass(SANDBOX_EXEC, [...sandbox, bin, ...engineArgs], { cwd: work, env });
      if (r.status !== 0) return finish({ ...report, compiled: false, compileError: errorSummary(work, r.out, input) }, 1);
    }
    const pdf = path.join(work, `${JOB}.pdf`);
    if (!fs.existsSync(pdf)) return finish({ ...report, compiled: false, compileError: 'the engine exited 0 but wrote no PDF' }, 1);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(pdf, output);
    return finish({ ...report, compiled: true, pdf: { path: output, sizeKB: Number((fs.statSync(output).size / 1024).toFixed(1)) } }, 0);
  } finally {
    cleanup();
  }
}

function finish(report, code) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.compileError) process.stderr.write(`compile-latex failed: ${report.compileError}\n`);
  return code;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`compile-latex refused: ${err.message}\n`);
    process.exit(1);
  });
}
