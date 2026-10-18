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
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { insertHouseRule, mergeLocalPaths, normalizeMarkdown, parseFlags, summarizeUnifiedDiff, uniqueDestName, validateProjectsInput } from './lib.mjs';

const out = (...cols) => process.stdout.write(`${cols.join('\t')}\n`);
const exists = (f) => fs.existsSync(f);

function localPaths(dir) {
  const file = path.join(dir, 'config', 'local-paths.txt');
  const text = exists(file) ? fs.readFileSync(file, 'utf8') : null;
  if (mergeLocalPaths(text ?? '') === null) return out('present');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = linkTarget(file);
  out(withLock(`${target}.lock`, () => updateLocalPaths(target)));
}

// Runs under the lock, so two installers never both add custom/; a writer that skips the lock still never has its
// file replaced.
function updateLocalPaths(target) {
  for (let tries = 0; tries < 3; tries++) {
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_APPEND);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (createNew(target, mergeLocalPaths(''))) return 'added';
      continue;
    }
    try {
      // The merge only appends, so the user's file is extended where it is (through its links, keeping its inode,
      // owner, mode, ACLs and hard links); a failed append is cut back to the user's own lines.
      const current = fs.readFileSync(fd, 'utf8');
      const update = mergeLocalPaths(current);
      if (update === null) return 'present';
      appendOrRestore(fd, update.slice(current.length));
      return 'added';
    } finally {
      fs.closeSync(fd);
    }
  }
  throw new Error(`${target} is neither a file to add custom/ to nor a free name to create it at; check what is there`);
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
// The break guard lives for a stat and an rm, so one older than this was left by a run killed while breaking.
const GUARD_STALE_MS = 5_000;

// Holds a mkdir lock, marked with an empty file named by this run's token, while fn runs. A lock older than
// LOCK_STALE_MS was left by a killed run and is broken.
function withLock(lock, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        fs.closeSync(fs.openSync(path.join(lock, token), 'wx'));
      } catch (err) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      // A folder that takes no new entries cannot hold anyone's lock, and the file in it may still be writable.
      if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) return fn();
      if (err.code !== 'EEXIST') throw err;
    }
    let age;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (age > LOCK_STALE_MS) breakStale(lock);
    if (Date.now() > deadline) throw new Error(`${lock} is held by another install; if none is running, remove it and re-run`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    return fn();
  } finally {
    // A run held up past LOCK_STALE_MS may have had its lock broken and retaken; that lock is not this run's to remove.
    if (exists(path.join(lock, token))) fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Removes a stale lock under a guard, judging its age again there: two runs that both saw it stale must not have the
// second remove the fresh lock the first took after breaking it.
function breakStale(lock) {
  const guard = `${lock}.break`;
  try {
    fs.mkdirSync(guard);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmSync(guard, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return;
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

function appendOrRestore(fd, suffix) {
  const bytes = Buffer.from(suffix);
  let written = 0;
  try {
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written);
  } catch (err) {
    // Cut back only this run's own bytes, and only while they are still the file's tail: another installer may have
    // appended its lines meanwhile, and those stay.
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(written);
      if (written > 0 && size >= written && fs.readSync(fd, tail, 0, written, size - written) === written && tail.equals(bytes.subarray(0, written))) {
        fs.ftruncateSync(fd, size - written);
      }
    } catch {
      // The append error is the one to report.
    }
    throw err;
  }
}

// The file a chain of symlinks at `file` ends at, so a rename into place creates a dangling link's file instead of replacing the link.
function linkTarget(file) {
  let target = file;
  for (let hops = 0; hops < 40; hops++) {
    let link;
    try {
      link = fs.readlinkSync(target);
    } catch (err) {
      if (err.code === 'EINVAL' || err.code === 'ENOENT') return target;
      throw err;
    }
    // The kernel resolves a relative link from the real folder holding it, which differs when that folder is reached
    // through a symlink and the link climbs with `..`.
    target = path.resolve(realDir(path.dirname(target)), link);
  }
  throw new Error(`${file} is a symlink loop`);
}

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return dir;
    throw err;
  }
}

function customTemplate(data, template) {
  const target = path.join(data, 'modes', '_custom.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!createNew(target, fs.readFileSync(template))) return out('exists');
  out('created');
}

// Writes a file that must not exist yet through a temp file, so a failed write leaves nothing a re-run would keep.
// False when the file already exists.
function createNew(file, data) {
  if (exists(file)) return false;
  try {
    writeAtomic(file, data, () => {}, linkNew);
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  return true;
}

// Puts `bytes` into destDir as `base`: an identical file of that name family is reused, a different one
// is never overwritten (the copy gets a -1, -2 ... suffix). Prints the outcome and returns the path.
function placeOne(kind, base, bytes, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  // The family is `base` itself and every `stem-N.ext` uniqueDestName can give it, compared as plain text: a file name
  // may hold any character, so no part of it is read as a pattern.
  const inFamily = (n) => {
    if (n === base) return true;
    if (n.length <= stem.length + 1 + ext.length || !n.startsWith(`${stem}-`) || !n.endsWith(ext)) return false;
    return /^\d+$/.test(n.slice(stem.length + 1, n.length - ext.length));
  };
  const names = fs.readdirSync(destDir);
  const twin = names.filter(inFamily).find((n) => fs.readFileSync(path.join(destDir, n)).equals(bytes));
  if (twin) {
    out('present', kind, path.join(destDir, twin));
    return path.join(destDir, twin);
  }
  const taken = new Set(names);
  for (;;) {
    const name = uniqueDestName(base, taken);
    try {
      fs.writeFileSync(path.join(destDir, name), bytes, { flag: 'wx' });
      out('copied', kind, path.join(destDir, name));
      return path.join(destDir, name);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      taken.add(name);
    }
  }
}

function copyOne(kind, src, destDir) {
  return placeOne(kind, path.basename(src), fs.readFileSync(src), destDir);
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

// Local time, the clock the install log and the draft move-aside are dated by.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cvWrite(data, resume, replace) {
  const cv = path.join(data, 'cv.md');
  const wanted = normalizedResume(resume);
  fs.mkdirSync(data, { recursive: true });
  if (!exists(cv)) {
    writeAtomic(cv, wanted, () => {}, linkNew);
    return out('created');
  }
  if (fs.readFileSync(cv, 'utf8') === wanted) return out('identical');
  if (!replace) {
    process.stderr.write(`error: ${cv} exists and differs; refusing to overwrite it without --replace\n`);
    process.exit(1);
  }
  let backup = `${cv}.bak-${stamp()}`;
  for (let n = 1; exists(backup); n++) backup = `${cv}.bak-${stamp()}-${n}`;
  let backedUp = false;
  try {
    replaceFile(cv, wanted, () => {
      fs.copyFileSync(cv, backup, fs.constants.COPYFILE_EXCL);
      backedUp = true;
    });
  } catch (err) {
    // cv.md was not replaced, so its backup would only be a stray copy left by every retry.
    if (backedUp) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        /* a stray backup; the write failure is the one to report */
      }
    }
    throw err;
  }
  out('replaced', backup);
}

// Moves a fully written temp file to a name that must not exist yet: a hard link fails with EEXIST rather than
// replace a file created meanwhile. A volume without hard links gets an exclusive create instead, which fails the
// same way, and so does a dangling symlink in the name's place.
function linkNew(tmp, file) {
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].includes(err.code)) throw err;
    copyNew(tmp, file);
  }
  // The file is in place: a temp name that cannot be removed must not turn the write into a reported failure.
  try {
    fs.rmSync(tmp, { force: true });
  } catch (err) {
    process.stderr.write(`warning: could not remove ${tmp} (${err.message}), a copy of ${file}; delete it by hand\n`);
  }
}

function copyNew(tmp, file) {
  const data = fs.readFileSync(tmp);
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error(`${file} appeared while it was being written`), { code: 'EEXIST' });
    throw err;
  }
  // From here the file is the one this call created, so a write that fails part way removes it.
  try {
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the write error is the one to report */
    }
    throw err;
  }
}

// beforeRename runs once the new copy is fully written, so a failed write leaves nothing behind.
function writeAtomic(file, text, beforeRename = () => {}, publish = fs.renameSync) {
  // Random as well as per process: a temp file a crashed run left under a reused pid must not block this write.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    beforeRename(tmp);
    publish(tmp, file);
  } catch (err) {
    // The original failure is the one to report; a temp file that cannot be removed must not replace it.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* leftover temp file */
    }
    throw err;
  }
}

// Swaps a new copy in for an existing file at the file its symlinks end at, so the links stay, and with the old file's
// mode, so a file the user made private stays private.
function replaceFile(file, text, beforeRename = () => {}) {
  const target = linkTarget(file);
  writeAtomic(target, text, (tmp) => {
    fs.chmodSync(tmp, fs.statSync(target).mode & 0o7777);
    beforeRename(tmp);
  });
}

// Unconditional and idempotent: adds the projects-library house rule when its heading is absent.
function projectsRule(data, template) {
  const target = path.join(data, 'modes', '_custom.md');
  if (!exists(target)) return out('absent');
  const next = insertHouseRule(fs.readFileSync(target, 'utf8'), fs.readFileSync(template, 'utf8'));
  if (next === null) return out('present');
  replaceFile(target, next);
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
  const docs = path.join(data, 'documents', 'projects');
  let text = r.text;
  if (/\.(md|markdown)$/i.test(file)) copyOne('projects', file, docs);
  else {
    // intake reads Markdown, not JSON: the conversion is the source document kept in documents/, and each entry names it.
    const kept = placeOne('projects', `${path.basename(file).replace(/\.[^.]*$/, '')}.md`, Buffer.from(r.text), docs);
    const source = path.relative(data, kept).split(path.sep).join('/');
    const projects = await import(pathToFileURL(path.resolve(lib)).href);
    text = projects.serializeLibrary(projects.parseLibrary(r.text).entries.map((e) => ({ ...e, source })));
  }
  if (!createNew(path.join(data, 'article-digest.md'), text)) return out('exists');
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
