#!/usr/bin/env node
// Installs a tutorial into the data root so the Control Center Tutorials page can play it.
//
//   node custom/control-center/scripts/install-tutorial.mjs <source-folder> [options]
//
// The source folder is either
//   - a folder that already has tutorial.json (one video, or a tutorial in parts): it is validated and copied as-is, or
//   - a recording folder: tutorial.json is built from chapters/toc.json ([{ number, id, title, start, duration }]),
//     the .mp4 (and its light-theme twin <name>-light.mp4), the .vtt or .srt, an optional poster.jpg (and poster-light.jpg) and tutorial/script.md.
//     An optional guide/guide.json (the guide) is added too, with the images, clips and posters it names sitting next to it in guide/.
// Only tutorial.json and the files it names (and, for a guide, the files guide.json names) are copied; chapter clips, raw takes and the rest stay behind.
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule } from '../../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../../path-resolver.mjs';
import { ID_RE, MAX_GUIDE_BYTES, extOf, guideFileRefs, isGuideV2, parseGuide, parseManifest } from '../server/domains/tutorial-manifest.mjs';

const USAGE = `Usage: node custom/control-center/scripts/install-tutorial.mjs <source-folder> [options]

Options:
  --data-root <dir>     data root to install into (default: CC_DATA_ROOT, then the career-ops data root)
  --id <id>             tutorial id and folder name (default: the video file name)
  --title <text>        tutorial title (default: the id as words)
  --description <text>  tutorial description
  --video <file>        the .mp4 to use when the folder has several
  --video-light <file>  the light-theme .mp4 (default: <video name>-light.mp4 when it exists)
  --strict-dims         check the width and height a version 2 guide declares against the image headers,
                        and that each part's dark and light posters have the same size
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
const lightOf = (name) => `${stem(name)}-light${path.extname(name)}`;
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
    const lights = new Set([...mp4s.map(lightOf).filter((n) => mp4s.includes(n)), ...(opts.videoLight === undefined ? [] : [opts.videoLight])]);
    const choices = mp4s.filter((n) => !lights.has(n));
    if (choices.length === 0) throw new Error('no .mp4 file in the source folder');
    if (choices.length > 1) throw new Error(`more than one .mp4 file in the source folder (${choices.join(', ')}); choose one with --video`);
    video = choices[0];
  }
  const videoLight = opts.videoLight ?? (isFile(path.join(source, lightOf(video))) ? lightOf(video) : undefined);
  const id = opts.id ?? slug(stem(video));
  if (!ID_RE.test(id)) throw new Error(`id "${id}" is not valid: use 1 to 64 letters, digits, - or _`);
  const poster = ['poster.jpg', 'poster.jpeg', 'poster.png'].find((n) => isFile(path.join(source, n)));
  const posterLight = ['poster-light.jpg', 'poster-light.jpeg', 'poster-light.png'].find((n) => isFile(path.join(source, n)));
  const scriptFrom = ['tutorial/script.md', 'script.md'].find((n) => isFile(path.join(source, n)));
  const subtitles = pickSubtitles(source, video);
  const guide = isFile(path.join(source, GUIDE_DIR, 'guide.json'));
  return {
    id,
    title: opts.title ?? words(id),
    description: opts.description ?? '',
    video,
    ...(videoLight ? { videoLight } : {}),
    ...(subtitles ? { subtitles } : {}),
    ...(poster ? { poster } : {}),
    ...(posterLight ? { posterLight } : {}),
    ...(scriptFrom ? { transcript: 'script.md' } : {}),
    ...(guide ? { guide: 'guide.json' } : {}),
    chapters: readChapters(source),
    scriptFrom,
  };
}

const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u24le = (b, at) => u16le(b, at) | (b[at + 2] << 16);
const u32le = (b, at) => (u24le(b, at) | (b[at + 3] << 24)) >>> 0;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * Width and height from the header of a PNG, GIF, WebP (lossy, lossless, extended and animated: the extended
 * canvas size is the image size) or JPEG. A PNG, GIF or WebP needs only the first 30 bytes; a JPEG needs every segment up to its
 * frame header. Throws with a reason that continues "guide image file "x" ...".
 */
export function imageSize(bytes, ext) {
  switch (ext.toLowerCase()) {
    case '.png':
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('is not a PNG file');
      if (bytes.length < 24) throw new Error('is too short to hold a PNG header');
      if (bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('is not a PNG file (it has no IHDR chunk first)');
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    case '.gif':
      if (!['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) throw new Error('is not a GIF file');
      if (bytes.length < 10) throw new Error('is too short to hold a GIF header');
      return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
    case '.webp':
      return webpSize(bytes);
    case '.jpg':
    case '.jpeg':
      return jpegSize(bytes);
    default:
      throw new Error(`cannot check the size of a ${ext.toLowerCase()} file (--strict-dims reads PNG, GIF, WebP and JPEG headers)`);
  }
}

function webpSize(bytes) {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') throw new Error('is not a WebP file');
  if (bytes.length < 16) throw new Error('is too short to hold a WebP header');
  const fourcc = bytes.toString('latin1', 12, 16);
  const need = (n) => {
    if (bytes.length < n) throw new Error('is too short to hold a WebP header');
  };
  switch (fourcc) {
    case 'VP8 ':
      need(30);
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw new Error('is not a valid WebP file (the VP8 start code is missing)');
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    case 'VP8L': {
      need(25);
      if (bytes[20] !== 0x2f) throw new Error('is not a valid WebP file (the VP8L signature is missing)');
      const bits = u32le(bytes, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      need(30);
      return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    default:
      throw new Error(`is not a valid WebP file (it starts with an unknown "${fourcc}" chunk)`);
  }
}

// Every start-of-frame marker (baseline, extended, progressive, lossless, and their arithmetic-coded forms). C4, C8 and CC are not frames.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
// Markers that stand alone, without a length: TEM and the restart markers.
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

/** How far into a JPEG the frame header is looked for: well past any real run of EXIF, ICC and XMP segments, short of reading a whole large file. */
const JPEG_SEARCH_BYTES = 16 * 1024 * 1024;

/**
 * Walks the segments after SOI to the first frame header, which holds the height and then the width. `read(offset, length)` returns
 * the bytes there (fewer at the end of the data), so a file is read segment header by segment header and skipped by length,
 * never loaded whole.
 */
function jpegSizeFrom(read) {
  const start = read(0, 3);
  if (start.length < 3 || start[0] !== 0xff || start[1] !== 0xd8 || start[2] !== 0xff) throw new Error('is not a JPEG file');
  const cutOff = () => new Error('ends before its frame header');
  let at = 2;
  for (;;) {
    if (at >= JPEG_SEARCH_BYTES) throw new Error(`has no frame header in its first ${JPEG_SEARCH_BYTES / 1024 / 1024} MB`);
    const head = read(at, 4);
    if (head.length < 2) throw cutOff();
    if (head[0] !== 0xff) throw new Error('is not a valid JPEG file (a segment marker is missing)');
    const marker = head[1];
    // A marker may be preceded by any number of 0xFF fill bytes.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (JPEG_STANDALONE.has(marker)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) throw new Error('has no frame header before its image data');
    if (head.length < 4) throw cutOff();
    const length = head.readUInt16BE(2);
    if (length < 2) throw new Error('is not a valid JPEG file (a segment has a bad length)');
    if (JPEG_FRAMES.has(marker)) {
      // The length counts itself: precision (1), height (2), width (2) and the component count (1) need at least 8.
      if (length < 8) throw new Error('is not a valid JPEG file (its frame header is too short)');
      const frame = read(at + 2, 7);
      if (frame.length < 7) throw cutOff();
      return { width: frame.readUInt16BE(5), height: frame.readUInt16BE(3) };
    }
    at += 2 + length;
  }
}

const jpegSize = (bytes) => jpegSizeFrom((offset, length) => bytes.subarray(offset, offset + length));

/** The size of an image file on disk: a JPEG is walked in place, the other formats need only their first bytes. */
function imageSizeOfFile(file, ext) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (offset, length) => {
      const buf = Buffer.alloc(length);
      return buf.subarray(0, fs.readSync(fd, buf, 0, length, offset));
    };
    return ['.jpg', '.jpeg'].includes(ext.toLowerCase()) ? jpegSizeFrom(read) : imageSize(read(0, 64), ext);
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file of every media block must have the size the block declares (--strict-dims). Legacy guides declare no sizes. */
function checkDimensions(guide, guideRoot) {
  if (!isGuideV2(guide)) return;
  for (const s of guide.sections) {
    for (const u of s.subsections) {
      for (const b of u.blocks) {
        if (b.type !== 'media') continue;
        const files = [[b.kind, b.file], [`light ${b.kind}`, b.fileLight], ...(b.kind === 'gif' ? [['poster', b.poster], ['light poster', b.posterLight]] : [])];
        for (const [kind, name] of files) {
          let size;
          try {
            size = imageSizeOfFile(path.join(guideRoot, name), extOf(name));
          } catch (err) {
            throw new Error(`guide ${kind} file "${name}" ${err.message}`, { cause: err });
          }
          if (size.width !== b.width || size.height !== b.height) {
            throw new Error(`guide ${kind} file "${name}" is ${size.width}x${size.height} but guide.json declares ${b.width}x${b.height} (subsection "${u.id}")`);
          }
        }
      }
    }
  }
}

/** A part's dark and light posters must have the same size, or the poster would jump when the theme changes (--strict-dims). */
function checkPosters(source, part) {
  const label = partLabel(part);
  if (part.poster === undefined || part.posterLight === undefined) return;
  const sizeOf = (kind, name) => {
    try {
      return imageSizeOfFile(path.join(source, name), extOf(name));
    } catch (err) {
      throw new Error(`${label}${kind} file "${name}" ${err.message}`, { cause: err });
    }
  };
  const dark = sizeOf('poster', part.poster);
  const light = sizeOf('light poster', part.posterLight);
  if (dark.width !== light.width || dark.height !== light.height) {
    throw new Error(`${label}posters differ in size: "${part.poster}" is ${dark.width}x${dark.height} but "${part.posterLight}" is ${light.width}x${light.height}`);
  }
}

/** How a message names a part: only a manifest in parts has named parts (the one part of a single video declares no duration). */
const partLabel = (p) => (p.duration === null ? '' : `part "${p.id}" `);

/** The files of every part, each kind prefixed with its part's label. */
function partCopies(manifest) {
  return manifest.parts.flatMap((p) => {
    const named = [['video', p.video], ['light video', p.videoLight], ['subtitles', p.subtitles], ['poster', p.poster], ['light poster', p.posterLight]];
    return named.filter(([, name]) => name !== undefined).map(([kind, name]) => ({ kind: `${partLabel(p)}${kind}`, name }));
  });
}

/** guide.json and the files it names, from `guideRoot`: validated like the server does, before anything is copied. */
function planGuide(guideRoot, name, chapterCount, strictDims) {
  const guideFrom = path.join(guideRoot, name);
  if (!isFile(guideFrom)) throw new Error(`guide file "${name}" not found in the source folder`);
  if (fs.statSync(guideFrom).size > MAX_GUIDE_BYTES) throw new Error(`${name} is too large (over ${MAX_GUIDE_BYTES / 1024 / 1024} MB), so the Control Center would not show the guide`);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(guideFrom, 'utf8'));
  } catch (err) {
    throw new Error(`${name} is not valid JSON (${err.message})`, { cause: err });
  }
  const checked = parseGuide(json, { chapterCount });
  if (!checked.ok) throw new Error(`${name} is invalid: ${checked.error}`);
  const files = guideFileRefs(checked.guide).map(({ name: file, kind }) => {
    if (!isFile(path.join(guideRoot, file))) throw new Error(`guide ${kind} file "${file}" not found in the source folder`);
    return { kind: `guide ${kind}`, from: path.join(guideRoot, file), to: file };
  });
  if (strictDims) checkDimensions(checked.guide, guideRoot);
  return [{ kind: 'guide', from: guideFrom, to: name }, ...files];
}

/**
 * @param {{ source: string, dataRoot: string, id?: string, title?: string, description?: string, video?: string, videoLight?: string, strictDims?: boolean, force?: boolean, dryRun?: boolean }} opts
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
    if (opts.id !== undefined || opts.title !== undefined || opts.description !== undefined || opts.video !== undefined || opts.videoLight !== undefined) {
      throw new Error('the source folder already has tutorial.json, which is copied as-is: edit it instead of passing --id, --title, --description, --video or --video-light');
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

  const copies = partCopies(manifest).map(({ kind, name }) => ({ kind, from: path.join(source, name), to: name }));
  if (manifest.transcript !== undefined) copies.push({ kind: 'transcript', from: path.join(source, built && scriptFrom ? scriptFrom : manifest.transcript), to: manifest.transcript });
  for (const c of copies) if (!isFile(c.from)) throw new Error(`${c.kind} file "${c.to}" not found in the source folder`);
  if (opts.strictDims === true) for (const p of manifest.parts) checkPosters(source, p);
  if (manifest.guide !== undefined) {
    for (const c of planGuide(built ? path.join(source, GUIDE_DIR) : source, manifest.guide, manifest.chapters.length, opts.strictDims === true)) {
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
    for (const c of copies) fs.copyFileSync(c.from, path.join(staging, c.to), fs.constants.COPYFILE_FICLONE);
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

/** `m:ss`, the way the Tutorials page shows a length. */
const formatLength = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const VALUE_FLAGS = { '--data-root': 'dataRoot', '--id': 'id', '--title': 'title', '--description': 'description', '--video': 'video', '--video-light': 'videoLight' };

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--strict-dims') opts.strictDims = true;
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
    console.log(`  parts: ${r.manifest.parts.length}`);
    for (const [i, p] of r.manifest.parts.entries()) console.log(`    ${i + 1}. ${p.id}  ${p.short}  ${p.duration === null ? 'length not declared' : formatLength(p.duration)}`);
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
