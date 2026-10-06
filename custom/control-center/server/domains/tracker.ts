import path from 'node:path';
import { importCore } from '../core/adapter.js';
import { readText } from './files.js';
import { parseScore, postingUrl, readReport, summaryOf, type ReportSummary } from './reports.js';
import { parseFollowups } from './followups.js';
import { statusLabeler } from './insights.js';

export const STATUS_ORDER = ['Interview', 'Offer', 'Hired', 'Responded', 'Applied', 'Evaluated', 'Rejected', 'Discarded', 'SKIP'] as const;
export type TrackerStatus = (typeof STATUS_ORDER)[number];

export interface TrackerRow {
  num: number;
  date: string;
  company: string;
  role: string;
  score: number | null;
  scoreRaw: string;
  /** The states.yml label (any case, bold or alias resolved, as set-status.mjs does); a status it does not know stays as written. */
  status: string;
  pdf: boolean;
  pdfRaw: string;
  report: number | null;
  /** The Report cell's first digit run as written ("012"): hired-share.mjs matches rows by this text, not the number. */
  reportLabel: string | null;
  notes: string;
  location: string | null;
  url: string | null;
  posted: string | null;
  lastContact: string | null;
  summary: ReportSummary | null;
  reportState: 'ok' | 'missing' | 'reserved' | 'malformed' | 'none';
}

export type TrackerRead =
  | { kind: 'missing'; path: string }
  | { kind: 'malformed'; path: string; error: string }
  | { kind: 'ok'; path: string; rows: TrackerRow[]; etag: string };

interface TrackerParse {
  resolveColumns: (lines: string[]) => Record<string, number>;
  parseTrackerRow: (line: string, colmap: Record<string, number>) => Record<string, string> & { num: number } | null;
  extractTrackerReportNumbers: (reportCell: string, notesCell?: string) => number[];
  isSeparatorRow: (line: string) => boolean;
  isHeaderRow: (line: string) => boolean;
}
interface PathResolver {
  resolveTrackerPath: (root: string) => string;
}

export function postedFromNotes(notes: string): string | null {
  return notes.match(/posted:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
}

export function pdfPresent(cell: string): boolean {
  const v = cell.trim();
  // merge-tracker.mjs writes ❌ for "no PDF yet" (and flips it to ✅ when one is generated).
  return v !== '' && v !== '-' && v !== String.fromCharCode(0x2014) && v !== '❌' && !/^(no|pending|n\/a)$/i.test(v);
}

export async function readTracker(codeRoot: string, dataRoot: string): Promise<TrackerRead> {
  const [tp, pr, label] = await Promise.all([importCore<TrackerParse>(codeRoot, 'tracker-parse.mjs'), importCore<PathResolver>(codeRoot, 'path-resolver.mjs'), statusLabeler(codeRoot)]);
  const trackerPath = pr.resolveTrackerPath(dataRoot);
  const read = readText(trackerPath);
  if (read.kind === 'missing') return { kind: 'missing', path: trackerPath };
  const lines = read.text.split('\n');
  const colmap = tp.resolveColumns(lines);
  const dataLines = lines.filter((l) => l.startsWith('|') && !tp.isSeparatorRow(l));
  if (dataLines.length === 0) return { kind: 'malformed', path: trackerPath, error: 'no markdown table found' };
  const lastContact = lastContactByApp(dataRoot);
  const rows: TrackerRow[] = [];
  for (const line of dataLines) {
    const raw = tp.parseTrackerRow(line, colmap);
    if (!raw) continue;
    const reportNums = tp.extractTrackerReportNumbers(raw.report ?? '', raw.notes ?? '');
    const reportNum = reportNums[0] ?? null;
    let summary: ReportSummary | null = null;
    let reportState: TrackerRow['reportState'] = 'none';
    if (reportNum !== null) {
      const rr = readReport(dataRoot, reportNum);
      reportState = rr.kind;
      if (rr.kind === 'ok') summary = summaryOf(rr.report);
    }
    rows.push({
      num: raw.num,
      date: raw.date ?? '',
      company: raw.company ?? '',
      role: raw.role ?? '',
      score: parseScore(raw.score) ?? summary?.score ?? null,
      scoreRaw: raw.score ?? '',
      status: label(raw.status ?? ''),
      pdf: pdfPresent(raw.pdf ?? ''),
      pdfRaw: raw.pdf ?? '',
      report: reportNum,
      reportLabel: reportNum === null ? null : (raw.report ?? '').match(/\d+/)?.[0] ?? null,
      notes: raw.notes ?? '',
      location: raw.location ?? null,
      // The URL column (merge-tracker.mjs --backfill-urls) only when its cell is a real posting URL: a later addition with
      // no url leaves it empty, and a hand-typed N/A is no link. Otherwise the report's own URL, as with no column.
      url: postingUrl(raw.url) ?? summary?.url ?? null,
      posted: postedFromNotes(raw.notes ?? ''),
      lastContact: lastContact.get(raw.num) ?? null,
      summary,
      reportState,
    });
  }
  // A header and separator with no rows is a new user's valid empty tracker; only unparseable data lines are malformed.
  const dataRowLines = dataLines.filter((l) => !tp.isHeaderRow(l));
  if (rows.length === 0 && dataRowLines.length > 0) return { kind: 'malformed', path: trackerPath, error: 'table has a header but no parseable rows' };
  return { kind: 'ok', path: trackerPath, rows, etag: read.etag };
}

function lastContactByApp(dataRoot: string): Map<number, string> {
  const read = readText(path.join(dataRoot, 'data', 'follow-ups.md'));
  const out = new Map<number, string>();
  if (read.kind !== 'ok') return out;
  for (const e of parseFollowups(read.text)) {
    const prev = out.get(e.appNum);
    if (!prev || e.date > prev) out.set(e.appNum, e.date);
  }
  return out;
}

export function statusRank(status: string): number {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status);
  return i === -1 ? STATUS_ORDER.length : i;
}
