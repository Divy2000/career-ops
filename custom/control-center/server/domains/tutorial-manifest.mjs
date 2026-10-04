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
  chapters: z.array(chapterSchema).max(500).default([]),
});

/** Validates a parsed tutorial.json that lives in folder `folder`; chapters come back sorted by start. */
export function parseManifest(value, folder) {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ') };
  }
  if (parsed.data.id !== folder) return { ok: false, error: `id: must equal the folder name (${folder})` };
  return { ok: true, manifest: { ...parsed.data, chapters: [...parsed.data.chapters].sort((a, b) => a.start - b.start) } };
}
