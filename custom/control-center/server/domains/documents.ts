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
}

export interface DocumentsRead {
  files: DocumentFile[];
  jds: string[];
  indexPresent: boolean;
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

export function companySlug(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

/** PDFs from the index for report n first, then output/ files matching the company, newest first. */
export function readDocuments(dataRoot: string, n: number, company: string): DocumentsRead {
  const indexPath = path.join(dataRoot, 'data', 'pdf-index.tsv');
  const indexPresent = fs.existsSync(indexPath);
  const rows = indexPresent ? parsePdfIndex(fs.readFileSync(indexPath, 'utf8')) : [];
  const files: DocumentFile[] = [];
  const seen = new Set<string>();
  for (const r of rows.filter((x) => x.report === n)) {
    if (seen.has(r.pdf)) continue;
    seen.add(r.pdf);
    files.push({ path: r.pdf, html: r.html && exists(dataRoot, r.html) ? r.html : null, kind: r.kind === 'cover' ? 'cover' : 'cv', format: r.format || null, date: r.date || null, source: 'index' });
  }
  const slug = companySlug(company);
  const outDir = path.join(dataRoot, 'output');
  if (slug && fs.existsSync(outDir)) {
    for (const name of fs.readdirSync(outDir)) {
      if (!name.toLowerCase().endsWith('.pdf') || !name.toLowerCase().includes(slug)) continue;
      const rel = `output/${name}`;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const twin = `output/${name.slice(0, -4)}.html`;
      files.push({ path: rel, html: exists(dataRoot, twin) ? twin : null, kind: /cover/i.test(name) ? 'cover' : 'cv', format: null, date: null, source: 'output' });
    }
  }
  files.sort((a, b) => mtime(dataRoot, b.path) - mtime(dataRoot, a.path));
  const jdsDir = path.join(dataRoot, 'jds');
  const prefix = String(n).padStart(3, '0');
  const jds = fs.existsSync(jdsDir) ? fs.readdirSync(jdsDir).filter((f) => f.startsWith(`${prefix}-`) || (slug && f.toLowerCase().includes(slug))).map((f) => `jds/${f}`) : [];
  return { files, jds, indexPresent };
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

const COVER_NAME = /cover/i;
const COVER_TEXT = /\.(txt|md)$/i;

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

/** What the Apply page can attach: every CV PDF and text cover under output/, plus the tailored CV for tracker row n when one is known. */
export function readApplyDocuments(dataRoot: string, row: { num: number; company: string } | null): ApplyDocuments {
  const files = walkOutput(dataRoot).sort((a, b) => mtime(dataRoot, b) - mtime(dataRoot, a));
  const pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf') && !COVER_NAME.test(path.basename(f)));
  const covers = files.filter((f) => COVER_TEXT.test(f) && COVER_NAME.test(path.basename(f)));
  if (!row) return { pdfs, covers, suggestedPdf: null, suggestedCover: null };
  const cvs = readDocuments(dataRoot, row.num, row.company).files.filter((f) => f.kind === 'cv' && pdfs.includes(f.path));
  const suggestedPdf = (cvs.find((f) => f.source === 'index') ?? cvs[0])?.path ?? null;
  const slug = companySlug(row.company);
  const suggestedCover = (slug && covers.find((c) => path.basename(c).toLowerCase().includes(slug))) || null;
  return { pdfs, covers, suggestedPdf, suggestedCover };
}
