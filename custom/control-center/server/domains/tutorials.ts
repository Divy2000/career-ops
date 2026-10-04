// Tutorials live in the data root (data/control-center/tutorials/<id>/tutorial.json plus the files it names),
// never in the repo. Everything read from there is user-supplied, so every file reference is a plain file name
// that must resolve, after symlinks, to a regular file inside its own tutorial folder.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, extOf, parseManifest, type ManifestResult, type TutorialManifest } from './tutorial-manifest.mjs';

export const TUTORIALS_REL = path.join('data', 'control-center', 'tutorials');

export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/vtt; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
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

export interface Tutorial {
  id: string;
  title: string;
  description: string;
  video: TutorialFile & { bytes: number };
  subtitles: (TutorialFile & { format: 'srt' | 'vtt' }) | null;
  poster: TutorialFile | null;
  transcript: TutorialFile | null;
  chapters: Array<{ title: string; start: number }>;
  /** Optional files that were dropped because they were missing or outside the folder. */
  warnings: string[];
}

export interface TutorialsRead {
  directory: string;
  tutorials: Tutorial[];
  warnings: Array<{ folder: string; message: string }>;
}

const inside = (root: string, p: string) => p.startsWith(root + path.sep);

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

const mediaUrl = (id: string, file: string) => `/api/tutorials/${id}/media/${encodeURIComponent(file)}`;

export function listTutorials(dataRoot: string): TutorialsRead {
  const directory = tutorialsDir(dataRoot);
  const result: TutorialsRead = { directory, tutorials: [], warnings: [] };
  const root = realOrNull(directory);
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
    const video = resolveFile(dir, m.video);
    if (!video.ok) {
      skip(folder, `video file "${m.video}" ${video.reason === 'outside' ? 'is outside the tutorial folder' : 'not found'}`);
      continue;
    }
    const warnings: string[] = [];
    const optional = (kind: string, name: string | undefined): TutorialFile | null => {
      if (name === undefined) return null;
      const r = resolveFile(dir, name);
      if (r.ok) return { file: name, url: mediaUrl(folder, name) };
      warnings.push(`${kind} file "${name}" ${r.reason === 'outside' ? 'is outside the tutorial folder' : 'not found'}, so it is ignored`);
      return null;
    };
    const subtitles = optional('subtitles', m.subtitles);
    result.tutorials.push({
      id: m.id,
      title: m.title,
      description: m.description,
      video: { file: m.video, url: mediaUrl(folder, m.video), bytes: video.size },
      subtitles: subtitles && { ...subtitles, format: extOf(subtitles.file) === '.srt' ? 'srt' : 'vtt' },
      poster: optional('poster', m.poster),
      transcript: optional('transcript', m.transcript),
      chapters: m.chapters,
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
  const root = realOrNull(tutorialsDir(dataRoot));
  const folder = root === null ? null : realOrNull(path.join(root, id));
  if (root === null || folder === null || !inside(root, folder)) return { ok: false, status: 404, error: 'no such tutorial' };
  const found = resolveFile(folder, file);
  if (!found.ok) return { ok: false, status: 404, error: 'not found' };
  return { ok: true, abs: found.abs, size: found.size, type, convertSrt: extOf(file) === '.srt' };
}

export function readSubtitleText(abs: string, size: number): string | null {
  return size > MAX_SUBTITLE_BYTES ? null : fs.readFileSync(abs, 'utf8');
}
