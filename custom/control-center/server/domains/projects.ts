// Typed access to the projects library helpers (custom/projects/lib.mjs, a
// contracted pure module). The library file itself is article-digest.md.
import fs from 'node:fs';
import os from 'node:os';
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
/** intake.mjs's own timeouts: the `pdftotext -v` probe and the `pdftotext -layout` extraction (a test keeps them in step). */
export const INTAKE_PROBE_TIMEOUT_MS = 5_000;
export const INTAKE_EXTRACT_TIMEOUT_MS = 30_000;
/** Worker startup and importing intake.mjs on a busy machine. */
export const WORKER_MARGIN_MS = 10_000;
/** The worker is stopped only after an uncached probe and a full extraction could both have run out, plus the margin. */
export const EXTRACT_DEADLINE_MS = INTAKE_PROBE_TIMEOUT_MS + INTAKE_EXTRACT_TIMEOUT_MS + WORKER_MARGIN_MS;
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
    const timer = setTimeout(() => done({ ok: false, error: `text extraction took longer than ${EXTRACT_DEADLINE_MS / 1000} s` }), EXTRACT_DEADLINE_MS);
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
 * The bytes of a checked documents/ source, read through one descriptor: the real path is opened without
 * following a final symlink, the descriptor must be a regular file, and after the open the path must still
 * resolve inside documents/ to that same file (dev and inode), so a swap after the check is refused.
 */
function readSourceOnce(dataRoot: string, found: string): Buffer | null {
  let docsReal: string;
  try {
    docsReal = fs.realpathSync(path.resolve(dataRoot, 'documents'));
  } catch {
    return null;
  }
  const realAbs = path.join(docsReal, found);
  let fd: number;
  try {
    fd = fs.openSync(realAbs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const now = fs.realpathSync(realAbs);
    const onDisk = fs.lstatSync(now);
    if (!now.startsWith(docsReal + path.sep) || onDisk.dev !== st.dev || onDisk.ino !== st.ino) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** intake's extractor reads a path, so a PDF is extracted from a private copy of the bytes already read. */
async function extractPdfBytes(codeRoot: string, bytes: Buffer): Promise<PdfResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-extract-'));
  try {
    const copy = path.join(dir, 'source.pdf');
    fs.writeFileSync(copy, bytes, { mode: 0o600 });
    return await extractPdf(codeRoot, copy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The text of a documents/ source, extracted with intake.mjs's own exported helpers (the same extractor
 * `intake.mjs --commit` fingerprints), PDFs in a worker thread. Nothing is written: `intake.mjs --text`
 * would also create the documents/ scaffold folders.
 */
export async function extractSourceText(
  codeRoot: string,
  dataRoot: string,
  rel: string,
  /** Test seam: runs between the containment check and the open, where a swap would have to happen. */
  hooks: { beforeOpen?: () => void } = {},
): Promise<{ ok: true; rel: string; text: string } | { ok: false; error: string }> {
  const found = documentsPath(dataRoot, rel);
  if (!found) return { ok: false, error: `not a file under documents/: ${rel}` };
  hooks.beforeOpen?.();
  const raw = readSourceOnce(dataRoot, found);
  if (!raw) return { ok: false, error: `not a file under documents/: ${rel}` };
  const intake = await importCore<IntakeExtraction>(codeRoot, 'intake.mjs');
  const cls = intake.classifySource(found);
  let text: string;
  try {
    if (cls.kind === 'direct') text = raw.toString('utf8');
    else if (cls.kind === 'pdf') {
      const pdf = await extractPdfBytes(codeRoot, raw);
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
