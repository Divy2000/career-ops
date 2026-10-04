#!/usr/bin/env node
// Installs a tutorial into the data root so the Control Center Tutorials page can play it.
//
//   node custom/control-center/scripts/install-tutorial.mjs <source-folder> [options]
//
// The source folder is either
//   - a folder that already has tutorial.json: it is validated and copied as-is, or
//   - a recording folder: tutorial.json is built from chapters/toc.json ([{ number, id, title, start, duration }]),
//     the .mp4, the .vtt or .srt, an optional poster.jpg and tutorial/script.md. An optional guide/guide.json (the Quick guide)
//     is added too, with the gifs and posters it names sitting next to it in guide/.
// Only tutorial.json and the files it names (and, for a guide, the files guide.json names) are copied; chapter clips, raw takes and the rest stay behind.
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';
import { ID_RE, extOf, guideFileNames, parseGuide, parseManifest } from '../server/domains/tutorial-manifest.mjs';

const USAGE = `Usage: node custom/control-center/scripts/install-tutorial.mjs <source-folder> [options]

Options:
  --data-root <dir>     data root to install into (default: CC_DATA_ROOT, then the career-ops data root)
  --id <id>             tutorial id and folder name (default: the video file name)
  --title <text>        tutorial title (default: the id as words)
  --description <text>  tutorial description
  --video <file>        the .mp4 to use when the folder has several
  --force               replace a tutorial that is already installed
  --dry-run             print what would be installed and write nothing`;

const GUIDE_DIR = 'guide';

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const rootFiles = (dir, exts) => fs.readdirSync(dir).filter((n) => !n.startsWith('.') && exts.includes(extOf(n)) && isFile(path.join(dir, n))).sort();
const stem = (name) => path.basename(name, path.extname(name));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const words = (id) => {
  const t = id.replace(/[-_]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function readChapters(source) {
  const file = path.join(source, 'chapters', 'toc.json');
  if (!isFile(file)) return [];
  let toc;
  try {
    toc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`chapters/toc.json is not valid JSON (${err.message})`, { cause: err });
  }
  if (!Array.isArray(toc)) throw new Error('chapters/toc.json must be a list of chapters');
  return toc.map((c, i) => {
    if (typeof c?.title !== 'string' || !c.title.trim()) throw new Error(`chapters/toc.json: chapter ${i + 1} needs a title`);
    if (typeof c.start !== 'number' || !Number.isFinite(c.start) || c.start < 0) throw new Error(`chapters/toc.json: chapter ${i + 1} needs a start in seconds (a number, 0 or more)`);
    return { title: c.title.trim(), start: c.start };
  });
}

/** One file per kind from the root of a recording folder. */
function pickSubtitles(source, video) {
  for (const ext of ['.vtt', '.srt']) {
    const found = rootFiles(source, [ext]);
    if (found.length === 0) continue;
    const named = found.find((n) => stem(n) === stem(video));
    if (named) return named;
    if (found.length === 1) return found[0];
    throw new Error(`more than one ${ext} file in the source folder (${found.join(', ')}); name the right one like the video`);
  }
  return undefined;
}

function buildManifest(source, opts) {
  let video = opts.video;
  if (video === undefined) {
    const mp4s = rootFiles(source, ['.mp4']);
    if (mp4s.length === 0) throw new Error('no .mp4 file in the source folder');
    if (mp4s.length > 1) throw new Error(`more than one .mp4 file in the source folder (${mp4s.join(', ')}); choose one with --video`);
    video = mp4s[0];
  }
  const id = opts.id ?? slug(stem(video));
  if (!ID_RE.test(id)) throw new Error(`id "${id}" is not valid: use 1 to 64 letters, digits, - or _`);
  const poster = ['poster.jpg', 'poster.jpeg', 'poster.png'].find((n) => isFile(path.join(source, n)));
  const scriptFrom = ['tutorial/script.md', 'script.md'].find((n) => isFile(path.join(source, n)));
  const subtitles = pickSubtitles(source, video);
  const guide = isFile(path.join(source, GUIDE_DIR, 'guide.json'));
  return {
    id,
    title: opts.title ?? words(id),
    description: opts.description ?? '',
    video,
    ...(subtitles ? { subtitles } : {}),
    ...(poster ? { poster } : {}),
    ...(scriptFrom ? { transcript: 'script.md' } : {}),
    ...(guide ? { guide: 'guide.json' } : {}),
    chapters: readChapters(source),
    scriptFrom,
  };
}

/** guide.json and the files it names, from `guideRoot`: validated like the server does, before anything is copied. */
function planGuide(guideRoot, name, chapterCount) {
  const guideFrom = path.join(guideRoot, name);
  if (!isFile(guideFrom)) throw new Error(`guide file "${name}" not found in the source folder`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(guideFrom, 'utf8'));
  } catch (err) {
    throw new Error(`${name} is not valid JSON (${err.message})`, { cause: err });
  }
  const checked = parseGuide(json, { chapterCount });
  if (!checked.ok) throw new Error(`${name} is invalid: ${checked.error}`);
  const gifs = new Set(checked.guide.sections.map((s) => s.gif));
  const files = guideFileNames(checked.guide).map((file) => {
    const kind = gifs.has(file) ? 'guide gif' : 'guide poster';
    if (!isFile(path.join(guideRoot, file))) throw new Error(`${kind} file "${file}" not found in the source folder`);
    return { kind, from: path.join(guideRoot, file), to: file };
  });
  return [{ kind: 'guide', from: guideFrom, to: name }, ...files];
}

/**
 * @param {{ source: string, dataRoot: string, id?: string, title?: string, description?: string, video?: string, force?: boolean, dryRun?: boolean }} opts
 */
export function installTutorial(opts) {
  const source = path.resolve(opts.source);
  const dataRoot = path.resolve(opts.dataRoot);
  if (!isDir(source)) throw new Error(`source folder ${source} does not exist`);
  if (!isDir(dataRoot)) throw new Error(`data root ${dataRoot} does not exist`);

  const manifestPath = path.join(source, 'tutorial.json');
  const built = !isFile(manifestPath);
  let manifest;
  let manifestText;
  let scriptFrom;
  if (built) {
    const { scriptFrom: from, ...m } = buildManifest(source, opts);
    scriptFrom = from;
    const checked = parseManifest(m, m.id);
    if (!checked.ok) throw new Error(`the tutorial.json it would write is invalid: ${checked.error}`);
    manifest = checked.manifest;
    manifestText = `${JSON.stringify(m, null, 2)}\n`;
  } else {
    if (opts.id !== undefined || opts.title !== undefined || opts.description !== undefined || opts.video !== undefined) {
      throw new Error('the source folder already has tutorial.json, which is copied as-is: edit it instead of passing --id, --title, --description or --video');
    }
    manifestText = fs.readFileSync(manifestPath, 'utf8');
    let json;
    try {
      json = JSON.parse(manifestText);
    } catch (err) {
      throw new Error(`tutorial.json is not valid JSON (${err.message})`, { cause: err });
    }
    const checked = parseManifest(json, typeof json?.id === 'string' ? json.id : '');
    if (!checked.ok) throw new Error(`tutorial.json is invalid: ${checked.error}`);
    manifest = checked.manifest;
  }

  const named = [['video', manifest.video], ['subtitles', manifest.subtitles], ['poster', manifest.poster], ['transcript', manifest.transcript]];
  const copies = named
    .filter(([, name]) => name !== undefined)
    .map(([kind, name]) => ({ kind, from: path.join(source, built && kind === 'transcript' && scriptFrom ? scriptFrom : name), to: name }));
  for (const c of copies) if (!isFile(c.from)) throw new Error(`${c.kind} file "${c.to}" not found in the source folder`);
  if (manifest.guide !== undefined) {
    for (const c of planGuide(built ? path.join(source, GUIDE_DIR) : source, manifest.guide, manifest.chapters.length)) {
      const same = copies.find((o) => o.to === c.to);
      if (same && same.from !== c.from) throw new Error(`"${c.to}" is used by both the ${same.kind} and the ${c.kind} file, which are different files`);
      if (!same) copies.push(c);
    }
  }

  const tutorialsDir = path.join(dataRoot, 'data', 'control-center', 'tutorials');
  const dest = path.join(tutorialsDir, manifest.id);
  const files = ['tutorial.json', ...copies.map((c) => c.to)];
  const result = { id: manifest.id, dest, files, manifest, built, dryRun: opts.dryRun === true };
  if (fs.existsSync(dest) && !opts.force) throw new Error(`tutorial "${manifest.id}" is already installed at ${dest}; pass --force to replace it`);
  if (opts.dryRun) return result;

  fs.mkdirSync(tutorialsDir, { recursive: true });
  const staging = path.join(tutorialsDir, `.${manifest.id}.tmp-${process.pid}`);
  const previous = fs.existsSync(dest) ? path.join(tutorialsDir, `.${manifest.id}.old-${process.pid}-${Date.now()}`) : null;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  try {
    for (const c of copies) fs.copyFileSync(c.from, path.join(staging, c.to));
    fs.writeFileSync(path.join(staging, 'tutorial.json'), manifestText);
    if (previous) fs.renameSync(dest, previous);
    try {
      fs.renameSync(staging, dest);
    } catch (err) {
      if (previous) fs.renameSync(previous, dest);
      throw err;
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  if (previous) fs.rmSync(previous, { recursive: true, force: true });
  return result;
}

const VALUE_FLAGS = { '--data-root': 'dataRoot', '--id': 'id', '--title': 'title', '--description': 'description', '--video': 'video' };

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a in VALUE_FLAGS) {
      const value = argv[++i];
      if (value === undefined) return { error: `${a} needs a value` };
      opts[VALUE_FLAGS[a]] = value;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { error: 'give exactly one source folder' };
  return { opts: { ...opts, source: positional[0] } };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const dataRoot = parsed.opts.dataRoot ?? (process.env.CC_DATA_ROOT?.trim() || getCareerOpsRoot());
  try {
    const r = installTutorial({ ...parsed.opts, dataRoot });
    console.log(`${r.dryRun ? 'Dry run: would install' : 'Installed'} ${r.id} into ${r.dest}`);
    console.log(`  built tutorial.json from the recording folder: ${r.built ? 'yes' : 'no, copied as-is'}`);
    console.log(`  chapters: ${r.manifest.chapters.length}`);
    for (const f of r.files) console.log(`  ${f}`);
    if (!r.dryRun) console.log('Open Control Center > Tutorials to watch it.');
    return 0;
  } catch (err) {
    console.error(`install-tutorial: ${err.message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
