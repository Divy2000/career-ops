import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, REPO, dataRoot, envFor } from './helpers.mjs';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const COMPILE = path.join(HERE, '..', 'compile-latex.mjs');
const SECRET = 'R23-SECRET-7f3a9c';

// The TeX engines the wrapper looks for on PATH; MacTeX installs them in /Library/TeX/texbin, which a shell may not have.
const searchPath = [process.env.PATH, '/Library/TeX/texbin'].filter(Boolean).join(path.delimiter);
const engine = ['tectonic', 'pdflatex'].find((bin) => spawnSync(bin, ['--version'], { env: { ...process.env, PATH: searchPath } }).status === 0);
const pdftotext = spawnSync('pdftotext', ['-v']).error ? null : 'pdftotext';
const noEngine = !engine && 'no TeX engine (tectonic or pdflatex) installed';
const noSandbox = process.platform !== 'darwin' && 'sandbox-exec is macOS only';
const skip = noEngine || noSandbox || (!pdftotext && 'pdftotext not installed');

/**
 * A pdflatex stand-in, so the sandbox is tested on hosts with no TeX installed: it reads every file the .tex names with
 * \input, \verbatiminput or \usepackage (a package from the folder it runs in, as TeX looks beside the .tex), with no
 * openin_any refusal of its own, so only the sandbox stands between the .tex and the file. What it reads goes to its
 * output and its "PDF" (plain text). Its kpsewhich names its own folder as the distribution, which the sandbox gives
 * back, as it does a real TeX tree.
 */
function fakeTex() {
  const root = fs.realpathSync(tempDir('latex-fake-tex-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const script = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  script('kpsewhich', `[ "$1" = -var-value=SELFAUTOPARENT ] && echo ${JSON.stringify(root)} || exit 1`);
  script('pdflatex', String.raw`[ "$1" = --version ] && { echo 'fake pdflatex'; exit 0; }
outdir=.
for a; do case "$a" in -output-directory=*) outdir="\${a#*=}" ;; esac; tex="$a"; done
pdf="$outdir/\${tex%.tex}.pdf"
: > "$pdf.part"
while IFS=' ' read -r kind name; do
  case "$kind" in
    usepackage) [ "$name" = verbatim ] && continue; file="$name.sty" ;;
    input) [ -e "$name" ] && file="$name" || file="$name.tex" ;;
    *) file="$name" ;;
  esac
  if ! text="$(/bin/cat -- "$file")"; then echo "! LaTeX Error: File \`$file' not found."; exit 1; fi
  printf '%s\n' "$text" | tee -a "$pdf.part"
done < <(sed -nE 's/.*\\(verbatiminput|input|usepackage)\{([^}]*)\}.*/\1 \2/p' "$tex")
sed -n '/^\\begin{document}$/,/^\\end{document}$/p' "$tex" >> "$pdf.part"
mv "$pdf.part" "$pdf"`.replaceAll('\\$', '$'));
  return { root, bin };
}

// Each security test runs against the stand-in on every macOS host and against the installed engine when there is one.
const compilers = [
  { name: 'stand-in pdflatex', skip: noSandbox, env: () => ({ PATH: `${fakeTex().bin}:/usr/bin:/bin` }), text: (file) => fs.readFileSync(file, 'utf8') },
  { name: 'installed engine', skip, env: () => ({ PATH: searchPath }), text: (file) => spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout },
];

// A TeX engine's first run builds its font and format caches (tectonic also fetches its bundle), which can take more
// than the default CPU budget; 180 s matches the wall-clock limit these runs had before.
const runWith = (root, args, env) => spawnCpuLimited(process.execPath, [COMPILE, ...args], { cwd: REPO, env: { ...envFor(root), ...env }, encoding: 'utf8', cpuSeconds: 180 });
const run = (root, args) => runWith(root, args, { PATH: searchPath });
const pdfText = (file) => spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout;
const secretFile = () => {
  const file = path.join(fs.realpathSync(tempDir('latex-secret-')), 'id_rsa');
  fs.writeFileSync(file, `${SECRET}\n`);
  return file;
};
// A data root outside every folder the profile denies on its own (home, /Users, /Volumes, the temp folders), so only
// the DATA and WORKSPACE rules stand between the engine and its files. /private/var/tmp is world-writable on macOS.
const outsideRoots = [];
after(() => outsideRoots.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const outsideRoot = () => {
  const d = fs.realpathSync(fs.mkdtempSync('/private/var/tmp/cv-root-'));
  outsideRoots.push(d);
  fs.mkdirSync(path.join(d, 'output'));
  return d;
};
const doc = (body, preamble = '') => `\\documentclass{article}\n${preamble}\\begin{document}\n${body}\n\\end{document}\n`;
// Whatever the run left behind: the PDF (when one was written) and everything it printed.
const leaked = (r, pdf, text) => (fs.existsSync(pdf) && text(pdf).includes(SECRET)) || `${r.stdout}${r.stderr}`.includes(SECRET);
// The wrapper ran the engine and reports a failed compile, rather than failing before it (a missing script would pass the leak check).
const compileFailed = (r) => assert.equal(JSON.parse(r.stdout).compiled, false, `${r.stdout}\n${r.stderr}`);

// The stand-in's own check: outside the sandbox's denied folders it reads and prints what the .tex names, so a refused
// read in the tests below is the sandbox's doing, not a stand-in that never reads.
test('given the stand-in pdflatex, when a .tex inputs a file the sandbox gives back, then its text reaches the PDF', { skip: noSandbox }, () => {
  const root = dataRoot();
  const env = compilers[0].env();
  const allowed = path.join(path.dirname(env.PATH.split(':')[0]), 'part.tex');
  fs.writeFileSync(allowed, `${SECRET}\n`);
  const tex = path.join(root, 'output', 'x.tex');
  const pdf = path.join(root, 'output', 'x.pdf');
  fs.writeFileSync(tex, doc(`Hello.\n\\input{${allowed}}`));
  const r = runWith(root, [tex, pdf, '--compile-only'], env);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).compiled, true);
  assert.match(fs.readFileSync(pdf, 'utf8'), new RegExp(`${SECRET}[^]*Hello\\.`));
});

for (const c of compilers) {
  test(`given a .tex that \\verbatiminputs a file outside its temp folder, when compiled, then the file never reaches the PDF or the output (${c.name})`, { skip: c.skip }, () => {
    const root = dataRoot();
    const tex = path.join(root, 'output', 'x.tex');
    const pdf = path.join(root, 'output', 'x.pdf');
    fs.writeFileSync(tex, doc(`\\verbatiminput{${secretFile()}}`, '\\usepackage{verbatim}\n'));
    const r = runWith(root, [tex, pdf, '--compile-only'], c.env());
    assert.equal(leaked(r, pdf, c.text), false, `${r.stdout}\n${r.stderr}`);
    assert.notEqual(r.status, 0, 'a refused read fails the compile');
    compileFailed(r);
  });

  test(`given a .tex that \\inputs a file under the data root, when compiled, then the file never reaches the PDF or the output (${c.name})`, { skip: c.skip }, () => {
    const root = outsideRoot();
    fs.writeFileSync(path.join(root, '.env'), `TOKEN=${SECRET}\n`);
    const tex = path.join(root, 'output', 'x.tex');
    const pdf = path.join(root, 'output', 'x.pdf');
    fs.writeFileSync(tex, doc(`\\input{${path.join(root, '.env')}}`));
    const r = runWith(root, [tex, pdf, '--compile-only'], c.env());
    assert.equal(leaked(r, pdf, c.text), false, `${r.stdout}\n${r.stderr}`);
    assert.notEqual(r.status, 0);
    compileFailed(r);
  });

  test(`given a package file dropped next to the .tex, when compiled, then it is not on the search path (${c.name})`, { skip: c.skip }, () => {
    const root = dataRoot();
    const target = secretFile();
    fs.writeFileSync(path.join(root, 'output', 'evil.sty'), `\\RequirePackage{verbatim}\\AtBeginDocument{\\verbatiminput{${target}}}\n`);
    const tex = path.join(root, 'output', 'x.tex');
    const pdf = path.join(root, 'output', 'x.pdf');
    fs.writeFileSync(tex, doc('Hello.', '\\usepackage{evil}\n'));
    const r = runWith(root, [tex, pdf, '--compile-only'], c.env());
    assert.equal(leaked(r, pdf, c.text), false, `${r.stdout}\n${r.stderr}`);
    assert.notEqual(r.status, 0, 'evil.sty is not found');
    compileFailed(r);
    assert.match(r.stderr, /evil\.sty/);
    // A multi-file .tex is told why its own files are missing.
    assert.match(r.stderr, /only the \.tex itself is compiled/);
  });
}

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
test('given the sandbox profile alone, when a process in it reads a file under the data root, the workspace or the temp folder, then only its own work folder is readable', { skip: noSandbox }, () => {
  // Two roots, so the DATA rule and the WORKSPACE rule each guard a file no other rule covers.
  const root = outsideRoot();
  const workspace = outsideRoot();
  const work = fs.realpathSync(tempDir('latex-work-'));
  const inWork = path.join(work, 'cv.tex');
  fs.writeFileSync(inWork, 'work file\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), `${SECRET}\n`);
  // The installed engine's profile gives back its TeX trees; with none installed, the stand-in's.
  const PATH = engine ? searchPath : compilers[0].env().PATH;
  const bin = spawnSync('which', [engine ?? 'pdflatex'], { env: { ...process.env, PATH }, encoding: 'utf8' }).stdout.trim();
  const env = { ...envFor(root), PATH };
  const args = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sandboxArgs } from ${JSON.stringify(COMPILE)}; process.stdout.write(JSON.stringify(sandboxArgs(...JSON.parse(process.argv.at(-1)))));`, JSON.stringify([work, engine ?? 'pdflatex', bin, workspace])], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(args.status, 0, args.stderr);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), `${SECRET}\n`);
  const cat = (file) => spawnSync('/usr/bin/sandbox-exec', [...JSON.parse(args.stdout), '/bin/cat', file], { encoding: 'utf8' });
  assert.equal(cat(inWork).stdout, 'work file\n');
  // Beside the roots, in the same parent: readable, so the refusals below are the DATA and WORKSPACE rules' doing.
  const beside = path.join(outsideRoot(), 'beside.txt');
  fs.writeFileSync(beside, 'beside\n');
  assert.equal(cat(beside).stdout, 'beside\n');
  for (const file of [path.join(root, 'notes.txt'), path.join(workspace, 'notes.txt'), secretFile()]) {
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
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { sandboxArgs } from ${JSON.stringify(COMPILE)}; process.stdout.write(JSON.stringify(sandboxArgs(...JSON.parse(process.argv.at(-1)))));`, JSON.stringify([real, 'pdflatex', '/bin/cat', link])], { cwd: REPO, env: envFor(link), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const args = JSON.parse(r.stdout);
  assert.ok(args.includes(`DATA=${real}`), r.stdout);
  assert.ok(args.includes(`WORKSPACE=${real}`), r.stdout);
  // The profile's top-level forms start at a line start; the read-and-write deny must name both roots.
  const profile = args[args.indexOf('-p') + 1];
  const deny = profile.split(/\n(?=\()/).find((form) => form.startsWith('(deny file-read* file-write*'));
  assert.ok(deny?.includes('(subpath (param "DATA"))'), profile);
  assert.ok(deny?.includes('(subpath (param "WORKSPACE"))'), profile);
});
