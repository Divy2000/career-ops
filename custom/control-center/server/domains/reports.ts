import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ParseError, readText } from './files.js';

export interface ReportSection {
  heading: string;
  letter: string | null;
  content: string;
}

export interface ReportSummary {
  num: number;
  file: string;
  title: string;
  company: string;
  role: string;
  date: string | null;
  url: string | null;
  via: string | null;
  archetype: string | null;
  score: number | null;
  legitimacy: string | null;
  workAuth: string | null;
  pdf: string | null;
  tldr: string | null;
  remote: string | null;
  comp: string | null;
  finalDecision: string | null;
  discardReasons: string[];
  machine: Record<string, unknown> | null;
  coverPdf: string | null;
}

export interface ReportFull extends ReportSummary {
  markdown: string;
  sections: ReportSection[];
  intro: string;
}

export type ReportRead =
  | { kind: 'ok'; report: ReportFull }
  | { kind: 'missing'; num: number }
  | { kind: 'reserved'; num: number; file: string }
  | { kind: 'malformed'; num: number; file: string; error: string; line: number | null };

const RESERVED_RE = /^\d+-RESERVED\.md$/;
const NUMBERED_RE = /^(\d+)-.*\.md$/;
// A name that is entirely a date is a digest (scan-ats-full.mjs --md-out reports/ writes reports/YYYY-MM-DD.md), not
// report #YYYY; reserve-report-num.mjs skips the same names.
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const EM_DASH = String.fromCharCode(0x2014);

export function isReservedReportFile(name: string): boolean {
  return RESERVED_RE.test(name);
}

export function reportNumberOf(name: string): number | null {
  if (BARE_DATE_RE.test(name)) return null;
  const m = name.match(NUMBERED_RE);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Index of real report files by number (RESERVED placeholders excluded). */
export function listReportFiles(dataRoot: string): Map<number, string> {
  const dir = path.join(dataRoot, 'reports');
  const out = new Map<number, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const name of names.sort()) {
    if (isReservedReportFile(name)) continue;
    const num = reportNumberOf(name);
    if (num !== null && !out.has(num)) out.set(num, name);
  }
  return out;
}

export function parseScore(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Header labels as the localized report templates write them (modes/<lang>/); URL, PDF, Via and Work Auth stay English.
const SCORE_KEY = 'Score|Punteggio|Puan|Бал';
const DATE_KEY = 'Date|Datum|Data|Dato|Tanggal|Tarih|Дата';
const ARCHETYPE_KEY = 'Archetype|Archetyp|Arketype|Archetipo|Arquétipo|Arketipe|Arketip|Архетип';
const LEGITIMACY_KEY = 'Legitimacy|Легітимність|Meşruiyet';

/** A `**Key:**` header line; French and Korean reports write `**Key :**`. Blanks never cross a line: an empty `**URL:**` is empty. */
function headerField(md: string, key: string): string | null {
  const re = new RegExp(`^\\*\\*(?:${key})[ \\t]*:\\*\\*[ \\t]*(.*)$`, 'mi');
  const m = md.match(re);
  if (!m) return null;
  const v = m[1]!.trim();
  return v === '' || v === EM_DASH || v === '-' ? null : v;
}

export function authorLetter(heading: string): string | null {
  const m = heading.match(/^([A-H])\)/);
  return m ? m[1]! : null;
}

// The archived JD (`## Job Description (archived verbatim)`) is the posting's text pasted as is, and its own `##`
// headings ("## Responsibilities") belong to it: only a report template section ends it, the rule
// check-jd-archive.mjs reads the section by (NEXT_REPORT_SECTION_RE). A named section is the whole heading, or the name
// followed by a note ("Liveness gate (URL inputs)", "Step 0 - ..."): a JD's "## Risk Summary and Mitigations" is the JD's.
const JD_HEADING = /^Job Description\b/i;
const REPORT_SECTION = /^(?:[A-Z]\)|Block\s[A-Z]\s*(?:$|[(:\u2014\u2013-])|(?:Machine Summary|Keywords extracted|Keyword Coverage|Score Evidence|Risk Summary|Cover Letter Draft|Post-evaluation|Liveness gate|Blacklist gate|Bounded Research Budget|Step 0)\s*(?:$|[(:\u2014\u2013-]))/i;

export function splitSections(body: string): { intro: string; sections: ReportSection[] } {
  const intro: string[] = [];
  const sections: ReportSection[] = [];
  let cur: { heading: string; letter: string | null; lines: string[] } | null = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    let h = !inFence ? line.match(/^##\s+(.*)$/) : null;
    if (h && cur && JD_HEADING.test(cur.heading) && !REPORT_SECTION.test(h[1]!.trim())) h = null;
    if (h) {
      if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join('\n').trim() });
      const heading = h[1]!.trim();
      cur = { heading, letter: authorLetter(heading), lines: [] };
    } else if (cur) cur.lines.push(line);
    else intro.push(line);
  }
  if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join('\n').trim() });
  return { intro: intro.join('\n').trim(), sections };
}

/**
 * The report's own `## Machine Summary` section. oferta writes it directly after the header, then the lettered blocks,
 * and the archived JD last; the batch prompt writes the archived JD first, then the Machine Summary and the lettered
 * blocks ("## A) ..." to "## G) ...", kept lettered in every language). So it is the first such heading before any
 * `## Job Description` heading, or else the last one after it, and only in the batch layout: no lettered block before
 * the JD, and the blocks follow it in order from A) through at least F) (the blocks before Block G existed) without
 * starting over. Inside the JD only a report template section is a heading (the splitSections rule), so a JD's own
 * yaml fence or "## Responsibilities" is the posting's text; a JD's own "## Machine Summary" ends the JD there, so the
 * block order is what tells it apart: one followed by a JD's "## A) Requirements" either starts over at the report's
 * own A) or never reaches F). The section ends at the next `##` heading outside a fence.
 */
const LETTERED_SECTION = /^(?:([A-Z])\)|Block\s([A-Z])\s*(?:$|[(:\u2014\u2013-]))/i;
const MACHINE_SUMMARY = /^Machine Summary\s*$/;

function sectionLetter(heading: string): string | null {
  const m = heading.match(LETTERED_SECTION);
  return m ? (m[1] ?? m[2]!).toUpperCase() : null;
}

/** The `##` headings outside fences, by line index, the JD's own headings left out (the splitSections rule). */
function reportHeadings(lines: string[]): Array<{ i: number; heading: string }> {
  const out: Array<{ i: number; heading: string }> = [];
  let inFence = false;
  let inJd = false;
  lines.forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? line.match(/^##\s+(.*)$/) : null;
    if (!h) return;
    const heading = h[1]!.trim();
    if (inJd && !REPORT_SECTION.test(heading)) return;
    inJd = JD_HEADING.test(heading);
    out.push({ i, heading });
  });
  return out;
}

/** True when the headings run A), B), ... in order through at least F), never repeating or going back a letter. */
function lettersInOrder(headings: string[]): boolean {
  let last = '';
  for (const h of headings) {
    const letter = sectionLetter(h);
    if (letter === null) continue;
    if (last === '' ? letter !== 'A' : letter <= last) return false;
    last = letter;
  }
  return last >= 'F';
}

function machineSummarySection(md: string): { line: number; content: string } | null {
  const lines = md.split('\n');
  const hs = reportHeadings(lines);
  const section = (k: number) => ({ line: hs[k]!.i + 1, content: lines.slice(hs[k]!.i + 1, hs[k + 1]?.i ?? lines.length).join('\n') });
  const jd = hs.findIndex((h) => JD_HEADING.test(h.heading));
  const own = hs.findIndex((h, k) => (jd === -1 || k < jd) && MACHINE_SUMMARY.test(h.heading));
  if (own !== -1) return section(own);
  if (jd === -1 || hs.slice(0, jd).some((h) => sectionLetter(h.heading) !== null)) return null;
  let last = -1;
  hs.forEach((h, k) => {
    if (k > jd && MACHINE_SUMMARY.test(h.heading)) last = k;
  });
  if (last === -1 || sectionLetter(hs[last + 1]?.heading ?? '') !== 'A') return null;
  return lettersInOrder(hs.slice(last + 1).map((h) => h.heading)) ? section(last) : null;
}

function machineSummary(section: { line: number; content: string } | null, file: string): Record<string, unknown> | null {
  if (!section) return null;
  const fence = section.content.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  try {
    const parsed = YAML.parse(fence[1]!);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    // section.line is the heading; the content starts on the next line and the fence body further down.
    const bodyStart = fence.index! + fence[0].length - '\n```'.length - fence[1]!.length;
    const bodyLine = section.line + 1 + (section.content.slice(0, bodyStart).match(/\n/g)?.length ?? 0);
    const line = bodyLine - 1 + ((err as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line ?? 1);
    throw new ParseError(`Machine Summary YAML is invalid: ${(err as Error).message.split('\n')[0]}`, file, line);
  }
}

/** A Block A field: a `| **Label** | value |` table row (what oferta writes) or a legacy `- Label: value` bullet. */
function blockField(sectionContent: string, label: string): string | null {
  const row = sectionContent.match(new RegExp(`^\\|[ \\t]*\\**${label}\\**[ \\t]*\\|[ \\t]*(.*?)[ \\t]*\\|[ \\t]*$`, 'mi'));
  if (row && row[1]) return row[1];
  const re = new RegExp(`^[ \\t]*[-*]?[ \\t]*\\**${label}\\**[ \\t]*(?:\\([^)]*\\))?[ \\t]*:[ \\t]*(.+)$`, 'mi');
  const m = sectionContent.match(re);
  return m ? m[1]!.trim() : null;
}

/**
 * The posting URL of a report's **URL:** header, cleaned as merge-tracker.mjs resolveReportUrl cleans it (a <...>
 * autolink wrapper and trailing punctuation dropped), and only when it is a real http(s) URL: `N/A` is legitimate for a
 * recruiter-sourced role and must not become a link.
 */
export function postingUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.split(/\s/)[0]!.replace(/^<|>$/g, '').replace(/[),.;]+$/, '');
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? raw : null;
  } catch {
    return null;
  }
}

/**
 * "Company <sep> Role", split once: at the first em dash or " -- " (what the templates write), and at " - " only when
 * neither is there, so a role such as "Software Engineer - Platform" stays whole.
 */
function splitTitle(rest: string): [string, string | undefined] {
  const sep = rest.match(new RegExp(`\\s+(?:${EM_DASH}|--)\\s+`)) ?? rest.match(/\s+-\s+/);
  if (!sep || sep.index === undefined) return [rest, undefined];
  return [rest.slice(0, sep.index), rest.slice(sep.index + sep[0].length)];
}

export function parseReport(markdown: string, file: string, num: number): ReportFull {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const scoreRaw = headerField(markdown, SCORE_KEY);
  // The title word is localized ("# Bewertung:", "# Evaluation :"), so a report is told apart by its score header or Machine Summary.
  const summarySection = machineSummarySection(markdown);
  const scored = new RegExp(`^\\*\\*(?:${SCORE_KEY})\\s*:\\*\\*`, 'mi').test(markdown) || summarySection !== null;
  if (!title || !/^[^:]+:\s*\S/.test(title) || !scored) {
    throw new ParseError('Not an evaluation report: missing a "# Evaluation: Company - Role" title, a **Score:** header or a Machine Summary', file, 1);
  }
  const machine = machineSummary(summarySection, file);
  const [companyPart, rolePart] = splitTitle(title.replace(/^[^:]+:\s*/, ''));
  const { intro, sections } = splitSections(markdown);
  const blockA = sections.find((s) => s.letter === 'A')?.content ?? '';
  const cover = sections.find((s) => /cover letter/i.test(s.heading))?.content ?? '';
  const coverPdf = cover.match(/PDF generated:\s*(\S+)/i)?.[1] ?? null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const discard = Array.isArray(machine?.discard_reasons) ? (machine!.discard_reasons as unknown[]).map(String) : [];
  return {
    num,
    file,
    title,
    company: str(machine?.company) ?? companyPart?.trim() ?? '',
    role: str(machine?.role) ?? rolePart?.trim() ?? '',
    date: headerField(markdown, DATE_KEY),
    url: postingUrl(headerField(markdown, 'URL')),
    via: headerField(markdown, 'Via'),
    // The Machine Summary carries the normalized archetype; the header may read "Not a target - closest default: X".
    archetype: str(machine?.archetype) ?? headerField(markdown, ARCHETYPE_KEY),
    score: parseScore(scoreRaw) ?? (typeof machine?.score === 'number' ? (machine.score as number) : null),
    legitimacy: headerField(markdown, LEGITIMACY_KEY) ?? str(machine?.legitimacy_tier),
    workAuth: headerField(markdown, 'Work Auth'),
    pdf: headerField(markdown, 'PDF'),
    tldr: blockField(blockA, 'TL;DR'),
    remote: blockField(blockA, 'Remote'),
    // Block A has no Comp row; the Machine Summary carries the JD's own figure.
    comp: str(machine?.advertised_comp) ?? blockField(blockA, 'Comp'),
    finalDecision: str(machine?.final_decision),
    discardReasons: discard,
    machine,
    coverPdf,
    markdown,
    sections,
    intro,
  };
}

export function readReport(dataRoot: string, num: number): ReportRead {
  const dir = path.join(dataRoot, 'reports');
  const files = listReportFiles(dataRoot);
  const file = files.get(num);
  if (!file) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { kind: 'missing', num };
    }
    const reserved = names.find((n) => isReservedReportFile(n) && reportNumberOf(n) === num);
    return reserved ? { kind: 'reserved', num, file: reserved } : { kind: 'missing', num };
  }
  const read = readText(path.join(dir, file));
  if (read.kind === 'missing') return { kind: 'missing', num };
  try {
    return { kind: 'ok', report: parseReport(read.text, file, num) };
  } catch (err) {
    if (err instanceof ParseError) return { kind: 'malformed', num, file, error: err.message, line: err.line };
    throw err;
  }
}

export function summaryOf(r: ReportFull): ReportSummary {
  const { markdown: _m, sections: _s, intro: _i, ...summary } = r;
  return summary;
}
