import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, REPO, dataRoot, envFor } from './helpers.mjs';
import { tempDir } from '../../test-support/tmp.mjs';

const COMPILE = path.join(HERE, '..', 'compile-latex.mjs');
const SECRET = 'R23-SECRET-7f3a9c';

// The TeX engines the wrapper looks for on PATH; MacTeX installs them in /Library/TeX/texbin, which a shell may not have.
const searchPath = [process.env.PATH, '/Library/TeX/texbin'].filter(Boolean).join(path.delimiter);
const engine = ['tectonic', 'pdflatex'].find((bin) => spawnSync(bin, ['--version'], { env: { ...process.env, PATH: searchPath } }).status === 0);
const pdftotext = spawnSync('pdftotext', ['-v']).error ? null : 'pdftotext';
const noEngine = !engine && 'no TeX engine (tectonic or pdflatex) installed';
const noSandbox = process.platform !== 'darwin' && 'sandbox-exec is macOS only';
const skip = noEngine || noSandbox || (!pdftotext && 'pdftotext not installed');

const run = (root, args) => spawnSync(process.execPath, [COMPILE, ...args], { cwd: REPO, env: { ...envFor(root), PATH: searchPath }, encoding: 'utf8', timeout: 180_000 });
const pdfText = (file) => spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout;
const secretFile = () => {
  const file = path.join(fs.realpathSync(tempDir('latex-secret-')), 'id_rsa');
  fs.writeFileSync(file, `${SECRET}\n`);
  return file;
};
const doc = (body, preamble = '') => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
// Whatever the run left behind: the PDF (when one was written) and everything it printed.
const leaked = (r, pdf) => (fs.existsSync(pdf) && pdfText(pdf).includes(SECRET)) || `${r.stdout}${r.stderr}`.includes(SECRET);
// The wrapper ran the engine and reports a failed compile, rather than failing before it (a missing script would pass the leak check).
const compileFailed = (r) => assert.equal(JSON.parse(r.stdout).compiled, false, `${r.stdout}\n${r.stderr}`);

test('given a .tex that \\verbatiminputs a file outside its temp folder, when compiled, then the file never reaches the PDF or the output', { skip }, () => {
  const root = dataRoot();
  const tex = path.join(root, 'output', 'x.tex');
  const pdf = path.join(root, 'output', 'x.pdf');
  fs.writeFileSync(tex, doc(`\\verbatiminput{${secretFile()}}`, '\\usepackage{verbatim}\n'));
  const r = run(root, [tex, pdf, '--compile-only']);
  assert.equal(leaked(r, pdf), false, `${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.status, 0, 'a refused read fails the compile');
  compileFailed(r);
});

test('given a .tex that \\inputs a file under the data root, when compiled, then the file never reaches the PDF or the output', { skip }, () => {
  const root = dataRoot();
  fs.writeFileSync(path.join(root, '.env'), `TOKEN=${SECRET}\n`);
  const tex = path.join(root, 'output', 'x.tex');
  const pdf = path.join(root, 'output', 'x.pdf');
  fs.writeFileSync(tex, doc(`\\input{${path.join(root, '.env')}}`));
  const r = run(root, [tex, pdf, '--compile-only']);
  assert.equal(leaked(r, pdf), false, `${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.status, 0);
  compileFailed(r);
});

test('given a package file dropped next to the .tex, when compiled, then it is not on the search path', { skip }, () => {
  const root = dataRoot();
  const target = secretFile();
  fs.writeFileSync(path.join(root, 'output', 'evil.sty'), `\\RequirePackage{verbatim}\\AtBeginDocument{\\verbatiminput{${target}}}\n`);
  const tex = path.join(root, 'output', 'x.tex');
  const pdf = path.join(root, 'output', 'x.pdf');
  fs.writeFileSync(tex, doc('Hello.', '\\usepackage{evil}\n'));
  const r = run(root, [tex, pdf, '--compile-only']);
  assert.equal(leaked(r, pdf), false, `${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.status, 0, 'evil.sty is not found');
  compileFailed(r);
  assert.match(r.stderr, /evil\.sty/);
  // A multi-file .tex is told why its own files are missing.
  assert.match(r.stderr, /only the \.tex itself is compiled/);
});

test('given a template-built CV, when compiled with validation, then the PDF is written to the output path with its text and nothing is left beside the .tex', { skip }, () => {
  const root = dataRoot();
  const json = path.join(root, 'output', 'cv.json');
  const tex = path.join(root, 'output', 'cv.tex');
  const pdf = path.join(root, 'output', 'final', 'cv.pdf');
  // build-cv-latex.mjs's own self-test payload shape.
  fs.writeFileSync(json, JSON.stringify({
    name: 'Sandbox Candidate',
    contact_line: 'City, State',
    email: { url: 'cand@example.com', display: 'cand@example.com' },
    education: [{ institution: 'Uni', location: 'City', degree: 'BSc Computing', dates: '2019' }],
    experience: [{ company: 'Corp', role: 'Engineer', location: 'Remote', dates: '2024', bullets: ['Shipped the billing pipeline'] }],
    projects: [{ name: 'Proj', context: 'Node', dates: '2023', bullets: ['Built a thing'] }],
    awards: [{ title: 'Prize', org: 'Org', year: '2025' }],
    skills: [{ category: 'Languages', items: 'JavaScript' }],
  }));
  const built = spawnSync(process.execPath, [path.join(REPO, 'build-cv-latex.mjs'), json, tex], { cwd: REPO, env: envFor(root), encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const r = run(root, [tex, pdf]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(pdfText(pdf), /Sandbox Candidate/);
  assert.match(pdfText(pdf), /Shipped the billing pipeline/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'output')).sort(), ['cv.json', 'cv.tex', 'final']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'output', 'final')), ['cv.pdf']);
});

test('given a .tex missing the template structure, when compiled without --compile-only, then it fails validation and writes no PDF', { skip: noSandbox }, () => {
  const root = dataRoot();
  const tex = path.join(root, 'output', 'x.tex');
  const pdf = path.join(root, 'output', 'x.pdf');
  fs.writeFileSync(tex, doc('Hello.'));
  const r = run(root, [tex, pdf]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /resumeSubheading/);
  assert.equal(fs.existsSync(pdf), false);
});

test('given an output outside the data root\'s output folder, when compiled, then it is refused before anything runs', { skip: noSandbox }, () => {
  const root = dataRoot();
  const tex = path.join(root, 'output', 'x.tex');
  fs.writeFileSync(tex, doc('Hello.'));
  for (const out of [path.join(root, 'cv.pdf'), path.join(root, 'output', '..', 'data', 'x.pdf'), path.join(root, 'output', 'x.txt')]) {
    const r = run(root, [tex, out, '--compile-only']);
    assert.equal(r.status, 1, out);
    assert.match(r.stderr, /output/, out);
    assert.equal(fs.existsSync(out), false, out);
  }
});

test('given an input that is not a .tex file, when compiled, then it is refused', { skip: noSandbox }, () => {
  const root = dataRoot();
  const input = path.join(root, 'output', 'x.md');
  fs.writeFileSync(input, doc('Hello.'));
  const r = run(root, [input, path.join(root, 'output', 'x.pdf'), '--compile-only']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.tex/);
});

// pdflatex also runs with openin_any=p, which refuses absolute paths on its own, so the compile tests above would pass
// with a broken profile; this runs a plain reader under the same profile.
test('given the sandbox profile alone, when a process in it reads a file under the data root or the temp folder, then only its own work folder is readable', { skip: noEngine || noSandbox }, () => {
  const root = fs.realpathSync(dataRoot());
  const work = fs.realpathSync(tempDir('latex-work-'));
  const inWork = path.join(work, 'cv.tex');
  fs.writeFileSync(inWork, 'work file\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), `${SECRET}\n`);
  const bin = spawnSync('which', [engine], { env: { ...process.env, PATH: searchPath }, encoding: 'utf8' }).stdout.trim();
  const env = { ...envFor(root), PATH: searchPath };
  const args = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sandboxArgs } from ${JSON.stringify(COMPILE)}; process.stdout.write(JSON.stringify(sandboxArgs(...JSON.parse(process.argv[1]))));`, JSON.stringify([work, engine, bin, root])], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(args.status, 0, args.stderr);
  const cat = (file) => spawnSync('/usr/bin/sandbox-exec', [...JSON.parse(args.stdout), '/bin/cat', file], { encoding: 'utf8' });
  assert.equal(cat(inWork).stdout, 'work file\n');
  for (const file of [path.join(root, 'notes.txt'), secretFile()]) {
    const r = cat(file);
    assert.notEqual(r.status, 0, file);
    assert.equal(r.stdout.includes(SECRET), false, file);
  }
});

test('given a .tex path that is a link to a non-.tex file inside the root, when compiled, then it is refused and the file never reaches the output', { skip: noSandbox }, () => {
  const root = dataRoot();
  fs.writeFileSync(path.join(root, 'notes.txt'), `${SECRET}\n`);
  const link = path.join(root, 'output', 'a.tex');
  fs.symlinkSync(path.join(root, 'notes.txt'), link);
  const r = run(root, [link, path.join(root, 'output', 'a.pdf'), '--compile-only']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.tex/);
  assert.equal(`${r.stdout}${r.stderr}`.includes(SECRET), false);
});

test('given an output path that is a dangling link, when compiled, then it is refused and nothing is written through it', { skip: noSandbox }, () => {
  const root = dataRoot();
  const tex = path.join(root, 'output', 'x.tex');
  fs.writeFileSync(tex, doc('Hello.'));
  const target = path.join(fs.realpathSync(tempDir('latex-target-')), 'x.plist');
  const out = path.join(root, 'output', 'x.pdf');
  fs.symlinkSync(target, out);
  const r = run(root, [tex, out, '--compile-only']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(fs.existsSync(target), false);
});

test('given a data root reached through a link, when the sandbox is built, then it denies the real folder the link names', { skip: noSandbox }, () => {
  const real = fs.realpathSync(dataRoot());
  const link = path.join(fs.realpathSync(tempDir('latex-link-')), 'root');
  fs.symlinkSync(real, link);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sandboxArgs } from ${JSON.stringify(COMPILE)}; process.stdout.write(JSON.stringify(sandboxArgs(...JSON.parse(process.argv[1]))));`, JSON.stringify([real, 'pdflatex', '/bin/cat', link])], { cwd: REPO, env: envFor(link), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(r.stdout);
  assert.ok(args.includes(`DATA=${real}`), r.stdout);
  assert.ok(args.includes(`WORKSPACE=${real}`), r.stdout);
});
