import path from 'node:path';
import { parseTsv, readText } from './files.js';

export interface PipelineRow {
  url: string;
  company: string;
  role: string;
  location: string | null;
  compensation: string | null;
  done: boolean;
  section: 'pending' | 'done' | 'other';
  postedAt: string | null;
  rank: number | null;
  rankReason: string | null;
  note: string | null;
  firstSeen: string | null;
  source: string;
  seniority: string | null;
  line: number;
}

export type PipelineRead = { kind: 'missing'; path: string } | { kind: 'ok'; path: string; rows: PipelineRow[]; etag: string };

const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;
const LABELED = /^([a-z][\w-]*):\s*(.*)$/i;
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const RANK_DASH = `(?:[-:]|${EN_DASH}|${EM_DASH})`;
// `rank: 3.2/5 <dash> reason`; the dash written by rank-pipeline is U+2014, hand edits use - or :.
const RANK_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*\\/\\s*5\\s*${RANK_DASH}?\\s*(.*)$`);
// Labeled segments ride on any row shape, so on a bare URL row they sit where company and title go. There a cell is a
// label only in the exact form a writer emits it: scan.mjs formatPipelineOffer (`posted: YYYY-MM-DD`,
// `trust: <score>[ flag,flag]`, `note: <text>`) and rank-pipeline.mjs formatRankSegment (`rank: <n>/5 <dash> <reason>`).
// So a company or title like `Rank: Senior Engineer` or `posted: soon` stays text, and so does a location such as
// `Remote: US` (scan.mjs keeps colons in it): only those written forms are labels, in any column.
const WRITTEN_SEGMENT = new RegExp(`^(?:posted: \\d{4}-\\d{2}-\\d{2}|trust: \\d{1,3}(?: [a-z_]+(?:,[a-z_]+)*)?|note: \\S.*|rank: \\d+(?:\\.\\d+)?\\/5(?:\\s*${RANK_DASH}\\s*\\S.*)?)$`);

export function seniorityOf(title: string): string | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|associate|graduate|new grad)\b/.test(t)) return 'junior';
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(lead|head of|director|manager)\b/.test(t)) return 'lead';
  if (/\b(senior|sr\.?|iii|iv)\b/.test(t)) return 'senior';
  if (/\b(ii)\b/.test(t)) return 'mid';
  return null;
}

export function sourceOf(url: string, portal: string | null): string {
  if (portal) return portal.replace(/-full$/, '').replace(/-api$/, '');
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const known: Array<[RegExp, string]> = [
      [/greenhouse\.io$/, 'greenhouse'],
      [/lever\.co$/, 'lever'],
      [/ashbyhq\.com$/, 'ashby'],
      [/myworkdayjobs\.com$/, 'workday'],
      [/smartrecruiters\.com$/, 'smartrecruiters'],
      [/linkedin\.com$/, 'linkedin'],
    ];
    for (const [re, name] of known) if (re.test(host)) return name;
    return host;
  } catch {
    return 'other';
  }
}

export function parseRankCell(cell: string): { rank: number | null; reason: string | null } {
  const m = cell.match(RANK_RE);
  if (!m) return { rank: null, reason: cell.trim() || null };
  const reason = m[2]!.trim();
  return { rank: Number(m[1]), reason: reason || null };
}

export function parsePipeline(md: string): PipelineRow[] {
  const rows: PipelineRow[] = [];
  let section: PipelineRow['section'] = 'other';
  md.split('\n').forEach((line, i) => {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const t = h[1]!.toLowerCase();
      section = /^(pending|pendientes)/.test(t) ? 'pending' : /^(done|hecho|processed|procesadas)/.test(t) ? 'done' : 'other';
      return;
    }
    const m = line.match(CHECKBOX_RE);
    if (!m) return;
    const cells = m[2]!.split('|').map((s) => s.trim());
    const positional: string[] = [];
    const labels = new Map<string, string>();
    cells.forEach((cell, idx) => {
      const lm = idx >= 1 && WRITTEN_SEGMENT.test(cell) ? cell.match(LABELED) : null;
      if (lm) labels.set(lm[1]!.toLowerCase(), lm[2]!.trim());
      else positional.push(cell);
    });
    // Upstream rows are 1 to 5 columns: a bare pasted URL is valid, its company and role are just unknown.
    if (!/^https?:\/\//i.test(positional[0]!)) return;
    const rankCell = labels.get('rank');
    const { rank, reason } = rankCell ? parseRankCell(rankCell) : { rank: null, reason: null };
    const posted = labels.get('posted');
    rows.push({
      url: positional[0]!,
      company: positional[1] ?? '',
      role: positional[2] ?? '',
      location: positional[3] || null,
      compensation: positional[4] || null,
      done: m[1]!.toLowerCase() === 'x',
      section,
      postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : null,
      rank,
      rankReason: reason,
      note: labels.get('note') ?? null,
      firstSeen: null,
      source: 'other',
      seniority: seniorityOf(positional[2] ?? ''),
      line: i + 1,
    });
  });
  return rows;
}

export interface ScanHistoryRow {
  url: string;
  firstSeen: string;
  portal: string;
  title: string;
  company: string;
  status: string;
  location: string;
  postedAt: string;
}

/** The leading columns scan.mjs formatScanHistoryRow writes, in order; a legacy file has no header row naming them. */
const SCAN_HISTORY_COLUMNS = ['url', 'first_seen', 'portal', 'title', 'company', 'status', 'location', 'fingerprint', 'posted_at'];

export function readScanHistory(dataRoot: string): ScanHistoryRow[] {
  const read = readText(path.join(dataRoot, 'data', 'scan-history.tsv'));
  if (read.kind !== 'ok') return [];
  // scan.mjs writes the header only on a fresh file and never rewrites an old headerless one.
  const text = read.text.startsWith('url\t') ? read.text : `${SCAN_HISTORY_COLUMNS.join('\t')}\n${read.text}`;
  return parseTsv(text).map((r) => ({
    url: r.url ?? '',
    firstSeen: r.first_seen ?? '',
    portal: r.portal ?? '',
    title: r.title ?? '',
    company: r.company ?? '',
    status: r.status ?? '',
    location: r.location ?? '',
    postedAt: r.posted_at ?? '',
  }));
}

export function readPipeline(dataRoot: string): PipelineRead {
  const p = path.join(dataRoot, 'data', 'pipeline.md');
  const read = readText(p);
  if (read.kind === 'missing') return { kind: 'missing', path: p };
  const history = new Map(readScanHistory(dataRoot).map((r) => [r.url, r]));
  const rows = parsePipeline(read.text).map((row) => {
    const h = history.get(row.url);
    return { ...row, firstSeen: h?.firstSeen || null, source: sourceOf(row.url, h?.portal || null) };
  });
  return { kind: 'ok', path: p, rows, etag: read.etag };
}
