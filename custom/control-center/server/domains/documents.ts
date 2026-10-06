import fs from 'node:fs';
import path from 'node:path';
import { inside } from '../lib/paths.js';

export interface DocumentFile {
  /** Path relative to the data root (servable through /api/files/serve). */
  path: string;
  html: string | null;
  kind: 'cv' | 'cover' | 'other';
  format: string | null;
  date: string | null;
  source: 'index' | 'output';
  /** Why Re-render is not offered for this file (another report owns it), or null. */
  rerenderBlock: string | null;
}

export interface DocumentsRead {
  files: DocumentFile[];
  jds: string[];
  indexPresent: boolean;
  /** The report this row is filed under; pdf-index.tsv rows and re-renders are keyed by it. */
  report: number | null;
}

export interface PdfIndexRow {
  report: number;
  pdf: string;
  html: string;
  format: string;
  date: string;
  kind: string;
}

/** data/pdf-index.tsv: `report\tpdf\thtml\tformat\tdate\tkind`, comment lines start with #. */
export function parsePdfIndex(text: string): PdfIndexRow[] {
  const rows: PdfIndexRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.split('\t');
    const report = parseInt(c[0] ?? '', 10);
    if (!Number.isInteger(report) || !c[1]) continue;
    rows.push({ report, pdf: c[1], html: c[2] ?? '', format: c[3] ?? '', date: c[4] ?? '', kind: c[5] ?? '' });
  }
  return rows;
}

export function readPdfIndex(dataRoot: string): PdfIndexRow[] {
  const indexPath = path.join(dataRoot, 'data', 'pdf-index.tsv');
  return fs.existsSync(indexPath) ? parsePdfIndex(fs.readFileSync(indexPath, 'utf8')) : [];
}

const BUNDLE = /^output\/(\d+)-[^/]+\//;
const bundleReport = (file: string): number | null => {
  const m = file.match(BUNDLE);
  return m ? Number(m[1]) : null;
};

/**
 * Why re-rendering (html, pdf) for `report` would file another report's document under it, or null when the pair is
 * indexed under that report, sits in that report's application folder, or is claimed by no report at all.
 */
export function rerenderProblem(index: PdfIndexRow[], report: number, html: string, pdf: string): string | null {
  if (index.some((r) => r.report === report && r.pdf === pdf)) return null;
  if (bundleReport(pdf) === report && bundleReport(html) === report) return null;
  for (const file of [pdf, html]) {
    const indexed = index.find((r) => r.report !== report && (r.pdf === file || r.html === file))?.report;
    const bundled = bundleReport(file);
    const owner = indexed ?? (bundled !== null && bundled !== report ? bundled : null);
    if (owner !== null) return `${file} belongs to report ${owner}, so re-rendering it here would file it under report ${report}. Re-render it from that application instead.`;
  }
  return null;
}

export function companySlug(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** A file name naming the company as a whole word: "box" never matches cv-dropbox.pdf, "meta" never metabase. */
function namesCompany(slug: string, file: string): boolean {
  return Boolean(slug) && new RegExp(`(^|[^a-z0-9])${slug}([^a-z0-9]|$)`).test(path.basename(file).toLowerCase());
}

function exists(dataRoot: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(dataRoot, rel)).isFile();
  } catch {
    return false;
  }
}

function mtime(dataRoot: string, rel: string): number {
  try {
    return fs.statSync(path.join(dataRoot, rel)).mtimeMs;
  } catch {
    return 0;
  }
}

/** PDFs from the index for the row's report first, then output/ files matching the company, newest first. pdf-index.tsv and jds/ are keyed by report number, never by tracker row. */
export function readDocuments(dataRoot: string, report: number | null, company: string): DocumentsRead {
  const indexPath = path.join(dataRoot, 'data', 'pdf-index.tsv');
  const indexPresent = fs.existsSync(indexPath);
  const rows = indexPresent ? parsePdfIndex(fs.readFileSync(indexPath, 'utf8')) : [];
  const files: DocumentFile[] = [];
  const seen = new Set<string>();
  for (const r of report === null ? [] : rows.filter((x) => x.report === report)) {
    if (seen.has(r.pdf)) continue;
    seen.add(r.pdf);
    files.push({ path: r.pdf, html: r.html && exists(dataRoot, r.html) ? r.html : null, kind: documentKind(r.kind, r.pdf), format: r.format || null, date: r.date || null, source: 'index', rerenderBlock: null });
  }
  const slug = companySlug(company);
  const outDir = path.join(dataRoot, 'output');
  if (slug && fs.existsSync(outDir)) {
    for (const name of fs.readdirSync(outDir)) {
      if (!name.toLowerCase().endsWith('.pdf') || !namesCompany(slug, name)) continue;
      const rel = `output/${name}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const twin = `output/${name.slice(0, -4)}.html`;
      files.push({ path: rel, html: exists(dataRoot, twin) ? twin : null, kind: documentKind(undefined, rel), format: null, date: null, source: 'output', rerenderBlock: null });
    }
  }
  files.sort((a, b) => mtime(dataRoot, b.path) - mtime(dataRoot, a.path));
  for (const f of files) f.rerenderBlock = report !== null && f.html ? rerenderProblem(rows, report, f.html, f.path) : null;
  const jdsDir = path.join(dataRoot, 'jds');
  // With a report, only its own jds/NNN- captures: a company match would also list the JDs of the company's other reports.
  const ownsJd = report === null ? (f: string) => namesCompany(slug, f) : (f: string) => f.startsWith(`${String(report).padStart(3, '0')}-`);
  const jds = fs.existsSync(jdsDir) ? fs.readdirSync(jdsDir).filter(ownsJd).map((f) => `jds/${f}`) : [];
  return { files, jds, indexPresent, report };
}

/** Absolute real path of a regular file under the data root's output/ (symlinks resolved), or null. */
export function resolveOutputFile(dataRoot: string, rel: string): string | null {
  try {
    const outDir = fs.realpathSync(path.join(dataRoot, 'output'));
    const real = fs.realpathSync(path.resolve(dataRoot, rel));
    return inside(outDir, real) && fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export interface ApplyDocuments {
  /** CV PDFs under output/ (cover-letter PDFs excluded), newest first. */
  pdfs: string[];
  /** Plain-text cover letters under output/; prepare-application.mjs reads --cover as text, so a cover PDF never qualifies. */
  covers: string[];
  suggestedPdf: string | null;
  suggestedCover: string | null;
}

/**
 * The kind generate-pdf.mjs's resolveArtifactKind() infers from a file name: a cover letter only for an anchored
 * cover-... or ...-cover name, so a company or role containing "cover" stays a CV. tests/unit/apply-documents.test.ts
 * checks it against the generator.
 */
export function artifactKindFromName(file: string): 'cv' | 'cover' {
  const name = path.basename(file).toLowerCase().replace(/\.[^.]*$/, '');
  if (name.startsWith('cv-')) return 'cv';
  return /^cover([-_]|$)/.test(name) || /[-_]cover$/.test(name) ? 'cover' : 'cv';
}

/** The manifest's kind when it recorded one (older manifests have no kind column), else the name rule. */
export function documentKind(manifestKind: string | undefined, file: string): 'cv' | 'cover' {
  return manifestKind === 'cv' || manifestKind === 'cover' ? manifestKind : artifactKindFromName(file);
}

const COVER_TEXT = /\.(txt|md)$/i;
const TAILORED_CV = /^output\/(\d+)-[^/]+\/cv\/tailored\/v(\d+)\/cv\.pdf$/;

function walkOutput(dataRoot: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dataRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(child);
      else if (resolveOutputFile(dataRoot, child)) out.push(child);
    }
  };
  visit('output');
  return out;
}

/**
 * What the Apply page can attach: every CV PDF and text cover under output/, plus a suggestion for one tracker row.
 * Everything about that row is keyed by its report number (pdf-index.tsv and the application bundles), never by the row number.
 */
export function readApplyDocuments(dataRoot: string, row: { report: number | null; company: string } | null): ApplyDocuments {
  const indexPath = path.join(dataRoot, 'data', 'pdf-index.tsv');
  const index = fs.existsSync(indexPath) ? parsePdfIndex(fs.readFileSync(indexPath, 'utf8')) : [];
  // The generator's manifest records the kind it rendered; the name is only the fallback, as in generate-pdf.mjs.
  const manifestKind = new Map(index.map((r) => [r.pdf, r.kind]));
  const files = walkOutput(dataRoot).sort((a, b) => mtime(dataRoot, b) - mtime(dataRoot, a));
  const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf') && documentKind(manifestKind.get(f), f) === 'cv');
  const covers = files.filter((f) => COVER_TEXT.test(f) && artifactKindFromName(f) === 'cover');
  if (!row) return { pdfs, covers, suggestedPdf: null, suggestedCover: null };
  const slug = companySlug(row.company);
  const named = (f: string) => namesCompany(slug, f);
  return { pdfs, covers, suggestedPdf: suggestCv(index, pdfs, row.report) ?? pdfs.find(named) ?? null, suggestedCover: covers.find(named) ?? null };
}

/** The manifest's CV for the report (its last row is the newest), else the highest tailored version in the report's bundle. */
function suggestCv(index: PdfIndexRow[], pdfs: string[], report: number | null): string | undefined {
  if (report === null) return undefined;
  const indexed = index.filter((r) => r.report === report && pdfs.includes(r.pdf)).at(-1)?.pdf;
  if (indexed) return indexed;
  let best: { path: string; version: number } | undefined;
  for (const f of pdfs) {
    const m = f.match(TAILORED_CV);
    if (!m || Number(m[1]) !== report) continue;
    if (!best || Number(m[2]) > best.version) best = { path: f, version: Number(m[2]) };
  }
  return best?.path;
}
