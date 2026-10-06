// A completed evaluation leaves the pipeline's Pending section, by the rule pipeline mode states (modes/pipeline.md,
// Workflow 2f): "Only a completed evaluation moves from Pending to Processed:
// `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`". The section handling (EN/ES headers, a row already in
// Processed, a missing Processed section, newest first under the header) follows reconcile-pipeline.mjs, the upstream
// script that makes the same move for batch-runner's evaluations.
import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../core/adapter.js';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';
import { readReport } from './reports.js';
import { inside } from '../lib/paths.js';

const PENDING_RE = /^##\s+(Pendientes|Pending)\s*$/i;
const PROCESSED_RE = /^##\s+(Procesadas|Processed)\s*$/i;
const SECTION_RE = /^##\s+/;
const PENDING_ITEM_RE = /^- \[ \]\s+/;

export interface EvaluatedPosting {
  /** The report number as its file name writes it ("042"). */
  report: string;
  /** From the report, for a bare pasted URL whose row names neither. */
  company: string;
  role: string;
  score: number | null;
  /** True when the report's **PDF:** header names a generated PDF (see pdfGenerated). */
  pdf: boolean;
}

/**
 * True only when the report's **PDF:** header names a .pdf file that exists inside the data root (links resolved). The
 * header is otherwise free text: "pending" before the CV is built, or "not generated" in the report's own language.
 */
export function pdfGenerated(header: string | null, dataRoot: string): boolean {
  if (!header) return false;
  const root = fs.realpathSync(dataRoot);
  for (const [token] of header.matchAll(/[^\s`'"()<>[\]|]+\.pdf\b/gi)) {
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(root, token));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw err;
    }
    if (inside(root, real) && fs.statSync(real).isFile()) return true;
  }
  return false;
}

/** "{url} | company | role" to "{url}". */
function lineUrl(body: string): string {
  const i = body.indexOf(' |');
  return (i >= 0 ? body.slice(0, i) : body).trim();
}

function scoreCell(score: number | null): string {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 5) return 'N/A';
  return `${Number.isInteger(score) ? score.toFixed(1) : String(score)}/5`;
}

/** Moves the Pending row(s) for `url` to Processed; every other line stays as written. */
export function moveToProcessed(text: string, url: string, posting: EvaluatedPosting): { text: string; moved: boolean } {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const endedWithNl = lines.length > 1 && lines[lines.length - 1] === '';
  if (endedWithNl) lines.pop();
  const pendStart = lines.findIndex((l) => PENDING_RE.test(l));
  if (pendStart < 0) return { text, moved: false };
  const procStart = lines.findIndex((l) => PROCESSED_RE.test(l));
  const sectionEnd = (start: number) => {
    for (let i = start + 1; i < lines.length; i++) if (SECTION_RE.test(lines[i]!)) return i;
    return lines.length;
  };
  const listed = new Set<string>();
  if (procStart >= 0) {
    for (let i = procStart + 1; i < sectionEnd(procStart); i++) {
      const m = lines[i]!.match(/^- \[x\]\s+(.+)$/i);
      const cell = m?.[1]!.split('|').map((s) => s.trim())[1];
      if (cell) listed.add(cell);
    }
  }
  const remove = new Set<number>();
  let processedLine: string | null = null;
  for (let i = pendStart + 1; i < sectionEnd(pendStart); i++) {
    if (!PENDING_ITEM_RE.test(lines[i]!)) continue;
    const body = lines[i]!.replace(PENDING_ITEM_RE, '');
    if (lineUrl(body) !== url) continue;
    remove.add(i);
    if (listed.has(url) || processedLine !== null) continue;
    const parts = body.split('|').map((s) => s.trim());
    processedLine = `- [x] #${posting.report} | ${url} | ${parts[1] || posting.company} | ${parts[2] || posting.role} | ${scoreCell(posting.score)} | PDF ${posting.pdf ? '✅' : '❌'}`;
  }
  if (remove.size === 0) return { text, moved: false };
  const out: string[] = [];
  let skipBlankAfterProc = false;
  for (let i = 0; i < lines.length; i++) {
    if (remove.has(i)) continue;
    if (skipBlankAfterProc) {
      skipBlankAfterProc = false;
      if (lines[i]!.trim() === '') continue;
    }
    out.push(lines[i]!);
    if (i === procStart && processedLine) {
      out.push('', processedLine);
      skipBlankAfterProc = true;
    }
  }
  if (procStart < 0 && processedLine) {
    if (out.length && out[out.length - 1]!.trim() !== '') out.push('');
    out.push(PENDING_RE.exec(lines[pendStart]!)![1]!.toLowerCase() === 'pending' ? '## Processed' : '## Procesadas', '', processedLine);
  }
  return { text: out.join(nl) + (endedWithNl ? nl : ''), moved: true };
}

type PipelineLock = { withPipelineLock: <T>(p: string, fn: () => T | Promise<T>, o?: { timeoutMs?: number; retryMs?: number }) => Promise<T> };

/**
 * After an evaluation of `url` wrote report `reportFile`, moves its Pending row to Processed under the pipeline lock.
 * Returns false when the pipeline has no Pending row for that URL (a posting evaluated from elsewhere).
 */
export async function markPipelineEvaluated(codeRoot: string, dataRoot: string, url: string, reportFile: string): Promise<boolean> {
  const pipelinePath = path.join(dataRoot, 'data', 'pipeline.md');
  if (!fs.existsSync(pipelinePath)) return false;
  const report = reportFile.match(/^(\d+)-/)?.[1];
  if (!report) throw new Error(`not a numbered report file: ${reportFile}`);
  const read = readReport(dataRoot, parseInt(report, 10));
  const r = read.kind === 'ok' ? read.report : null;
  const posting: EvaluatedPosting = { report, company: r?.company ?? '', role: r?.role ?? '', score: r?.score ?? null, pdf: pdfGenerated(r?.pdf ?? null, dataRoot) };
  const { withPipelineLock } = await importCore<PipelineLock>(codeRoot, 'pipeline-lock.mjs');
  return withPipelineLock(
    pipelinePath,
    () => {
      const { text, moved } = moveToProcessed(fs.readFileSync(pipelinePath, 'utf8'), url, posting);
      if (moved) writeFileAtomic(pipelinePath, text, dataRootOnly(dataRoot));
      return moved;
    },
    { timeoutMs: 5000, retryMs: 50 },
  );
}
