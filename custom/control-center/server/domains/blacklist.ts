// data/blacklist.md in the templates/blacklist.example.md format: a preamble
// and one table with Company, Since, Scope and Reason columns. Legacy tables
// (Company, Reason, Added) are read and rewritten into that format on save.
// The text around the table (notes) is kept byte for byte, and columns the
// editor does not manage are carried through per row, in order. scan.mjs
// blocks every `|` line in the file, wherever it is, so a row the table does
// not hold (after a blank line, in a second table) is listed too, read as the
// scanner reads it, and a save moves it into the table.
import fs from 'node:fs';
import path from 'node:path';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';
import { z } from 'zod';
import { etagOf } from './files.js';

export const BLACKLIST_REL = 'data/blacklist.md';

export const BLACKLIST_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `since` is checked by the route: YYYY-MM-DD for new rows, while a legacy cell already in the file passes through as is. */
export const blacklistRowSchema = z.object({
  company: z.string().min(1).max(200).regex(/^[^|\r\n]+$/, 'no pipes or line breaks'),
  since: z.string().max(40).regex(/^[^|\r\n]*$/, 'no pipes or line breaks'),
  scope: z.enum(['company', 'domain']),
  reason: z.string().max(500).regex(/^[^|\r\n]*$/, 'no pipes or line breaks'),
  /** Cells of the file's other columns (BlacklistParsed.extraColumns), in order; only present when the file has some. */
  extra: z.array(z.string().max(500).regex(/^[^|\r\n]*$/, 'no pipes or line breaks')).max(50).optional(),
});
export type BlacklistRow = z.infer<typeof blacklistRowSchema>;

export interface BlacklistParsed {
  rows: BlacklistRow[];
  /** Text before the table (kept verbatim on save); null when the file has none. */
  preamble: string | null;
  /** Everything after the table (kept verbatim on save); '' when the table ends the file. */
  postamble: string;
  /** Header names of columns other than Company, Since, Scope and Reason, in file order. */
  extraColumns: string[];
}

export interface BlacklistRead extends BlacklistParsed {
  kind: 'ok' | 'missing';
  path: string;
  raw: string;
  etag: string | null;
}

export const DEFAULT_BLACKLIST_PREAMBLE = `# Blacklist

Companies and ATS hosts the scanner must skip. Scope is \`company\` (match the feed's
company label) or \`domain\` (match the posting URL hostname as a suffix, for example
\`ibm.com\`). Edited from the Control Center blacklist editor, which always asks first.
`;

const splitCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const TABLE_LINE = /^\s*\|/;

/**
 * A `|` line outside the table, read as scan.mjs parseBlacklist reads every one: Company, Since, Scope, Reason by
 * position. Null for what it skips: a separator, a header (first cell Company), a line with no company.
 */
function scannerRow(line: string, extraColumns: number): BlacklistRow | null {
  const cells = splitCells(line);
  const company = cells[0] ?? '';
  if (!company || /^[-: ]+$/.test(company) || company.toLowerCase() === 'company') return null;
  return {
    company,
    since: cells[1] ?? '',
    scope: (cells[2] || 'company').toLowerCase() === 'domain' ? 'domain' : 'company',
    reason: cells[3] ?? '',
    ...(extraColumns ? { extra: Array.from({ length: extraColumns }, () => '') } : {}),
  };
}

/** Text around the table without its `|` lines, and the rows the scanner reads from them. Untouched when it has none. */
function outsideTable(lines: string[], extraColumns: number): { text: string; rows: BlacklistRow[] } {
  if (!lines.some((l) => TABLE_LINE.test(l))) return { text: lines.join('\n'), rows: [] };
  const rows = lines.filter((l) => TABLE_LINE.test(l)).map((l) => scannerRow(l, extraColumns)).filter((r): r is BlacklistRow => r !== null);
  // The removed lines leave their blank neighbours behind: at most one blank line in a row, and none at the end.
  const text = lines.filter((l) => !TABLE_LINE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
  return { text, rows };
}

export function parseBlacklist(md: string): BlacklistParsed {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /company/i.test(l));
  if (headerIdx === -1) return { rows: [], preamble: md.trim() ? md : null, postamble: '', extraColumns: [] };
  const headerCells = splitCells(lines[headerIdx]!);
  const header = headerCells.map((h) => h.toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  // Found the way the header line is ("Company", "Company name"): an exact-only match would read no rows, and the next save would drop them all.
  const iCompany = col(['company']) >= 0 ? col(['company']) : header.findIndex((h) => h.includes('company'));
  const iSince = col(['since', 'added', 'date']);
  const iScope = col(['scope']);
  const iReason = col(['reason', 'notes', 'why']);
  const known = new Set([iCompany, iSince, iScope, iReason]);
  const extraIdx = headerCells.map((_, i) => i).filter((i) => !known.has(i));
  const rows: BlacklistRow[] = [];
  // A markdown table ends at its first line that is not a row (a blank line included).
  let end = headerIdx + 1;
  while (end < lines.length && /^\s*\|/.test(lines[end]!)) end++;
  for (const line of lines.slice(headerIdx + 1, end)) {
    const cells = splitCells(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const scopeRaw = iScope >= 0 ? (cells[iScope] ?? '').toLowerCase() : '';
    rows.push({
      company: cells[iCompany] ?? '',
      since: iSince >= 0 ? (cells[iSince] ?? '') : '',
      scope: scopeRaw === 'domain' ? 'domain' : 'company',
      reason: iReason >= 0 ? (cells[iReason] ?? '') : '',
      ...(extraIdx.length ? { extra: extraIdx.map((i) => cells[i] ?? '') } : {}),
    });
  }
  const before = outsideTable(lines.slice(0, headerIdx), extraIdx.length);
  const after = outsideTable(lines.slice(end), extraIdx.length);
  return { rows: [...before.rows, ...rows.filter((r) => r.company), ...after.rows], preamble: before.text.trim() ? before.text : null, postamble: after.text, extraColumns: extraIdx.map((i) => headerCells[i]!) };
}

export function renderBlacklist(rows: BlacklistRow[], preamble: string | null, postamble = '', extraColumns: string[] = []): string {
  const head = (preamble ?? DEFAULT_BLACKLIST_PREAMBLE).trimEnd();
  const extraHead = extraColumns.map((c) => ` ${c} |`).join('');
  const extraRule = extraColumns.map(() => '---|').join('');
  const extraCells = (r: BlacklistRow) => extraColumns.map((_, i) => ` ${r.extra?.[i] ?? ''} |`).join('');
  const table = [`| Company | Since | Scope | Reason |${extraHead}`, `|---------|-------|-------|--------|${extraRule}`, ...rows.map((r) => `| ${r.company} | ${r.since} | ${r.scope} | ${r.reason} |${extraCells(r)}`)];
  return `${head}\n\n${table.join('\n')}\n${postamble}`;
}

export function readBlacklist(dataRoot: string): BlacklistRead {
  const abs = path.join(dataRoot, BLACKLIST_REL);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    return { kind: 'ok', path: BLACKLIST_REL, raw, etag: etagOf(raw), ...parseBlacklist(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: BLACKLIST_REL, raw: '', etag: null, rows: [], preamble: null, postamble: '', extraColumns: [] };
    throw err;
  }
}

/** Atomic write of the rendered table; the caller has already checked the ETag and the explicit gate. */
export function writeBlacklist(dataRoot: string, rows: BlacklistRow[], preamble: string | null, postamble = '', extraColumns: string[] = []): BlacklistRead {
  writeFileAtomic(path.join(dataRoot, BLACKLIST_REL), renderBlacklist(rows, preamble, postamble, extraColumns), dataRootOnly(dataRoot));
  return readBlacklist(dataRoot);
}
