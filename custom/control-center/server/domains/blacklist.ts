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
// What must always hold: blacklist.invariants.md next to this file.
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
 * The first row of `rows` the scanner would never read: one whose key is empty, or one of several rows under a key (the
 * scanner keeps only the first, and any order of them is savable). Such a row is let through only when the file holds a
 * row with the same company and scope, one for one, so a save never adds a dead row but keeps the ones the file has. A
 * key with a single row is always read. Null when none.
 */
export function blacklistUnreadRow(rows: BlacklistRow[], existing: BlacklistRow[], norm: NormalizeTextKey): string | null {
  const id = (r: Pick<BlacklistRow, 'company' | 'scope'>) => `${r.scope}\0${r.company}`;
  const held = new Map<string, number>();
  for (const r of existing) held.set(id(r), (held.get(id(r)) ?? 0) + 1);
  const keyed = rows.map((r) => ({ r, ...blacklistScannerKey(r, norm) }));
  const group = new Map<string, BlacklistRow[]>();
  for (const k of keyed) if (!k.empty) group.set(k.key, [...(group.get(k.key) ?? []), k.r]);
  // Each dead row uses up one row of the file with its company and scope; the ones left over are new.
  const fresh = keyed.filter((k) => {
    if (!k.empty && group.get(k.key)!.length === 1) return false;
    const left = held.get(id(k.r)) ?? 0;
    held.set(id(k.r), left - 1);
    return left <= 0;
  });
  if (!fresh.length) return null;
  // A duplicate is named at its last new row, against another row of its key: the first one, or the second when it is the first.
  const last = new Map(fresh.map((k) => [k.key, k]));
  const blamed = fresh.find((k) => k.empty || last.get(k.key) === k)!;
  const { r } = blamed;
  if (blamed.empty) return `the scanner skips ${r.company}: it has no letters or digits to match a ${r.scope === 'domain' ? 'host' : 'company'} by; name a company or host`;
  const members = group.get(blamed.key)!;
  const other = members[0] === r ? members[1]! : members[0]!;
  return `the scanner reads ${r.company} as the same ${r.scope} as ${other.company}, and keeps only the first; remove one of them`;
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

// The columns the scanner reads, by position, and the header names each may have in a file (the first only has to
// mention Company). A save writes them under these labels, in this order.
const POSITIONS: Array<{ label: string; fits: (h: string) => boolean }> = [
  { label: 'Company', fits: (h) => h.includes('company') },
  { label: 'Since', fits: (h) => ['since', 'added', 'date'].includes(h) },
  { label: 'Scope', fits: (h) => h === 'scope' },
  { label: 'Reason', fits: (h) => ['reason', 'notes', 'why'].includes(h) },
];
const SCOPE_AT = 2;
const SCOPES = ['company', 'domain'];

/**
 * The one table model parse reads and render writes: the managed columns at positions 0 to 3, then the file's other
 * columns, each read from its own position of a `|` line (`extraAt`, parallel to `extraColumns`). A cell is kept on
 * save only when this layout gives it a place; every other non-empty cell is unkept.
 */
interface Layout {
  extraColumns: string[];
  extraAt: number[];
}
const NO_TABLE: Layout = { extraColumns: [], extraAt: [] };

/**
 * The layout of a table with this header. The scanner reads the third column only as a scope (anything but domain is
 * company): any other column there is kept, under its own name, beside the ones the editor manages.
 */
function layoutOf(headerCells: string[]): Layout {
  const header = headerCells.map((h) => h.toLowerCase());
  const keepThird = header.length > SCOPE_AT && header[SCOPE_AT] !== 'scope';
  const managed = POSITIONS.some((p) => p.label.toLowerCase() === header[SCOPE_AT]);
  const third = keepThird ? [{ name: managed ? `${headerCells[SCOPE_AT]} (old column 3)` : headerCells[SCOPE_AT]!, at: SCOPE_AT }] : [];
  const rest = headerCells.slice(POSITIONS.length).map((name, i) => ({ name, at: POSITIONS.length + i }));
  const extras = [...third, ...rest];
  return { extraColumns: extras.map((e) => e.name), extraAt: extras.map((e) => e.at) };
}

/** Whether a save writes this cell of a listed row back: into its managed column, or into one of the file's own columns. */
function keptCell(layout: Layout, cell: string, at: number): boolean {
  if (cell === '' || at === 0 || at === 1 || at === 3 || layout.extraAt.includes(at)) return true;
  return at === SCOPE_AT && SCOPES.includes(cell.toLowerCase());
}

/**
 * A `|` line read as scan.mjs parseBlacklist reads every one: Company, Since, Scope, Reason by position, and the cells
 * of the layout's other columns. Null for what the scanner skips: a separator, a header (first cell Company), a line
 * with no company. Cells a save would drop go to `unkept`: those of a listed row the layout has no place for, and those
 * of a line with no company. A header line's own labels are no data, so nothing of it is unkept.
 */
function readLine(line: string, layout: Layout, unkept: string[], isHeader = false): BlacklistRow | null {
  const cells = splitCells(line);
  const company = cells[0] ?? '';
  if (!scannerReadsCompany(company)) {
    const lost = cells.slice(1).filter((c) => c !== '');
    if (!isHeader && !SEPARATOR.test(line) && company.toLowerCase() !== 'company' && lost.length) unkept.push(`(no company) (${lost.join(', ')})`);
    return null;
  }
  const lost = isHeader ? [] : cells.filter((c, i) => !keptCell(layout, c, i));
  if (lost.length) unkept.push(`${company} (${lost.join(', ')})`);
  const extra = layout.extraAt.map((at) => cells[at] ?? '');
  return {
    company,
    since: cells[1] ?? '',
    scope: (cells[SCOPE_AT] || 'company').toLowerCase() === 'domain' ? 'domain' : 'company',
    reason: cells[3] ?? '',
    ...(extra.length ? { extra } : {}),
  };
}

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

export function parseBlacklist(md: string): BlacklistParsed {
  const lines = md.split(/\r?\n/);
  const unkept: string[] = [];
  // The table's header: a `|` line naming a Company column, with the markdown separator row under it.
  const headerIdx = lines.findIndex((l, i) => TABLE_LINE.test(l) && /company/i.test(l) && SEPARATOR.test(lines[i + 1] ?? ''));
  if (headerIdx === -1) {
    // No table, but the scanner still blocks every `|` line: they are listed, and a save moves them into a new table.
    const loose = outsideTable(lines, (l) => readLine(l, NO_TABLE, unkept));
    return { rows: loose.rows, preamble: loose.text.trim() ? loose.text : null, postamble: '', extraColumns: [], columnWarning: null, unkept };
  }
  const headerCells = splitCells(lines[headerIdx]!);
  const misplaced = POSITIONS.some((p, i) => i < headerCells.length && !p.fits(headerCells[i]!.toLowerCase()));
  const columnWarning = misplaced
    ? `The table's header is "${headerCells.join(' | ')}", but the scanner reads every row by position as Company, Since, Scope, Reason. The rows are shown as it reads them; saving rewrites the header in that order.`
    : null;
  // Every listed row, in the table or not, is read by position into the table's own columns.
  const layout = layoutOf(headerCells);
  const read = (l: string) => readLine(l, layout, unkept);
  // A markdown table ends at its first line that is not a row (a blank line included).
  let end = headerIdx + 1;
  while (end < lines.length && TABLE_LINE.test(lines[end]!)) end++;
  const before = outsideTable(lines.slice(0, headerIdx), read);
  // The scanner skips a header only when its first cell is exactly Company: "| Company Name | ... |" is an entry it
  // blocks, so it is listed (a save writes the column names again above it; its own labels are no data to keep).
  const headerRow = readLine(lines[headerIdx]!, layout, unkept, true);
  const rows = [...(headerRow ? [headerRow] : []), ...lines.slice(headerIdx + 1, end).map(read)].filter((r): r is BlacklistRow => r !== null);
  const after = outsideTable(lines.slice(end), read);
  return { rows: [...before.rows, ...rows, ...after.rows], preamble: before.text.trim() ? before.text : null, postamble: after.text, extraColumns: layout.extraColumns, columnWarning, unkept };
}

/** The file with `rows` as its one table, in the layout parseBlacklist reads: the managed columns, then `extraColumns`. */
export function renderBlacklist(rows: BlacklistRow[], preamble: string | null, postamble = '', extraColumns: string[] = []): string {
  const head = (preamble ?? DEFAULT_BLACKLIST_PREAMBLE).trimEnd();
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const rule = `|${[...POSITIONS.map((p) => '-'.repeat(p.label.length + 2)), ...extraColumns.map(() => '---')].join('|')}|`;
  const cellsOf = (r: BlacklistRow) => [r.company, r.since, r.scope, r.reason, ...extraColumns.map((_, i) => r.extra?.[i] ?? '')];
  const table = [line([...POSITIONS.map((p) => p.label), ...extraColumns]), rule, ...rows.map((r) => line(cellsOf(r)))];
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
