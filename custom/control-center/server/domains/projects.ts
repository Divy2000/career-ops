// Typed access to the projects library helpers (custom/projects/lib.mjs, a
// contracted pure module). The library file itself is article-digest.md.
import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../core/adapter.js';

export type ProjectKind = 'project' | 'publication' | 'article';

export interface ProjectInput {
  title: string;
  url?: string | null;
  tagline?: string | null;
  tags?: string[];
  kind?: ProjectKind;
  dates?: string | null;
  /** Provenance: the documents/ file an imported entry came from. */
  source?: string | null;
  bullets: string[];
}

export interface LibraryEntry {
  id: string;
  title: string;
  url: string | null;
  tagline: string | null;
  tags: string[];
  kind: string;
  dates: string | null;
  source: string | null;
  bullets: string[];
  line: number;
  /** Character offsets of the entry block in the file (heading through last content line). */
  start: number;
  end: number;
}

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProjectsLib {
  parseLibrary: (text: string) => { preamble: string; entries: LibraryEntry[] };
  validateLibrary: (text: string) => Validation;
  serializeEntry: (entry: ProjectInput) => string;
  serializeLibrary: (entries: ProjectInput[]) => string;
  replaceEntry: (text: string, id: string, entry: ProjectInput) => string;
  appendEntry: (text: string, entry: ProjectInput) => string;
  appendBlock: (text: string, block: string) => string;
  removeEntry: (text: string, id: string) => string;
  convertJsonProjects: (data: unknown) => { entries: ProjectInput[]; warnings: string[] };
  findCvEntry: (cvText: string, title: string) => { line: number; text: string } | null;
  titleKey: (title: string) => string;
}

export function projectsLib(codeRoot: string): Promise<ProjectsLib> {
  return importCore<ProjectsLib>(codeRoot, 'custom/projects/lib.mjs');
}

/** GET /api/projects */
export interface ProjectView {
  id: string;
  title: string;
  url: string | null;
  tagline: string | null;
  tags: string[];
  kind: string;
  dates: string | null;
  source: string | null;
  bullets: string[];
  line: number;
  inCv: boolean;
}

export interface ProjectsRead {
  path: string;
  kind: 'ok' | 'missing';
  etag: string | null;
  entries: ProjectView[];
  validation: Validation;
}

/** POST /api/projects/convert */
export interface ConvertResult {
  markdown: string;
  entries: Array<{ title: string }>;
  duplicates: string[];
  warnings: string[];
  errors: string[];
}

/** projects.rank action result (custom/projects/rank.mjs --json). */
export interface RankCandidate {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  inCv: boolean;
  score: number;
  matchedSkills: string[];
  bullets: string[];
}

export interface RankResult {
  recommended: string[];
  candidates: RankCandidate[];
  excluded: Array<{ id: string; title: string; kind: string }>;
  libraryCoverage: Record<string, string[]>;
}

interface IntakeExtraction {
  classifySource: (relPath: string) => { kind: 'direct' | 'pdf' | 'unsupported'; reason?: string };
  detectPdfExtractor: () => { name: string; extract: (absPath: string) => string } | null;
}

/** The prompt carries the text in argv (macOS ARG_MAX is 1 MiB), so a document's text is capped well below it. */
export const MAX_DOCUMENT_BYTES = 300_000;

/** The documents/-relative path of an existing file under <dataRoot>/documents, or null. */
export function documentsPath(dataRoot: string, rel: string): string | null {
  const docsDir = path.resolve(dataRoot, 'documents');
  if (path.isAbsolute(rel)) return null;
  const abs = path.resolve(docsDir, rel);
  if (!abs.startsWith(docsDir + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return path.relative(docsDir, abs).split(path.sep).join('/');
}

/**
 * The text of a documents/ source, extracted with intake.mjs's own exported helpers (the same extractor
 * `intake.mjs --commit` fingerprints). In process, so nothing is written: `intake.mjs --text` would also
 * create the documents/ scaffold folders.
 */
export async function extractSourceText(codeRoot: string, dataRoot: string, rel: string): Promise<{ ok: true; rel: string; text: string } | { ok: false; error: string }> {
  const found = documentsPath(dataRoot, rel);
  if (!found) return { ok: false, error: `not a file under documents/: ${rel}` };
  const intake = await importCore<IntakeExtraction>(codeRoot, 'intake.mjs');
  const abs = path.join(dataRoot, 'documents', found);
  const cls = intake.classifySource(found);
  let text: string;
  try {
    if (cls.kind === 'direct') text = fs.readFileSync(abs, 'utf8');
    else if (cls.kind === 'pdf') {
      const extractor = intake.detectPdfExtractor();
      if (!extractor) return { ok: false, error: 'no PDF text extractor found: install poppler (brew install poppler), which intake.mjs uses for PDFs' };
      text = extractor.extract(abs);
    } else return { ok: false, error: `documents/${found}: ${cls.reason ?? 'unsupported source'}` };
  } catch (err) {
    return { ok: false, error: `could not read documents/${found}: ${String((err as Error).message).split('\n')[0]}` };
  }
  if (!text.trim()) return { ok: false, error: `no text extracted from documents/${found}: likely a scanned or image-only PDF; convert it or re-export it with a text layer` };
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, error: `documents/${found} has ${Math.round(bytes / 1000)} KB of text; the parser takes at most ${MAX_DOCUMENT_BYTES / 1000} KB, so split it` };
  return { ok: true, rel: found, text };
}
