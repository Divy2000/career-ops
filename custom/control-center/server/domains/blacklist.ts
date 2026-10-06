// data/blacklist.md in the templates/blacklist.example.md format: a preamble
// and one table with Company, Since, Scope and Reason columns. scan.mjs reads
// every row by position (Company, Since, Scope, Reason), whatever its header
// says, so the editor does too: a table whose header names other columns at
// those positions (the legacy Company, Reason, Added included) is shown as the
// scanner reads it, with a warning, and rewritten into that order on save. A
// third column that is not Scope is kept as a column of its own on save, since
// the scanner reads its cells only as a scope.
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
  /** Why the table's header does not match the positions the scanner reads; null when it does. */
  columnWarning: string | null;
  /** Cells of listed rows that have no column to go to (a row wider than the table, a scope that is neither company nor domain): a save would drop them, so it is refused. */
  unkept: string[];
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
 * A `|` line read as scan.mjs parseBlacklist reads every one: Company, Since, Scope, Reason by position. Null for what
 * it skips: a separator, a header (first cell Company), a line with no company.
 */
function scannerRow(line: string, extra: string[] = []): BlacklistRow | null {
  const cells = splitCells(line);
  const company = cells[0] ?? '';
  if (!company || /^[-: ]+$/.test(company) || company.toLowerCase() === 'company') return null;
  return {
    company,
    since: cells[1] ?? '',
    scope: (cells[2] || 'company').toLowerCase() === 'domain' ? 'domain' : 'company',
    reason: cells[3] ?? '',
    ...(extra.length ? { extra } : {}),
  };
}

// The header names each position the scanner reads may have (the first only has to mention Company).
const POSITIONS: Array<{ label: string; fits: (h: string) => boolean }> = [
  { label: 'Company', fits: (h) => h.includes('company') },
  { label: 'Since', fits: (h) => ['since', 'added', 'date'].includes(h) },
  { label: 'Scope', fits: (h) => h === 'scope' },
  { label: 'Reason', fits: (h) => ['reason', 'notes', 'why'].includes(h) },
];
const MANAGED = new Set(['company', 'since', 'scope', 'reason']);

/** Text around the table without its `|` lines, and the rows the scanner reads from them. Untouched when it has none. */
function outsideTable(lines: string[], read: (line: string) => BlacklistRow | null): { text: string; rows: BlacklistRow[] } {
  if (!lines.some((l) => TABLE_LINE.test(l))) return { text: lines.join('\n'), rows: [] };
  const rows = lines.filter((l) => TABLE_LINE.test(l)).map(read).filter((r): r is BlacklistRow => r !== null);
  // The removed lines leave their blank neighbours behind: at most one blank line in a row, and none at the end.
  const text = lines.filter((l) => !TABLE_LINE.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
  return { text, rows };
}

export function parseBlacklist(md: string): BlacklistParsed {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /company/i.test(l));
  if (headerIdx === -1) return { rows: [], preamble: md.trim() ? md : null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] };
  const headerCells = splitCells(lines[headerIdx]!);
  const header = headerCells.map((h) => h.toLowerCase());
  const misplaced = POSITIONS.some((p, i) => i < header.length && !p.fits(header[i]!));
  const columnWarning = misplaced
    ? `The table's header is "${headerCells.join(' | ')}", but the scanner reads every row by position as Company, Since, Scope, Reason. The rows are shown as it reads them; saving rewrites the header in that order.`
    : null;
  // The scanner reads the third column only as a scope (anything but domain is company): any other column there is
  // kept, under its own name, beside the ones the editor manages.
  const keepThird = header.length > 2 && header[2] !== 'scope';
  const thirdName = keepThird ? (MANAGED.has(header[2]!) ? `${headerCells[2]} (old column 3)` : headerCells[2]!) : null;
  const extraColumns = [...(thirdName !== null ? [thirdName] : []), ...headerCells.slice(4)];
  // Every listed row, in the table or not, is read by position: its cells after Reason fill the table's own columns.
  const unkept: string[] = [];
  const read = (line: string, isHeader = false): BlacklistRow | null => {
    const cells = splitCells(line);
    const row = scannerRow(line, [...(keepThird ? [cells[2] ?? ''] : []), ...headerCells.slice(4).map((_, i) => cells[4 + i] ?? '')]);
    if (!row || isHeader) return row;
    const lost = cells.filter((c, i) => c !== '' && (i >= Math.max(4, headerCells.length) || (i === 2 && !keepThird && !['company', 'domain'].includes(c.toLowerCase()))));
    if (lost.length) unkept.push(`${row.company} (${lost.join(', ')})`);
    return row;
  };
  // A markdown table ends at its first line that is not a row (a blank line included).
  let end = headerIdx + 1;
  while (end < lines.length && /^\s*\|/.test(lines[end]!)) end++;
  const before = outsideTable(lines.slice(0, headerIdx), (l) => read(l));
  // The scanner skips a header only when its first cell is exactly Company: "| Company Name | ... |" is an entry it
  // blocks, so it is listed (a save writes the column names again above it; its own labels are no data to keep).
  const headerRow = read(lines[headerIdx]!, true);
  const rows = [...(headerRow ? [headerRow] : []), ...lines.slice(headerIdx + 1, end).map((l) => read(l))].filter((r): r is BlacklistRow => r !== null);
  const after = outsideTable(lines.slice(end), (l) => read(l));
  return { rows: [...before.rows, ...rows, ...after.rows], preamble: before.text.trim() ? before.text : null, postamble: after.text, extraColumns, columnWarning, unkept };
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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: BLACKLIST_REL, raw: '', etag: null, rows: [], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] };
    throw err;
  }
}

/** Atomic write of the rendered table; the caller has already checked the ETag and the explicit gate. */
export function writeBlacklist(dataRoot: string, rows: BlacklistRow[], preamble: string | null, postamble = '', extraColumns: string[] = []): BlacklistRead {
  writeFileAtomic(path.join(dataRoot, BLACKLIST_REL), renderBlacklist(rows, preamble, postamble, extraColumns), dataRootOnly(dataRoot));
  return readBlacklist(dataRoot);
}
