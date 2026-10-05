// Typed access to the projects library helpers (custom/projects/lib.mjs, a
// contracted pure module). The library file itself is article-digest.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { coreModulePath, importCore } from '../core/adapter.js';

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
}

const EXTRACT_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract-worker.mjs');
/** intake's own extractor timeout is 30 s; the worker is stopped a little after it. */
const EXTRACT_TIMEOUT_MS = 35_000;
/** Code roots whose PDF extractor has answered its probe; a missing one is probed again next time (it may get installed). */
const probedRoots = new Set<string>();

type PdfResult = { ok: true; text: string } | { ok: false; missing?: true; error?: string };

/** intake's PDF extractor in a worker thread, so a slow pdftotext never blocks the event loop. */
function extractPdf(codeRoot: string, abs: string): Promise<PdfResult> {
  return new Promise((resolve) => {
    const worker = new Worker(EXTRACT_WORKER, { workerData: { intakePath: coreModulePath(codeRoot, 'intake.mjs'), abs, probed: probedRoots.has(codeRoot) } });
    let settled = false;
    const done = (r: PdfResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: `text extraction took longer than ${EXTRACT_TIMEOUT_MS / 1000} s` }), EXTRACT_TIMEOUT_MS);
    worker.once('message', (m: { ok: boolean; text?: string; missing?: boolean; error?: string }) => {
      if (m.ok) {
        probedRoots.add(codeRoot);
        done({ ok: true, text: m.text ?? '' });
      } else done(m.missing ? { ok: false, missing: true } : { ok: false, error: m.error ?? 'extraction failed' });
    });
    worker.once('error', (err: Error) => done({ ok: false, error: String(err.message).split('\n')[0] }));
    worker.once('exit', (code) => done({ ok: false, error: `the extraction worker exited with code ${code}` }));
  });
}

/** The prompt carries the text in argv (macOS ARG_MAX is 1 MiB), so a document's text is capped well below it. */
export const MAX_DOCUMENT_BYTES = 300_000;

/**
 * The documents/-relative path of an existing file under <dataRoot>/documents, or null. Compared by real
 * path, so a symlink that leads outside documents/ is refused; the path returned is the real file's.
 */
export function documentsPath(dataRoot: string, rel: string): string | null {
  if (path.isAbsolute(rel)) return null;
  let docsReal: string;
  let fileReal: string;
  try {
    docsReal = fs.realpathSync(path.resolve(dataRoot, 'documents'));
    fileReal = fs.realpathSync(path.resolve(dataRoot, 'documents', rel));
    if (!fs.statSync(fileReal).isFile()) return null;
  } catch {
    return null;
  }
  if (!fileReal.startsWith(docsReal + path.sep)) return null;
  return path.relative(docsReal, fileReal).split(path.sep).join('/');
}

/**
 * The text of a documents/ source, extracted with intake.mjs's own exported helpers (the same extractor
 * `intake.mjs --commit` fingerprints), PDFs in a worker thread. Nothing is written: `intake.mjs --text`
 * would also create the documents/ scaffold folders.
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
      const pdf = await extractPdf(codeRoot, abs);
      if (!pdf.ok && pdf.missing) return { ok: false, error: 'no PDF text extractor found: install poppler (brew install poppler), which intake.mjs uses for PDFs' };
      if (!pdf.ok) return { ok: false, error: `could not read documents/${found}: ${pdf.error}` };
      text = pdf.text;
    } else return { ok: false, error: `documents/${found}: ${cls.reason ?? 'unsupported source'}` };
  } catch (err) {
    return { ok: false, error: `could not read documents/${found}: ${String((err as Error).message).split('\n')[0]}` };
  }
  if (!text.trim()) return { ok: false, error: `no text extracted from documents/${found}: likely a scanned or image-only PDF; convert it or re-export it with a text layer` };
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_DOCUMENT_BYTES) return { ok: false, error: `documents/${found} has ${Math.round(bytes / 1000)} KB of text; the parser takes at most ${MAX_DOCUMENT_BYTES / 1000} KB, so split it` };
  return { ok: true, rel: found, text };
}
