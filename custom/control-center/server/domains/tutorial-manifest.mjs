// tutorial.json validation, shared by the server (listing) and scripts/install-tutorial.mjs (before anything is copied).
// Plain .mjs so the script can import it without a build step; types are in tutorial-manifest.d.mts.
import path from 'node:path';
import { z } from 'zod';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const extOf = (name) => path.extname(name).toLowerCase();

const plainName = (field, exts) =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[/\\\0]/.test(n) && !n.startsWith('.'), 'must be a plain file name inside the tutorial folder, not a path')
    .refine((n) => exts.includes(extOf(n)), `${field} must end in ${exts.join(' or ')}`);

const chapterSchema = z.object({ title: z.string().min(1).max(200), start: z.number().finite().min(0) });

const manifestSchema = z.object({
  id: z.string().regex(ID_RE, 'must be 1 to 64 letters, digits, - or _'),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  video: plainName('video', ['.mp4']),
  subtitles: plainName('subtitles', ['.srt', '.vtt']).optional(),
  poster: plainName('poster', ['.jpg', '.jpeg', '.png']).optional(),
  transcript: plainName('transcript', ['.md']).optional(),
  guide: plainName('guide', ['.json']).optional(),
  chapters: z.array(chapterSchema).max(500).default([]),
});

export const MAX_GUIDE_SECTIONS = 60;
const MAX_STEPS = 12;
const MAX_TIPS = 6;

// An app-internal path: one leading slash, no scheme or host, no backslash, no whitespace or control characters, no parent segments.
const internalRoute = z
  .string()
  .min(1)
  .max(200)
  .refine((r) => r.startsWith('/') && !r.includes('//') && !/[\\\s]/.test(r) && ![...r].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), 'must be an app path that starts with a single "/" (no scheme, host, backslash, "//" or spaces)')
  .refine((r) => !r.split(/[?#]/)[0].split('/').includes('..'), 'must not contain ".." segments');

const text = (max) => z.string().min(1).max(max);

const sectionSchema = z.object({
  id: z.string().regex(ID_RE, 'must be 1 to 64 letters, digits, - or _'),
  title: text(120),
  summary: text(600),
  route: internalRoute.optional(),
  gif: plainName('gif', ['.gif', '.webp']),
  poster: plainName('poster', ['.jpg', '.jpeg', '.png']).optional(),
  steps: z.array(text(500)).min(1).max(MAX_STEPS),
  tips: z.array(text(500)).max(MAX_TIPS).optional(),
  chapter: z.number().int().min(0).optional(),
});

const guideSchema = z.object({ sections: z.array(sectionSchema).min(1).max(MAX_GUIDE_SECTIONS) });

const describeIssues = (error) => error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

/** Validates a parsed guide.json; `chapterCount` is the number of chapters in the tutorial.json next to it. */
export function parseGuide(value, { chapterCount }) {
  const parsed = guideSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: describeIssues(parsed.error) };
  const seen = new Set();
  for (const [i, s] of parsed.data.sections.entries()) {
    if (seen.has(s.id)) return { ok: false, error: `sections.${i}.id: duplicate section id "${s.id}"` };
    seen.add(s.id);
    if (s.chapter !== undefined && s.chapter >= chapterCount) {
      return { ok: false, error: `sections.${i}.chapter: chapter ${s.chapter} does not exist (the tutorial has ${chapterCount} chapters)` };
    }
  }
  return { ok: true, guide: parsed.data };
}

/** Every file a guide names, once each, in section order (gif then poster). */
export function guideFileNames(guide) {
  return [...new Set(guide.sections.flatMap((s) => (s.poster ? [s.gif, s.poster] : [s.gif])))];
}

/** Validates a parsed tutorial.json that lives in folder `folder`; chapters come back sorted by start. */
export function parseManifest(value, folder) {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: describeIssues(parsed.error) };
  }
  if (parsed.data.id !== folder) return { ok: false, error: `id: must equal the folder name (${folder})` };
  return { ok: true, manifest: { ...parsed.data, chapters: [...parsed.data.chapters].sort((a, b) => a.start - b.start) } };
}
