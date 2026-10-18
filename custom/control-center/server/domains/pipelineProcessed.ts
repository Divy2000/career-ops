// A completed evaluation leaves the pipeline's Pending section, by the rule pipeline mode states (modes/pipeline.md,
// Workflow 2f): "Only a completed evaluation moves from Pending to Processed:
// `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`". The section handling (EN/ES headers, a row already in
// Processed, a missing Processed section, newest first under the header) follows reconcile-pipeline.mjs, the upstream
// script that makes the same move for batch-runner's evaluations.
import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../core/adapter.js';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';
import { readReportFile, reportNumberOf } from './reports.js';
import { inside } from '../lib/paths.js';
import { isProcessedHeading, pipelineSection, processedHeadingFor, unescapeMarkdownUrl } from './inboxSkip.js';
import { trailingLabelRun } from './pipeline.js';
import { dedupUrlKey } from '../../shared/dedup-url.js';

const HEADING_RE = /^##\s+(.+?)\s*$/;
const headingTitle = (line: string): string | null => line.match(HEADING_RE)?.[1] ?? null;
const SECTION_RE = /^##\s+/;
// An open row as parsePipeline reads one (indented or loosely spaced): `[ ]`, or `[!]` for a URL that waits for its JD
// text, which a completed evaluation also moves (modes/pipeline.md, Workflow 2f).
const OPEN_ITEM_RE = /^\s*-\s*\[([ !])\]\s*/;
const STRUCK = /^~~([\s\S]*?)(?:~~|$)/;

export interface EvaluatedPosting {
  /** The report number as its file name writes it ("042"). */
  report: string;
  /** From the report, for a bare pasted URL whose row names neither. */
  company: string;
  role: string;
  score: number | null;
  /** True when the report's **PDF:** header says the PDF was generated (see pdfGenerated). */
  pdf: boolean;
}

/**
 * True when the report's **PDF:** header names a .pdf file that exists inside the data root (links resolved), or is the
 * bare mark the tr, zh and zh-TW modes write (`**PDF:** ✅`). The header is otherwise free text: "pending" before the
 * CV is built, or "not generated" in the report's own language.
 */
export function pdfGenerated(header: string | null, dataRoot: string): boolean {
  if (!header) return false;
  if (header.trim() === '✅') return true;
  const root = fs.realpathSync(dataRoot);
  for (const [token] of header.matchAll(/[^\s`'"()<>[\]|]+\.pdf\b/gi)) {
    // A token the filesystem cannot resolve (missing, a name over 255 characters, a symlink loop, no permission) names
    // no generated PDF; it must not stop the row's move to Processed.
    try {
      const real = fs.realpathSync(path.resolve(root, token));
      if (inside(root, real) && fs.statSync(real).isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * The key a row's URL matches the evaluated posting by: dedupUrlKey for a web URL, the one sessions and
 * POST /api/pipeline/add dedup postings by, so a twin (tracking params, a trailing slash, host case) is the same row. A
 * local:jds/ path is a file name, matched as written.
 */
const postingKey = (url: string): string => (/^https?:\/\//i.test(url) ? dedupUrlKey(url) : url);

/** "{url} | company | role" to "{url}". A `[!]` row notes its error after the URL, so only its first word is the URL. */
function lineUrl(body: string, flagged: boolean): string {
  const cell = body.split('|')[0]!.trim();
  return flagged ? (cell.split(/\s+/)[0] ?? '') : cell;
}

function scoreCell(score: number | null): string {
  if (score === null || !Number.isFinite(score) || score < 0 || score > 5) return 'N/A';
  return `${Number.isInteger(score) ? score.toFixed(1) : String(score)}/5`;
}

/**
 * scan.mjs sanitizeMarkdownField, for the report's own company and role: one line, `\`, `[` and `]` backslashed, and a
 * `|` written as `/` so it cannot open another cell. The row's own cells were written that way already.
 */
function markdownField(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/\|/g, '/');
}

/** Moves the Pending row(s) for `url` to Processed; every other line stays as written. */
export function moveToProcessed(text: string, url: string, posting: EvaluatedPosting): { text: string; moved: boolean } {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const endedWithNl = lines.length > 1 && lines[lines.length - 1] === '';
  if (endedWithNl) lines.pop();
  // The Pending and Processed headings of any shipped mode language; a new Processed section takes the Pending one's.
  const pendStart = lines.findIndex((l) => processedHeadingFor(headingTitle(l) ?? '') !== null);
  if (pendStart < 0) return { text, moved: false };
  const procStart = lines.findIndex((l) => isProcessedHeading(headingTitle(l) ?? ''));
  const sectionEnd = (start: number) => {
    for (let i = start + 1; i < lines.length; i++) if (SECTION_RE.test(lines[i]!)) return i;
    return lines.length;
  };
  const listed = new Set<string>();
  if (procStart >= 0) {
    for (let i = procStart + 1; i < sectionEnd(procStart); i++) {
      const m = lines[i]!.match(/^- \[x\]\s+(.+)$/i);
      const cell = m?.[1]!.split('|').map((s) => s.trim())[1];
      if (cell) listed.add(postingKey(unescapeMarkdownUrl(cell)));
    }
  }
  // Rows hold the URL as scan.mjs escaped it ([, ] and \ backslashed); callers pass the posting URL.
  const target = postingKey(unescapeMarkdownUrl(url));
  const remove = new Set<number>();
  let processedLine: string | null = null;
  // scan.mjs appends a row under its own `## Pending` heading when the file's Pending heading is not English or
  // Spanish, so the row can sit in any section but Processed; parsePipeline reads every non-Processed section as
  // pending, so the match spans them all.
  let section: 'pending' | 'done' | 'other' = 'other';
  for (let i = 0; i < lines.length; i++) {
    const title = headingTitle(lines[i]!);
    if (title !== null) {
      section = pipelineSection(title);
      continue;
    }
    if (section === 'done') continue;
    const open = lines[i]!.match(OPEN_ITEM_RE);
    if (!open) continue;
    // A restored expired row keeps its strike (`~~URL | Company | Role~~ <dash> posting expired`): read inside it.
    const rest = lines[i]!.replace(OPEN_ITEM_RE, '');
    const body = rest.match(STRUCK)?.[1] ?? rest;
    const cell = lineUrl(body, open[1] === '!');
    if (postingKey(unescapeMarkdownUrl(cell)) !== target) continue;
    remove.add(i);
    if (listed.has(target) || processedLine !== null) continue;
    // Company and role are the positional cells after the URL: a rank, posted, trust or note segment a writer appended
    // (rank-pipeline.mjs puts the rank right after a bare URL) is not one, so the report's own values stand in. Labels
    // are only the trailing run the Pipeline page reads as labels, so a company or role that reads like one stays. A
    // label right after a lone company is still a label here, where the page shows it as the title: the report's role
    // is the better title to write.
    const cells = body.split('|').map((s) => s.trim());
    const parts = cells.slice(0, trailingLabelRun(cells));
    processedLine = `- [x] #${posting.report} | ${cell} | ${parts[1] || markdownField(posting.company)} | ${parts[2] || markdownField(posting.role)} | ${scoreCell(posting.score)} | PDF ${posting.pdf ? '✅' : '❌'}`;
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
    out.push(`## ${processedHeadingFor(headingTitle(lines[pendStart]!)!)}`, '', processedLine);
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
  const num = reportNumberOf(reportFile);
  if (num === null) throw new Error(`not a numbered report file: ${reportFile}`);
  const report = reportFile.match(/^\d+/)![0];
  const read = readReportFile(dataRoot, reportFile);
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
