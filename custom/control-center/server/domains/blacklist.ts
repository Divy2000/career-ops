// data/blacklist.md in the templates/blacklist.example.md format: a preamble
// and one table with Company, Since, Scope and Reason columns. Legacy tables
// (Company, Reason, Added) are read and rewritten into that format on save.
// Everything after the table (notes, other tables) is kept byte for byte.
import fs from 'node:fs';
import path from 'node:path';
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
});
export type BlacklistRow = z.infer<typeof blacklistRowSchema>;

export interface BlacklistParsed {
  rows: BlacklistRow[];
  /** Text before the table (kept verbatim on save); null when the file has none. */
  preamble: string | null;
  /** Everything after the table (kept verbatim on save); '' when the table ends the file. */
  postamble: string;
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

export function parseBlacklist(md: string): BlacklistParsed {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /company/i.test(l));
  if (headerIdx === -1) return { rows: [], preamble: md.trim() ? md : null, postamble: '' };
  const header = splitCells(lines[headerIdx]!).map((h) => h.toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iCompany = col(['company']);
  const iSince = col(['since', 'added', 'date']);
  const iScope = col(['scope']);
  const iReason = col(['reason', 'notes', 'why']);
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
    });
  }
  const preamble = lines.slice(0, headerIdx).join('\n');
  return { rows: rows.filter((r) => r.company), preamble: preamble.trim() ? preamble : null, postamble: lines.slice(end).join('\n') };
}

export function renderBlacklist(rows: BlacklistRow[], preamble: string | null, postamble = ''): string {
  const head = (preamble ?? DEFAULT_BLACKLIST_PREAMBLE).trimEnd();
  const table = ['| Company | Since | Scope | Reason |', '|---------|-------|-------|--------|', ...rows.map((r) => `| ${r.company} | ${r.since} | ${r.scope} | ${r.reason} |`)];
  return `${head}\n\n${table.join('\n')}\n${postamble}`;
}

export function readBlacklist(dataRoot: string): BlacklistRead {
  const abs = path.join(dataRoot, BLACKLIST_REL);
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    return { kind: 'ok', path: BLACKLIST_REL, raw, etag: etagOf(raw), ...parseBlacklist(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path: BLACKLIST_REL, raw: '', etag: null, rows: [], preamble: null, postamble: '' };
    throw err;
  }
}

/** Atomic write of the rendered table; the caller has already checked the ETag and the explicit gate. */
export function writeBlacklist(dataRoot: string, rows: BlacklistRow[], preamble: string | null, postamble = ''): BlacklistRead {
  const abs = path.join(dataRoot, BLACKLIST_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = renderBlacklist(rows, preamble, postamble);
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, abs);
  return readBlacklist(dataRoot);
}
