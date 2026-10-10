// Port of the alpha's inbox Skip/undo: flip the checkbox of one Pending row in
// data/pipeline.md by posting URL (or a saved JD's local:jds/ reference). Either is a matcher, never a path.
import { localJdPath } from '../../shared/local-jd.js';
import { postingUrl } from '../../shared/posting-url.js';

export { postingUrl };

// `[!]` is a row pipeline mode could not fetch (it waits for the JD text): open, so a skip checks it off too.
const CHECKBOX_LINE = /^(\s*-\s*)\[([ xX!])\](.*)$/;
// The Pending and Processed headings every shipped modes/*/pipeline.md writes, as pairs (modes/pipeline.md: they "may be
// in EN, ES, or any other language a market mode set writes them in"); tests/unit/upstream-formats checks the list
// against the mode files. Done and Hecho are older processed headings no mode writes any more.
const HEADING_PAIRS: ReadonlyArray<readonly [pending: string, processed: string]> = [
  ['Pending', 'Processed'],
  ['Pendientes', 'Procesadas'],
  ['Pendentes', 'Processadas'],
  ['Offen', 'Verarbeitet'],
  ['Afventer', 'Behandlede'],
  ['En attente', 'Traitees'],
  ['In attesa', 'Elaborati'],
  ['In afwachting', 'Verwerkt'],
  ['Menunggu', 'Diproses'],
  ['Oczekujące', 'Przetworzone'],
  ['Ожидающие', 'Обработанные'],
  ['Очікуючі', 'Оброблені'],
  ['Bekleyenler', 'İşlenenler'],
  ['लंबित', 'संसाधित'],
  ['대기', '처리 완료'],
  // modes/ja/pipeline.md writes Pending/Processed but keeps a file's existing Japanese headings.
  ['未処理', '処理済み'],
];
const PENDING_HEADINGS = HEADING_PAIRS.map(([p]) => p);
// Traitées: the accented spelling of the French heading, which a hand edit may use.
const PROCESSED_WRITTEN = [...HEADING_PAIRS.map(([, p]) => p), 'Traitées'];
const PROCESSED_HEADINGS = [...PROCESSED_WRITTEN, 'Done', 'Hecho'];

/** The name in `names` a heading title starts with as a whole word ("Pending (12)" is Pending, "Pendingly" is not). */
const headingName = (title: string, names: readonly string[]): string | undefined => {
  const t = title.trim().toLowerCase();
  return names.find((n) => {
    const name = n.toLowerCase();
    return t.startsWith(name) && !/^[\p{L}\p{N}]/u.test(t.slice(name.length));
  });
};

/** The Processed heading that pairs with a Pending heading title (`Offen` gives `Verarbeitet`), or null. */
export function processedHeadingFor(pendingTitle: string): string | null {
  const name = headingName(pendingTitle, PENDING_HEADINGS);
  return name === undefined ? null : HEADING_PAIRS.find(([p]) => p === name)![1];
}

/** Whether a heading title is a Processed heading a pipeline mode writes (not the older Done or Hecho). */
export function isProcessedHeading(title: string): boolean {
  return headingName(title, PROCESSED_WRITTEN) !== undefined;
}

/** Which pipeline.md section a `## ` heading's title opens, in any shipped mode language. */
export function pipelineSection(title: string): 'pending' | 'done' | 'other' {
  const t = title.trim();
  return headingName(t, PENDING_HEADINGS) ? 'pending' : headingName(t, PROCESSED_HEADINGS) ? 'done' : 'other';
}

/**
 * The posting URL a pipeline.md or shortlist.md cell stands for: scan.mjs backslash-escapes \\, [ and ] in it
 * (sanitizePipelineUrl), as markdown link destinations do. A | is written as %7C, which is already a valid URL.
 */
export function unescapeMarkdownUrl(cell: string): string {
  return unescapeMarkdownCell(cell);
}

/** A pipeline.md or shortlist.md text cell as written: scan.mjs and rank-pipeline.mjs escape \\, [ and ] in company, title, location and rank reason too (sanitizeMarkdownField). */
export function unescapeMarkdownCell(cell: string): string {
  return cell.replace(/\\([\\[\]])/g, '$1');
}

/** The key a scan-history URL has in pipeline.md once unescaped: | is written as %7C there. */
export function pipelineUrlKey(url: string): string {
  return unescapeMarkdownUrl(url.trim().split(/\s+/)[0] ?? '').replace(/\|/g, '%7C');
}

/** The key a Pending row is matched by: its posting URL, or the local:jds/ reference of a saved JD. */
export function pipelineRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return postingUrl(raw) ?? (localJdPath(raw) !== null ? raw.trim() : null);
}

function jobUrlFromRest(rest: string): string | null {
  // The URL is the cell's first word: a `[!]` row notes its error after it (`URL <dash> Error: login required`).
  return pipelineRef(unescapeMarkdownUrl(rest.split('|')[0]?.trim().split(/\s+/)[0] ?? ''));
}

function pendingRange(lines: string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const h = t.match(/^##\s+(.+)$/);
    if (h && pipelineSection(h[1]!) === 'pending') {
      start = i + 1;
      continue;
    }
    if (start !== -1 && t.startsWith('## ')) return { start, end: i };
  }
  return start === -1 ? null : { start, end: lines.length };
}

// Every modes/*/pipeline.md writes a URL it could not fetch as `- [!] URL <em dash or --> <note>` (Error: login
// required, Fehler: ..., or a bare reason in the ua mode): that note in the first cell, which a scanned row never has.
// A hand note after a plain hyphen (`URL - asked to wait`) is not one.
const FLAGGED_NOTE = /^\s*\S+\s+(?:--|\u2014)\s*\S/;

/** The open mark a restored row gets back: `!` for a skipped needs-JD row, so it still waits for its JD text. */
function restoredMark(rest: string): '!' | ' ' {
  return FLAGGED_NOTE.test(rest.split('|')[0] ?? '') ? '!' : ' ';
}

export type SkipResult = { ok: true; text: string; matched: number; changed: number } | { ok: false; error: 'invalid-url' | 'unmatched' };

/** Flip `- [ ]` and `- [x]` on Pending rows whose job URL (or local:jds/ reference) equals `url`; every other byte stays. */
export function applyInboxSkip(text: string, url: string, done: boolean): SkipResult {
  // The app reads rows unescaped (parsePipeline); the file holds the escaped form, so both sides compare unescaped.
  const parsed = pipelineRef(typeof url === 'string' ? unescapeMarkdownUrl(url.trim()) : url);
  if (!parsed) return { ok: false, error: 'invalid-url' };
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const endedWithNl = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (endedWithNl && lines[lines.length - 1] === '') lines.pop();
  const range = pendingRange(lines);
  let matched = 0;
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (range && (i < range.start || i >= range.end)) continue;
    const m = lines[i]!.match(CHECKBOX_LINE);
    if (!m) continue;
    if (jobUrlFromRest(m[3]!) !== parsed) continue;
    matched += 1;
    if ((m[2]!.toLowerCase() === 'x') === done) continue;
    lines[i] = `${m[1]}[${done ? 'x' : restoredMark(m[3]!)}]${m[3]}`;
    changed += 1;
  }
  if (matched === 0) return { ok: false, error: 'unmatched' };
  return { ok: true, text: lines.join(nl) + (endedWithNl ? nl : ''), matched, changed };
}
