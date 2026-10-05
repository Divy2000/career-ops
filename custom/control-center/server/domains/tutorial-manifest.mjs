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

const manifestSchema = z
  .object({
    id: z.string().regex(ID_RE, 'must be 1 to 64 letters, digits, - or _'),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).default(''),
    video: plainName('video', ['.mp4']),
    videoLight: plainName('videoLight', ['.mp4']).optional(),
    subtitles: plainName('subtitles', ['.srt', '.vtt']).optional(),
    poster: plainName('poster', ['.jpg', '.jpeg', '.png']).optional(),
    posterLight: plainName('posterLight', ['.jpg', '.jpeg', '.png']).optional(),
    transcript: plainName('transcript', ['.md']).optional(),
    guide: plainName('guide', ['.json']).optional(),
    chapters: z.array(chapterSchema).max(500).default([]),
  })
  // Compared without case: on a case-insensitive disk "Demo.mp4" and "demo.mp4" are one file.
  .refine((m) => m.videoLight === undefined || m.videoLight.toLowerCase() !== m.video.toLowerCase(), {
    path: ['videoLight'],
    message: 'must be a different file from video (the light version of the recording)',
  });

export const MAX_GUIDE_SECTIONS = 60;
/** guide.json larger than this is refused by the server, so the installer refuses it too. */
export const MAX_GUIDE_BYTES = 1024 * 1024;
const MAX_STEPS = 12;
const MAX_TIPS = 6;

// An app-internal path: one leading slash, no scheme or host, no backslash, no whitespace or control characters, and no
// "." or ".." segments, also when written percent-encoded (%2e). The path is checked after decoding so an encoded slash or dot cannot hide one.
const hasControl = (r) => [...r].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

function routeProblem(r) {
  if (!r.startsWith('/') || r.includes('//') || /[\\\s]/.test(r) || hasControl(r)) return 'must be an app path that starts with a single "/" (no scheme, host, backslash, "//" or spaces)';
  if (/%(?![0-9A-Fa-f]{2})/.test(r)) return 'has an invalid percent escape';
  let path;
  try {
    path = decodeURIComponent(r.split(/[?#]/)[0]);
  } catch {
    return 'has an invalid percent escape';
  }
  if (path.includes('//') || path.includes('\\') || hasControl(path)) return 'must not hide a "//", backslash or control character behind a percent escape';
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return 'must not contain "." or ".." segments';
  return null;
}

const internalRoute = z
  .string()
  .min(1)
  .max(200)
  .superRefine((r, ctx) => {
    const problem = routeProblem(r);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

const text = (max) => z.string().min(1).max(max);
/** The label the contents panel shows in place of a long title. */
const shortLabel = z.string().min(1).max(24).refine((s) => s.trim() !== '', 'must not be blank');

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

// Version 2: documentation-style guide. Sections hold subsections, subsections hold blocks, and every image or clip has a
// dark file and a light file so the page can follow the theme. Every object is strict: a typo is an error, not a silently dropped field.
export const MAX_GUIDE_V2_SECTIONS = 12;
export const MAX_GUIDE_SUBSECTIONS = 80;
const MAX_SUBSECTIONS_PER_SECTION = 8;
const MAX_BLOCKS = 10;
const MAX_V2_STEPS = 8;
const MAX_V2_TIPS = 4;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const CLIP_EXTS = ['.gif', '.webp'];
const POSTER_EXTS = ['.png', '.jpg', '.jpeg'];
const idField = z.string().regex(ID_RE, 'must be 1 to 64 letters, digits, - or _');
const dimension = z.number().int().min(1).max(4096);

const textBlock = z.strictObject({ type: z.literal('text'), text: text(600) });
const stepsBlock = z.strictObject({ type: z.literal('steps'), items: z.array(text(300)).min(1).max(MAX_V2_STEPS) });
const tipsBlock = z.strictObject({ type: z.literal('tips'), items: z.array(text(300)).min(1).max(MAX_V2_TIPS) });
const mediaShape = {
  type: z.literal('media'),
  alt: text(200),
  caption: text(200).optional(),
  width: dimension,
  height: dimension,
};
const imageBlock = z.strictObject({
  ...mediaShape,
  kind: z.literal('image'),
  file: plainName('file', IMAGE_EXTS),
  fileLight: plainName('fileLight', IMAGE_EXTS),
});
const clipBlock = z.strictObject({
  ...mediaShape,
  kind: z.literal('gif'),
  file: plainName('file', CLIP_EXTS),
  fileLight: plainName('fileLight', CLIP_EXTS),
  poster: plainName('poster', POSTER_EXTS),
  posterLight: plainName('posterLight', POSTER_EXTS),
});
const blockSchema = z.discriminatedUnion('type', [textBlock, stepsBlock, tipsBlock, z.discriminatedUnion('kind', [imageBlock, clipBlock])]);

const subsectionSchema = z.strictObject({
  id: idField,
  title: text(120),
  short: shortLabel.optional(),
  summary: text(600),
  route: internalRoute.optional(),
  chapter: z.number().int().min(0).optional(),
  blocks: z.array(blockSchema).min(1).max(MAX_BLOCKS),
});
const sectionV2Schema = z.strictObject({
  id: idField,
  title: text(120),
  short: shortLabel.optional(),
  summary: text(300),
  subsections: z.array(subsectionSchema).min(1).max(MAX_SUBSECTIONS_PER_SECTION),
});
const guideV2Schema = z.strictObject({ version: z.literal(2), sections: z.array(sectionV2Schema).min(1).max(MAX_GUIDE_V2_SECTIONS) });

const describeIssues = (error) => error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

const fail = (error) => ({ ok: false, error });

function parseGuideV1(value, chapterCount) {
  const parsed = guideSchema.safeParse(value);
  if (!parsed.success) return fail(describeIssues(parsed.error));
  const seen = new Set();
  for (const [i, s] of parsed.data.sections.entries()) {
    if (seen.has(s.id)) return fail(`sections.${i}.id: duplicate section id "${s.id}"`);
    seen.add(s.id);
    if (s.chapter !== undefined && s.chapter >= chapterCount) {
      return fail(`sections.${i}.chapter: chapter ${s.chapter} does not exist (the tutorial has ${chapterCount} chapters)`);
    }
  }
  return { ok: true, guide: parsed.data };
}

function parseGuideV2(value, chapterCount) {
  const parsed = guideV2Schema.safeParse(value);
  if (!parsed.success) return fail(describeIssues(parsed.error));
  const total = parsed.data.sections.reduce((n, s) => n + s.subsections.length, 0);
  if (total > MAX_GUIDE_SUBSECTIONS) return fail(`sections: more than ${MAX_GUIDE_SUBSECTIONS} subsections in total (this guide has ${total})`);
  const sections = new Set();
  for (const [i, s] of parsed.data.sections.entries()) {
    if (sections.has(s.id)) return fail(`sections.${i}.id: duplicate section id "${s.id}"`);
    sections.add(s.id);
    const subsections = new Set();
    for (const [j, u] of s.subsections.entries()) {
      const at = `sections.${i}.subsections.${j}`;
      if (subsections.has(u.id)) return fail(`${at}.id: duplicate subsection id "${u.id}" in section "${s.id}"`);
      subsections.add(u.id);
      if (u.chapter !== undefined && u.chapter >= chapterCount) {
        return fail(`${at}.chapter: chapter ${u.chapter} does not exist (the tutorial has ${chapterCount} chapters)`);
      }
    }
  }
  return { ok: true, guide: parsed.data };
}

/**
 * Validates a parsed guide.json; `chapterCount` is the number of chapters in the tutorial.json next to it.
 * A guide with `"version": 2` is the documentation format; one without a version is the legacy format (read-only, adapted by guideDocs).
 */
export function parseGuide(value, { chapterCount }) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'version' in value) {
    if (value.version !== 2) return fail(`version: unsupported guide version ${JSON.stringify(value.version)}; use 2, or leave version out for the legacy format`);
    return parseGuideV2(value, chapterCount);
  }
  return parseGuideV1(value, chapterCount);
}

export const isGuideV2 = (guide) => guide.version === 2;

/** Every file a guide names, once each (the first kind wins), in order: v1 gif then poster per section; v2 file, fileLight, poster, posterLight per media block. */
export function guideFileRefs(guide) {
  const refs = isGuideV2(guide)
    ? guide.sections.flatMap((s) =>
        s.subsections.flatMap((u) =>
          u.blocks.flatMap((b) => {
            if (b.type !== 'media') return [];
            const files = [{ name: b.file, kind: b.kind }, { name: b.fileLight, kind: `light ${b.kind}` }];
            if (b.kind === 'gif') files.push({ name: b.poster, kind: 'poster' }, { name: b.posterLight, kind: 'light poster' });
            return files;
          }),
        ),
      )
    : guide.sections.flatMap((s) => (s.poster ? [{ name: s.gif, kind: 'gif' }, { name: s.poster, kind: 'poster' }] : [{ name: s.gif, kind: 'gif' }]));
  const seen = new Set();
  return refs.filter((r) => !seen.has(r.name) && seen.add(r.name));
}

export const guideFileNames = (guide) => guideFileRefs(guide).map((r) => r.name);

const mediaView = (b) => ({
  type: 'media',
  kind: b.kind,
  file: b.file,
  fileLight: b.fileLight ?? null,
  poster: b.poster ?? null,
  posterLight: b.posterLight ?? null,
  alt: b.alt,
  caption: b.caption ?? null,
  width: b.width ?? null,
  height: b.height ?? null,
});

/**
 * The one shape the page reads, for either format. A legacy section becomes a section with one subsection
 * (summary text, clip with no light variant, steps, tips) and its subsection summary is empty because the summary is a text block.
 */
export function guideDocs(guide) {
  if (isGuideV2(guide)) {
    return {
      version: 2,
      legacy: false,
      sections: guide.sections.map((s) => ({
        id: s.id,
        title: s.title,
        short: s.short ?? s.title,
        summary: s.summary,
        subsections: s.subsections.map((u) => ({
          id: u.id,
          title: u.title,
          short: u.short ?? u.title,
          summary: u.summary,
          route: u.route ?? null,
          chapter: u.chapter ?? null,
          blocks: u.blocks.map((b) => (b.type === 'media' ? mediaView(b) : b)),
        })),
      })),
    };
  }
  return {
    version: 1,
    legacy: true,
    sections: guide.sections.map((s) => ({
      id: s.id,
      title: s.title,
      short: s.title,
      summary: s.summary,
      subsections: [
        {
          id: s.id,
          title: s.title,
          short: s.title,
          summary: '',
          route: s.route ?? null,
          chapter: s.chapter ?? null,
          blocks: [
            { type: 'text', text: s.summary },
            mediaView({ kind: 'gif', file: s.gif, poster: s.poster, alt: s.title }),
            { type: 'steps', items: s.steps },
            ...(s.tips?.length ? [{ type: 'tips', items: s.tips }] : []),
          ],
        },
      ],
    })),
  };
}

// The parts form: the recording is split into parts, each its own video with its own files, length and chapters.
const MAX_PARTS = 50;
/** The fields that belong to a part when a manifest has parts; at the top level they are refused. */
const PART_FIELDS = ['video', 'videoLight', 'subtitles', 'poster', 'posterLight', 'chapters'];
const PART_FILES = ['video', 'videoLight', 'subtitles', 'poster', 'posterLight'];

const partSchema = z.strictObject({
  id: idField,
  title: text(120),
  short: shortLabel.optional(),
  // Trimmed first, so a blank one is too short rather than kept as spaces.
  description: z.string().trim().min(1).max(300).optional(),
  video: plainName('video', ['.mp4']),
  videoLight: plainName('videoLight', ['.mp4']).optional(),
  subtitles: plainName('subtitles', ['.srt', '.vtt']).optional(),
  poster: plainName('poster', ['.jpg', '.jpeg', '.png']).optional(),
  posterLight: plainName('posterLight', ['.jpg', '.jpeg', '.png']).optional(),
  duration: z.number().finite().positive(),
  chapters: z.array(chapterSchema).min(1).max(500),
});

const partsManifestSchema = z.object({
  id: idField,
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  transcript: plainName('transcript', ['.md']).optional(),
  guide: plainName('guide', ['.json']).optional(),
  parts: z.array(partSchema).min(1).max(MAX_PARTS),
});

const byStart = (chapters) => [...chapters].sort((a, b) => a.start - b.start);
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const flatten = (parts) => parts.flatMap((p) => p.chapters.map((c) => ({ ...c, part: p.id })));

/** Ids are unique, no file is named twice (without case: one file on a case-insensitive disk), and every chapter starts inside its part. */
function checkParts(parts) {
  const ids = new Set();
  const files = new Map();
  for (const [i, p] of parts.entries()) {
    if (ids.has(p.id)) return `parts.${i}.id: duplicate part id "${p.id}"`;
    ids.add(p.id);
    for (const field of PART_FILES) {
      const name = p[field];
      if (name === undefined) continue;
      const at = `parts.${i}.${field}`;
      const used = files.get(name.toLowerCase());
      if (used !== undefined) return `${at}: "${name}" is already used by ${used}; every part file must be a different file`;
      files.set(name.toLowerCase(), at);
    }
    for (const [j, c] of p.chapters.entries()) {
      if (c.start >= p.duration) return `parts.${i}.chapters.${j}.start: ${c.start} is not before the part's duration (${p.duration})`;
    }
  }
  return null;
}

function parsePartsManifest(value, folder) {
  if ('video' in value) return fail('video: a manifest has either video or parts, not both; with parts, move it into a part');
  const misplaced = PART_FIELDS.find((f) => f in value);
  if (misplaced) return fail(`${misplaced}: with parts, move it into a part`);
  const parsed = partsManifestSchema.safeParse(value);
  if (!parsed.success) return fail(describeIssues(parsed.error));
  if (parsed.data.id !== folder) return fail(`id: must equal the folder name (${folder})`);
  const problem = checkParts(parsed.data.parts);
  if (problem) return fail(problem);
  const { parts: raw, ...rest } = parsed.data;
  const parts = raw.map((p) => ({ ...p, short: p.short ?? p.title, chapters: byStart(p.chapters) }));
  return { ok: true, manifest: { ...rest, parts, chapters: flatten(parts) } };
}

/**
 * Validates a parsed tutorial.json that lives in folder `folder`. Either form comes back as parts (a single-video manifest is one part,
 * "main", named and described after the tutorial, with no declared duration), each with its chapters sorted by start, and `chapters` flattened across
 * the parts in order, each with its part id and its start counted from the start of that part.
 */
export function parseManifest(value, folder) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'parts' in value) return parsePartsManifest(value, folder);
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: describeIssues(parsed.error) };
  }
  if (parsed.data.id !== folder) return { ok: false, error: `id: must equal the folder name (${folder})` };
  const { video, videoLight, subtitles, poster, posterLight, chapters, ...rest } = parsed.data;
  const main = defined({ id: 'main', title: rest.title, short: rest.title, description: rest.description || undefined, video, videoLight, subtitles, poster, posterLight, duration: null, chapters: byStart(chapters) });
  return { ok: true, manifest: { ...rest, parts: [main], chapters: flatten([main]) } };
}
