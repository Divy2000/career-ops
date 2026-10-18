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

const CELL = /^[^|\r\n]*$/;

/**
 * Whether scan.mjs parseBlacklist (and this domain's reparse) reads a row with this first cell, trimmed, at all: it
 * skips a blank cell, a separator (only dashes, colons, spaces) and a header (Company), so a save must not write one.
 */
function scannerReadsCompany(company: string): boolean {
  const c = company.trim();
  return c !== '' && !/^[-: ]+$/.test(c) && c.toLowerCase() !== 'company';
}

/**
 * Lengths are capped by blacklistOverCap, not here: a cell already in the file passes through as is, whatever its
 * length, and `since` is checked by the route (YYYY-MM-DD for new rows, a legacy cell kept as it is). The number of
 * `extra` cells is bounded by the route against the file's own extra columns, so any table the editor loads stays savable.
 */
export const blacklistRowSchema = z.object({
  company: z
    .string()
    .min(1)
    .regex(/^[^|\r\n]+$/, 'no pipes or line breaks')
    .refine(scannerReadsCompany, 'the scanner skips a blank, dash-only or "Company" entry; name a company or host'),
  since: z.string().regex(CELL, 'no pipes or line breaks'),
  scope: z.enum(['company', 'domain']),
  reason: z.string().regex(CELL, 'no pipes or line breaks'),
  /** Cells of the file's other columns (BlacklistParsed.extraColumns), in order; only present when the file has some. */
  extra: z.array(z.string().regex(CELL, 'no pipes or line breaks')).optional(),
});
export type BlacklistRow = z.infer<typeof blacklistRowSchema>;

// `since` has no cap of its own: the route takes only a YYYY-MM-DD date or a value already in that column of the file.
const CAPS = { company: 200, reason: 500, extra: 500 } as const;

/**
 * The first cell of `rows` longer than its cap, unless that value is already in the same column of the file (a long
 * legacy note): a row the file holds would otherwise make every later save fail. Null when none.
 */
export function blacklistOverCap(rows: BlacklistRow[], existing: BlacklistRow[]): string | null {
  const company = new Set(existing.map((r) => r.company));
  const reason = new Set(existing.map((r) => r.reason));
  const extra = (i: number) => new Set(existing.map((r) => r.extra?.[i]));
  for (const r of rows) {
    if (r.company.length > CAPS.company && !company.has(r.company)) return `company ${r.company.slice(0, 80)}... is over ${CAPS.company} characters`;
    if (r.reason.length > CAPS.reason && !reason.has(r.reason)) return `reason of ${r.company.slice(0, 80)} is over ${CAPS.reason} characters`;
    const long = (r.extra ?? []).findIndex((c, i) => c.length > CAPS.extra && !extra(i).has(c));
    if (long !== -1) return `cell ${long + 1} after Reason of ${r.company.slice(0, 80)} is over ${CAPS.extra} characters`;
  }
  return null;
}

/** tracker-parse.mjs normalizeTextKey, which scan.mjs keys a company-scope row by (through normalizeCompany). */
export type NormalizeTextKey = (value: unknown, separator?: string) => string;

/**
 * The key scan.mjs parseBlacklist files a row under: `domain:` and the trimmed, lowercased host without a trailing dot
 * (its normalizeBlacklistDomain), or the normalized company. An empty value means the scanner skips the row.
 */
export function blacklistScannerKey(row: Pick<BlacklistRow, 'company' | 'scope'>, norm: NormalizeTextKey): { key: string; empty: boolean } {
  if (row.scope === 'domain') {
    const host = row.company.trim().toLowerCase().replace(/\.$/, '');
    return { key: `domain:${host}`, empty: host === '' };
  }
  const key = norm(row.company);
  return { key, empty: key === '' };
}

/**
 * The first row of `rows` the scanner would never read: one whose key is empty, or a second row under a key (the
 * scanner keeps the first). Rows like these the file already holds pass, so a save that leaves them as they are is not
 * refused: as many empty-key rows of a company and scope as the file holds, and as many rows per key as the file has.
 * Null when none.
 */
export function blacklistUnreadRow(rows: BlacklistRow[], existing: BlacklistRow[], norm: NormalizeTextKey): string | null {
  const id = (r: Pick<BlacklistRow, 'company' | 'scope'>) => `${r.scope}\0${r.company}`;
  const held = new Map<string, number>();
  const heldEmpty = new Map<string, number>();
  for (const r of existing) {
    const k = blacklistScannerKey(r, norm);
    if (k.empty) heldEmpty.set(id(r), (heldEmpty.get(id(r)) ?? 0) + 1);
    else held.set(k.key, (held.get(k.key) ?? 0) + 1);
  }
  const first = new Map<string, BlacklistRow>();
  const count = new Map<string, number>();
  for (const r of rows) {
    const k = blacklistScannerKey(r, norm);
    if (k.empty) {
      // Each one the file holds excuses one row, so a copy of it is not let through as well.
      const left = heldEmpty.get(id(r)) ?? 0;
      if (left > 0) {
        heldEmpty.set(id(r), left - 1);
        continue;
      }
      return `the scanner skips ${r.company}: it has no letters or digits to match a ${r.scope === 'domain' ? 'host' : 'company'} by; name a company or host`;
    }
    const n = (count.get(k.key) ?? 0) + 1;
    count.set(k.key, n);
    const prior = first.get(k.key);
    if (!prior) first.set(k.key, r);
    else if (n > Math.max(1, held.get(k.key) ?? 0)) return `the scanner reads ${r.company} as the same ${r.scope} as ${prior.company}, and keeps only the first; remove one of them`;
  }
  return null;
}

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
  /** Cells a save would drop, so it is refused: cells of listed rows that have no column to go to (a row wider than the table, a scope that is neither company nor domain), and the cells of a row with no company, which the scanner skips. */
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
const SEPARATOR = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/;

/**
 * A `|` line read as scan.mjs parseBlacklist reads every one: Company, Since, Scope, Reason by position. Null for what
 * it skips: a separator, a header (first cell Company), a line with no company.
 */
function scannerRow(line: string, extra: string[] = []): BlacklistRow | null {
  const cells = splitCells(line);
  const company = cells[0] ?? '';
  if (!scannerReadsCompany(company)) return null;
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

/**
 * Text around the table without its `|` lines, and the rows the scanner reads from them. Untouched when it has none.
 * Only the blank lines a removed run of `|` lines leaves behind go (the ones after it, or all of them at the end);
 * every other line, blank or not, is kept as it is.
 */
function outsideTable(lines: string[], read: (line: string) => BlacklistRow | null): { text: string; rows: BlacklistRow[] } {
  if (!lines.some((l) => TABLE_LINE.test(l))) return { text: lines.join('\n'), rows: [] };
  const rows = lines.filter((l) => TABLE_LINE.test(l)).map(read).filter((r): r is BlacklistRow => r !== null);
  const blank = (l: string) => l.trim() === '';
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!TABLE_LINE.test(lines[i]!)) {
      kept.push(lines[i++]!);
      continue;
    }
    while (i < lines.length && TABLE_LINE.test(lines[i]!)) i++;
    if (lines.slice(i).every(blank)) {
      while (kept.length && blank(kept.at(-1)!)) kept.pop();
      if (kept.length) kept.push('');
      break;
    }
    if (!kept.length || blank(kept.at(-1)!)) while (i < lines.length && blank(lines[i]!)) i++;
  }
  return { text: kept.join('\n'), rows };
}

/** Records a row's cells a save has no column for: past the table's last column, or a scope that is neither company nor domain. */
function noteLost(cells: string[], company: string, width: number, keepThird: boolean, unkept: string[]): void {
  const lost = cells.filter((c, i) => c !== '' && (i >= width || (i === 2 && !keepThird && !['company', 'domain'].includes(c.toLowerCase()))));
  if (lost.length) unkept.push(`${company} (${lost.join(', ')})`);
}

/**
 * Records the cells of a `|` line the scanner skips for having no company (an empty or dash first cell): a save writes
 * back only the rows it lists, so they would go. A separator or a header (first cell Company) holds no data.
 */
function noteCompanyless(line: string, unkept: string[]): void {
  if (SEPARATOR.test(line)) return;
  const [first = '', ...rest] = splitCells(line);
  if (first.toLowerCase() === 'company') return;
  const lost = rest.filter((c) => c !== '');
  if (lost.length) unkept.push(`(no company) (${lost.join(', ')})`);
}

export function parseBlacklist(md: string): BlacklistParsed {
  const lines = md.split(/\r?\n/);
  // The table's header: a `|` line naming a Company column, with the markdown separator row under it.
  const headerIdx = lines.findIndex((l, i) => TABLE_LINE.test(l) && /company/i.test(l) && SEPARATOR.test(lines[i + 1] ?? ''));
  if (headerIdx === -1) {
    // No table, but the scanner still blocks every `|` line: they are listed, and a save moves them into a new table.
    const unkept: string[] = [];
    const loose = outsideTable(lines, (l) => {
      const row = scannerRow(l);
      if (row) noteLost(splitCells(l), row.company, 4, false, unkept);
      else noteCompanyless(l, unkept);
      return row;
    });
    return { rows: loose.rows, preamble: loose.text.trim() ? loose.text : null, postamble: '', extraColumns: [], columnWarning: null, unkept };
  }
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
    if (!row && !isHeader) noteCompanyless(line, unkept);
    if (!row || isHeader) return row;
    noteLost(cells, row.company, Math.max(4, headerCells.length), keepThird, unkept);
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
