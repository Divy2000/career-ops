#!/usr/bin/env node
// The user-layer writes of install.sh. Every write is exclusive-create or backup-then-rename: nothing
// the user already has is overwritten. Output is tab-separated lines for the shell to read.
// Usage: node seed.mjs <command> [flags]
//   local-paths     --dir <checkout>
//   custom-template --data <root> --template <file>
//   copy-documents  --data <root> [--resume f.md] [--docs a.md ...]
//   cv-status       --data <root> --resume f.md
//   cv-write        --data <root> --resume f.md [--replace]
//   projects-rule   --data <root> --template <_custom-projects.md>
//   projects-check  --lib <custom/projects/lib.mjs> --file <library.md|projects.json>
//   projects-seed   --lib <custom/projects/lib.mjs> --data <root> --file <library.md|projects.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { insertHouseRule, mergeLocalPaths, normalizeMarkdown, parseFlags, summarizeUnifiedDiff, uniqueDestName, validateProjectsInput } from './lib.mjs';

const out = (...cols) => process.stdout.write(`${cols.join('\t')}\n`);
const exists = (f) => fs.existsSync(f);

function localPaths(dir) {
  const file = path.join(dir, 'config', 'local-paths.txt');
  const merged = mergeLocalPaths(exists(file) ? fs.readFileSync(file, 'utf8') : '');
  if (merged === null) return out('present');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, merged);
  out('added');
}

function customTemplate(data, template) {
  const target = path.join(data, 'modes', '_custom.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.copyFileSync(template, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code === 'EEXIST') return out('exists');
    throw err;
  }
  out('created');
}

function sameBytes(a, b) {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function copyOne(kind, src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const family = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?${ext.replace('.', '\\.')}$`);
  const names = fs.readdirSync(destDir);
  const twin = names.filter((n) => family.test(n)).find((n) => sameBytes(path.join(destDir, n), src));
  if (twin) return out('present', kind, path.join(destDir, twin));
  const taken = new Set(names);
  for (;;) {
    const name = uniqueDestName(base, taken);
    try {
      fs.copyFileSync(src, path.join(destDir, name), fs.constants.COPYFILE_EXCL);
      return out('copied', kind, path.join(destDir, name));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      taken.add(name);
    }
  }
}

function copyDocuments(data, resume, docs) {
  if (resume) copyOne('resume', resume, path.join(data, 'documents', 'cv'));
  for (const d of docs) copyOne('doc', d, path.join(data, 'documents', 'projects'));
}

const normalizedResume = (resume) => normalizeMarkdown(fs.readFileSync(resume, 'utf8'));

function cvStatus(data, resume) {
  const cv = path.join(data, 'cv.md');
  if (!exists(cv)) return out('absent');
  const wanted = normalizedResume(resume);
  const current = fs.readFileSync(cv, 'utf8');
  if (current === wanted) return out('identical');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-cv-diff-'));
  try {
    const next = path.join(scratch, 'resume.md');
    fs.writeFileSync(next, wanted);
    let diff = '';
    try {
      execFileSync('diff', ['-u', cv, next], { encoding: 'utf8' });
    } catch (err) {
      if (err.status !== 1) throw err;
      diff = err.stdout;
    }
    const s = summarizeUnifiedDiff(diff, 40);
    out('differs');
    out('added', s.added);
    out('removed', s.removed);
    for (const l of s.preview) out('diff', l);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

function cvWrite(data, resume, replace) {
  const cv = path.join(data, 'cv.md');
  const wanted = normalizedResume(resume);
  fs.mkdirSync(data, { recursive: true });
  if (!exists(cv)) {
    fs.writeFileSync(cv, wanted, { flag: 'wx' });
    return out('created');
  }
  if (fs.readFileSync(cv, 'utf8') === wanted) return out('identical');
  if (!replace) {
    process.stderr.write(`error: ${cv} exists and differs; refusing to overwrite it without --replace\n`);
    process.exit(1);
  }
  let backup = `${cv}.bak-${stamp()}`;
  for (let n = 1; exists(backup); n++) backup = `${cv}.bak-${stamp()}-${n}`;
  fs.copyFileSync(cv, backup, fs.constants.COPYFILE_EXCL);
  const tmp = path.join(data, `.cv.md.tmp-${process.pid}`);
  fs.writeFileSync(tmp, wanted, { flag: 'wx' });
  fs.renameSync(tmp, cv);
  out('replaced', backup);
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

// Unconditional and idempotent: adds the projects-library house rule when its heading is absent.
function projectsRule(data, template) {
  const target = path.join(data, 'modes', '_custom.md');
  if (!exists(target)) return out('absent');
  const next = insertHouseRule(fs.readFileSync(target, 'utf8'), fs.readFileSync(template, 'utf8'));
  if (next === null) return out('present');
  writeAtomic(target, next);
  out('added');
}

// The projects parser lives in the checkout (custom/projects/lib.mjs); install.sh passes its path,
// because this script may run from a standalone copy of custom/install.
async function libraryFrom(lib, file) {
  const input = validateProjectsInput(file);
  if (!input.ok) return { errors: [input.error] };
  const projects = await import(pathToFileURL(path.resolve(lib)).href);
  const raw = input.text;
  if (/\.(md|markdown)$/i.test(file)) {
    const check = projects.validateLibrary(raw);
    return { text: raw, errors: check.errors, count: projects.parseLibrary(raw).entries.length };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { errors: [`${file} is not valid JSON: ${err.message}`] };
  }
  let entries;
  try {
    entries = projects.convertJsonProjects(data).entries;
  } catch (err) {
    return { errors: [`${file}: ${err.message}`] };
  }
  const text = projects.serializeLibrary(entries);
  return { text, errors: projects.validateLibrary(text).errors, count: entries.length };
}

async function projectsCheck(lib, file) {
  const r = await libraryFrom(lib, file);
  if (r.errors.length || !r.count) {
    for (const e of r.errors.length ? r.errors : [`${file} has no projects`]) process.stderr.write(`error: ${e}\n`);
    process.exit(2);
  }
  out('ok', r.count);
}

async function projectsSeed(lib, data, file) {
  const r = await libraryFrom(lib, file);
  if (r.errors.length || !r.count) {
    for (const e of r.errors.length ? r.errors : [`${file} has no projects`]) process.stderr.write(`error: ${e}\n`);
    process.exit(2);
  }
  copyOne('projects', file, path.join(data, 'documents', 'projects'));
  const target = path.join(data, 'article-digest.md');
  try {
    fs.writeFileSync(target, r.text, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return out('exists');
    throw err;
  }
  out('created');
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const f = parseFlags(rest, ['--docs']);
  const need = (name) => {
    const v = f.get(name);
    if (typeof v !== 'string') throw new Error(`${cmd} needs ${name} <value>`);
    return v;
  };
  const opt = (name) => (typeof f.get(name) === 'string' ? f.get(name) : null);
  if (cmd === 'local-paths') localPaths(need('--dir'));
  else if (cmd === 'custom-template') customTemplate(need('--data'), need('--template'));
  else if (cmd === 'copy-documents') copyDocuments(need('--data'), opt('--resume'), f.get('--docs') ?? []);
  else if (cmd === 'cv-status') cvStatus(need('--data'), need('--resume'));
  else if (cmd === 'cv-write') cvWrite(need('--data'), need('--resume'), f.get('--replace') === true);
  else if (cmd === 'projects-rule') projectsRule(need('--data'), need('--template'));
  else if (cmd === 'projects-check') await projectsCheck(need('--lib'), need('--file'));
  else if (cmd === 'projects-seed') await projectsSeed(need('--lib'), need('--data'), need('--file'));
  else throw new Error('usage: seed.mjs local-paths|custom-template|copy-documents|cv-status|cv-write|projects-rule|projects-check|projects-seed ...');
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(2);
}
