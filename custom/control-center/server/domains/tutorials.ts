// Tutorials live in the data root (data/control-center/tutorials/<id>/tutorial.json plus the files it names),
// never in the repo. Everything read from there is user-supplied, so every file reference is a plain file name
// that must resolve, after symlinks, to a regular file inside its own tutorial folder.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, MAX_GUIDE_BYTES, extOf, guideDocs, guideFileRefs, isGuideV2, parseGuide, parseManifest, type GuideBlockDoc, type ManifestResult, type TutorialManifest, type TutorialPartManifest } from './tutorial-manifest.mjs';
import { inside } from '../lib/paths.js';

export const TUTORIALS_REL = path.join('data', 'control-center', 'tutorials');

export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/vtt; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

export { parseManifest };
export type { ManifestResult, TutorialManifest };

export type RangeResult = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' };

/** One byte range of a file of `size` bytes. Another unit is ignored; anything unparseable or outside the file is unsatisfiable. */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || !header.startsWith('bytes=')) return { kind: 'none' };
  const m = /^(\d*)-(\d*)$/.exec(header.slice('bytes='.length).trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return { kind: 'unsatisfiable' };
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

const TIMING = /^(\d{1,2}:\d{2}:\d{2})[,.](\d{3})(\s+-->\s+)(\d{1,2}:\d{2}:\d{2})[,.](\d{3})(.*)$/;

/** SubRip to WebVTT: header, dot milliseconds in timing lines only, cue numbers dropped. */
export function srtToVtt(srt: string): string {
  const lines = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const timing = TIMING.exec(line);
    if (timing) {
      out.push(`${timing[1]}.${timing[2]}${timing[3]}${timing[4]}.${timing[5]}${timing[6]}`);
    } else if (/^\d+$/.test(line.trim()) && TIMING.test(lines[i + 1] ?? '') && (out.length === 0 || out[out.length - 1] === '')) {
      continue;
    } else {
      out.push(line);
    }
  }
  const body = out.join('\n').trim();
  return body ? `WEBVTT\n\n${body}\n` : 'WEBVTT\n';
}

export interface TutorialFile {
  file: string;
  url: string;
}

export interface GuideSectionView {
  id: string;
  title: string;
  summary: string;
  route: string | null;
  gif: TutorialFile;
  poster: TutorialFile | null;
  steps: string[];
  tips: string[];
  chapter: number | null;
}

/** The legacy quick guide (a guide.json without `version`), as the current Quick guide tab reads it. */
export interface TutorialGuide {
  sections: GuideSectionView[];
}

export type GuideBlockView =
  | { type: 'text'; text: string }
  | { type: 'steps'; items: string[] }
  | { type: 'tips'; items: string[] }
  | {
      type: 'media';
      kind: 'image' | 'gif';
      alt: string;
      caption: string | null;
      /** Declared size; null for an adapted legacy guide, which does not declare one. */
      width: number | null;
      height: number | null;
      url: string;
      /** The light-theme file; null when there is none (always null for an adapted legacy guide), so the dark file is shown. */
      urlLight: string | null;
      posterUrl: string | null;
      posterLightUrl: string | null;
    };

export interface GuideSubsectionView {
  id: string;
  title: string;
  /** The contents label: the guide's short label, or the title when it has none. */
  short: string;
  /** Empty for an adapted legacy section, whose summary is the first text block. */
  summary: string;
  route: string | null;
  chapter: number | null;
  blocks: GuideBlockView[];
}

export interface GuideDocsSectionView {
  id: string;
  title: string;
  short: string;
  summary: string;
  subsections: GuideSubsectionView[];
}

/** The documentation view of a guide of either format. */
export interface GuideDocs {
  /** The version of the guide.json this was read from. */
  version: 1 | 2;
  /** True for a legacy (version 1) guide that was adapted: one subsection per section, no light media. */
  legacy: boolean;
  sections: GuideDocsSectionView[];
}

/** One part of a tutorial: its own recording and files. A single-video tutorial has one part, "main". */
export interface TutorialPart {
  id: string;
  title: string;
  /** The playlist label: the part's short label, or its title. */
  short: string;
  /** What this part covers, or null when it has no description (the page then shows the tutorial's). A single video's part has the tutorial's. */
  description: string | null;
  /** The length the manifest declares, in seconds; null for the one part of a single-video tutorial. */
  duration: number | null;
  video: TutorialFile & { bytes: number };
  /** The recording rendered for the light theme (same timeline as `video`), or null when there is none or it was dropped. */
  videoLight: (TutorialFile & { bytes: number }) | null;
  subtitles: (TutorialFile & { format: 'srt' | 'vtt' }) | null;
  poster: TutorialFile | null;
  posterLight: TutorialFile | null;
  /** Starts counted from the start of this part. */
  chapters: Array<{ title: string; start: number }>;
}

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  /** At least one, in playing order. */
  parts: TutorialPart[];
  transcript: TutorialFile | null;
  /** Every part's chapters in part order, each with its part id; a guide's chapter number indexes this list. */
  chapters: Array<{ title: string; start: number; part: string }>;
  /** The legacy quick guide, or null when none is named, it is invalid (the reason is then in `warnings`) or it is a version 2 guide (see `guideDocs`). */
  guide: TutorialGuide | null;
  /** The guide as documentation, for a version 1 (adapted) or version 2 guide; null when none is named or it is invalid. */
  guideDocs: GuideDocs | null;
  /** Optional files that were dropped because they were missing or outside the folder. */
  warnings: string[];
}

export interface TutorialsRead {
  directory: string;
  tutorials: Tutorial[];
  warnings: Array<{ folder: string; message: string }>;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
}

type Resolved = { ok: true; abs: string; size: number } | { ok: false; reason: 'not found' | 'outside' };

/** A regular file reached from `folder` (already a realpath) that stays inside it after symlinks. */
function resolveFile(folder: string, name: string): Resolved {
  const real = realOrNull(path.join(folder, name));
  if (real === null) return { ok: false, reason: 'not found' };
  if (!inside(folder, real)) return { ok: false, reason: 'outside' };
  const stat = fs.statSync(real);
  return stat.isFile() ? { ok: true, abs: real, size: stat.size } : { ok: false, reason: 'not found' };
}

export function tutorialsDir(dataRoot: string): string {
  return path.join(dataRoot, TUTORIALS_REL);
}

/** The tutorials folder as a realpath, or null when it is missing or resolves outside the (canonical) data root. */
function realTutorialsRoot(dataRoot: string): string | null {
  const base = realOrNull(dataRoot);
  const root = realOrNull(tutorialsDir(dataRoot));
  return base === null || root === null || !inside(base, root) ? null : root;
}

const mediaUrl = (id: string, file: string) => `/api/tutorials/${id}/media/${encodeURIComponent(file)}`;

type GuideLoad = { ok: true; guide: TutorialGuide | null; docs: GuideDocs } | { ok: false; error: string };

const refusal = (name: string, r: Extract<Resolved, { ok: false }>) => `"${name}" ${r.reason === 'outside' ? 'is outside the tutorial folder' : 'not found'}`;

/** Reads and checks the guide a manifest names: every file it lists must exist inside the folder. All or nothing. */
function loadGuide(folder: string, dir: string, manifest: TutorialManifest & { guide: string }): GuideLoad {
  const file = resolveFile(dir, manifest.guide);
  if (!file.ok) return { ok: false, error: `guide file ${refusal(manifest.guide, file)}` };
  if (file.size > MAX_GUIDE_BYTES) return { ok: false, error: `guide file "${manifest.guide}" is too large (over ${MAX_GUIDE_BYTES / 1024 / 1024} MB)` };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file.abs, 'utf8'));
  } catch (err) {
    return { ok: false, error: `guide file "${manifest.guide}" is not valid JSON (${(err as Error).message})` };
  }
  const parsed = parseGuide(json, { chapterCount: manifest.chapters.length });
  if (!parsed.ok) return { ok: false, error: `guide file "${manifest.guide}" is invalid: ${parsed.error}` };
  for (const { name, kind } of guideFileRefs(parsed.guide)) {
    const r = resolveFile(dir, name);
    if (!r.ok) return { ok: false, error: `guide ${kind} file ${refusal(name, r)}` };
  }
  const url = (name: string) => mediaUrl(folder, name);
  const view = (name: string): TutorialFile => ({ file: name, url: url(name) });
  const block = (b: GuideBlockDoc): GuideBlockView =>
    b.type !== 'media'
      ? b
      : {
          type: 'media',
          kind: b.kind,
          alt: b.alt,
          caption: b.caption,
          width: b.width,
          height: b.height,
          url: url(b.file),
          urlLight: b.fileLight && url(b.fileLight),
          posterUrl: b.poster && url(b.poster),
          posterLightUrl: b.posterLight && url(b.posterLight),
        };
  const docs = guideDocs(parsed.guide);
  const docsView: GuideDocs = {
    version: docs.version,
    legacy: docs.legacy,
    sections: docs.sections.map((s) => ({ ...s, subsections: s.subsections.map((u) => ({ ...u, blocks: u.blocks.map(block) })) })),
  };
  if (isGuideV2(parsed.guide)) return { ok: true, guide: null, docs: docsView };
  return {
    ok: true,
    docs: docsView,
    guide: {
      sections: parsed.guide.sections.map((s) => ({
        id: s.id,
        title: s.title,
        summary: s.summary,
        route: s.route ?? null,
        gif: view(s.gif),
        poster: s.poster ? view(s.poster) : null,
        steps: s.steps,
        tips: s.tips ?? [],
        chapter: s.chapter ?? null,
      })),
    },
  };
}

/** How a message names a part: only a tutorial in parts has named parts (the one part of a single video declares no duration). */
const partLabel = (p: TutorialPartManifest) => (p.duration === null ? '' : `part "${p.id}" `);

type SizedFile = TutorialFile & { bytes: number };

/** An optional file of a tutorial: null when it is not named, or when it is missing or outside the folder (then with a warning). */
function optionalFile(dir: string, folder: string, kind: string, name: string | undefined, warnings: string[]): SizedFile | null {
  if (name === undefined) return null;
  const r = resolveFile(dir, name);
  if (r.ok) return { file: name, url: mediaUrl(folder, name), bytes: r.size };
  warnings.push(`${kind} file ${refusal(name, r)}, so it is ignored`);
  return null;
}

const plain = (f: SizedFile | null): TutorialFile | null => f && { file: f.file, url: f.url };

type PartLoad = { ok: true; part: TutorialPart } | { ok: false; error: string };

/** A part's files: its video must be there; an optional file that is missing is dropped with a warning. */
function loadPart(dir: string, folder: string, p: TutorialPartManifest, warnings: string[]): PartLoad {
  const label = partLabel(p);
  const video = resolveFile(dir, p.video);
  if (!video.ok) return { ok: false, error: `${label}video file ${refusal(p.video, video)}` };
  const optional = (kind: string, name: string | undefined) => optionalFile(dir, folder, `${label}${kind}`, name, warnings);
  const subtitles = optional('subtitles', p.subtitles);
  return {
    ok: true,
    part: {
      id: p.id,
      title: p.title,
      short: p.short,
      description: p.description ?? null,
      duration: p.duration,
      video: { file: p.video, url: mediaUrl(folder, p.video), bytes: video.size },
      videoLight: optional('light video', p.videoLight),
      subtitles: subtitles && { ...plain(subtitles)!, format: extOf(subtitles.file) === '.srt' ? 'srt' : 'vtt' },
      poster: plain(optional('poster', p.poster)),
      posterLight: plain(optional('light poster', p.posterLight)),
      chapters: p.chapters,
    },
  };
}

export function listTutorials(dataRoot: string): TutorialsRead {
  const directory = tutorialsDir(dataRoot);
  const result: TutorialsRead = { directory, tutorials: [], warnings: [] };
  const root = realTutorialsRoot(dataRoot);
  if (root === null) return result;
  const skip = (folder: string, message: string) => result.warnings.push({ folder, message });
  for (const folder of fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort()) {
    const dir = realOrNull(path.join(root, folder));
    if (dir === null || !fs.statSync(dir).isDirectory()) continue;
    if (!inside(root, dir)) {
      skip(folder, 'this folder resolves outside the tutorials folder, so it is not read');
      continue;
    }
    const manifestPath = path.join(dir, 'tutorial.json');
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      skip(folder, 'no tutorial.json in this folder');
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      skip(folder, `tutorial.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    const parsed = parseManifest(json, folder);
    if (!parsed.ok) {
      skip(folder, parsed.error);
      continue;
    }
    const m = parsed.manifest;
    const warnings: string[] = [];
    const loaded = m.parts.map((p) => loadPart(dir, folder, p, warnings));
    const failed = loaded.find((l) => !l.ok);
    if (failed && !failed.ok) {
      skip(folder, failed.error);
      continue;
    }
    const parts = loaded.flatMap((l) => (l.ok ? [l.part] : []));
    let guide: TutorialGuide | null = null;
    let docs: GuideDocs | null = null;
    if (m.guide !== undefined) {
      const read = loadGuide(folder, dir, { ...m, guide: m.guide });
      if (read.ok) {
        guide = read.guide;
        docs = read.docs;
      }
      else warnings.push(`${read.error}, so the quick guide is hidden`);
    }
    result.tutorials.push({
      id: m.id,
      title: m.title,
      description: m.description,
      parts,
      transcript: plain(optionalFile(dir, folder, 'transcript', m.transcript, warnings)),
      chapters: m.chapters,
      guide,
      guideDocs: docs,
      warnings,
    });
  }
  return result;
}

export type MediaOpen = { ok: true; abs: string; size: number; type: string; convertSrt: boolean } | { ok: false; status: 400 | 404 | 415; error: string };

/** Resolves one media request. `id` and `file` come straight from the URL and are never joined before they are validated. */
export function openMedia(dataRoot: string, id: string, file: string): MediaOpen {
  if (!ID_RE.test(id)) return { ok: false, status: 404, error: 'no such tutorial' };
  if (!file || file === '.' || file === '..' || /[/\\\0]/.test(file)) return { ok: false, status: 400, error: 'the file must be a plain file name' };
  const type = MEDIA_TYPES[extOf(file)];
  if (!type) return { ok: false, status: 415, error: 'unsupported file type' };
  const root = realTutorialsRoot(dataRoot);
  const folder = root === null ? null : realOrNull(path.join(root, id));
  if (root === null || folder === null || !inside(root, folder)) return { ok: false, status: 404, error: 'no such tutorial' };
  const found = resolveFile(folder, file);
  if (!found.ok) return { ok: false, status: 404, error: 'not found' };
  return { ok: true, abs: found.abs, size: found.size, type, convertSrt: extOf(file) === '.srt' };
}

export function readSubtitleText(abs: string, size: number): string | null {
  return size > MAX_SUBTITLE_BYTES ? null : fs.readFileSync(abs, 'utf8');
}
