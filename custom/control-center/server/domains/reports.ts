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

/**
 * Names of the files under reports/, a symlink to a file included: a folder named like a report (a session that wrote
 * reports/099-acme.md/jd.txt) is no report.
 */
function reportDirFiles(dataRoot: string): string[] {
  const dir = path.join(dataRoot, 'reports');
  const linkedFile = (name: string) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  };
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || (e.isSymbolicLink() && linkedFile(e.name)))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Names of the real report files under reports/, sorted: numbered, RESERVED placeholders excluded. */
export function listReportNames(dataRoot: string): string[] {
  return reportDirFiles(dataRoot)
    .filter((name) => !isReservedReportFile(name) && reportNumberOf(name) !== null)
    .sort();
}

/** Index of real report files by number; when two share a number, the first by name. */
export function listReportFiles(dataRoot: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const name of listReportNames(dataRoot)) {
    const num = reportNumberOf(name)!;
    if (!out.has(num)) out.set(num, name);
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

// Who owns each line, where an archived JD ends and which Machine Summary is the report's own: reports.invariants.md.
// One pass (outline) decides all of it; every reader below takes its text, sections and summary from that outline.
const JD_HEADING = /^Job Description\b/i;
// A report template heading, the one thing that ends an archived JD outside a batch report's tail; the rule
// check-jd-archive.mjs reads the section by (NEXT_REPORT_SECTION_RE). A named section is the whole heading, or the name
// followed by a note ("Liveness gate (URL inputs)", "Step 0 - ..."): a JD's "## Risk Summary and Mitigations" is the JD's.
const REPORT_SECTION = /^(?:[A-Z]\)|Block\s[A-Z]\s*(?:$|[(:\u2014\u2013-])|(?:Machine Summary|Keywords extracted|Keyword Coverage|Score Evidence|Risk Summary|Cover Letter Draft|Post-evaluation|Liveness gate|Blacklist gate|Bounded Research Budget|Step 0)\s*(?:$|[(:\u2014\u2013-]))/i;
const LETTERED_SECTION = /^(?:([A-Z])\)|Block\s([A-Z])\s*(?:$|[(:\u2014\u2013-]))/i;
const MACHINE_SUMMARY = /^Machine Summary\s*$/;
const FENCE = /^```/;

function headingOf(line: string): string | null {
  const m = line.match(/^##\s+(.*)$/);
  return m ? m[1]!.trim() : null;
}

function sectionLetter(heading: string): string | null {
  const m = heading.match(LETTERED_SECTION);
  return m ? (m[1] ?? m[2]!).toUpperCase() : null;
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

/**
 * The line a batch report's tail starts on, after the archived JD heading on line `jd`: the last `## A)` whose
 * lettered headings run in order through F), from the `## Machine Summary` right before it when there is one. Every
 * `##` line counts, fenced or not, since a fence the JD opens is the JD's text.
 */
function batchTail(lines: string[], jd: number): number | null {
  const raw: Array<{ i: number; heading: string }> = [];
  for (let i = jd + 1; i < lines.length; i++) {
    const heading = headingOf(lines[i]!);
    if (heading !== null) raw.push({ i, heading });
  }
  let a = raw.length - 1;
  while (a >= 0 && sectionLetter(raw[a]!.heading) !== 'A') a--;
  if (a === -1 || !lettersInOrder(raw.slice(a).map((h) => h.heading))) return null;
  return a > 0 && MACHINE_SUMMARY.test(raw[a - 1]!.heading) ? raw[a - 1]!.i : raw[a]!.i;
}

interface Outline {
  lines: string[];
  /** Section starts: the report's own `##` headings outside fences and each archived JD heading, never one a JD owns. */
  headings: Array<{ i: number; heading: string }>;
  /** True for each line an archived JD owns (its heading line is the report's). */
  jdOwned: boolean[];
  /** Index into `headings` of the report's own Machine Summary, or -1. */
  summary: number;
}

function outline(md: string): Outline {
  const lines = md.split(/\r?\n/);
  const headings: Outline['headings'] = [];
  const jdOwned = new Array<boolean>(lines.length).fill(false);
  let summary = -1;
  let inFence = false;
  let seenJd = false;
  let tail: number | null = null;
  // While in a JD: the line its batch tail starts on, or null when the next template heading ends it.
  let jdEnd: number | null | undefined;
  lines.forEach((line, i) => {
    if (jdEnd !== undefined) {
      const heading = headingOf(line);
      if (jdEnd === null ? heading === null || !REPORT_SECTION.test(heading) : i !== jdEnd) {
        jdOwned[i] = true;
        return;
      }
      jdEnd = undefined;
      inFence = false;
    }
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : headingOf(line);
    if (heading === null) return;
    if (summary === -1 && MACHINE_SUMMARY.test(heading) && (!seenJd || i === tail)) summary = headings.length;
    if (JD_HEADING.test(heading)) {
      // Only the first JD of a report with nothing report-shaped before it is a batch report's JD.
      const batch = !seenJd && !headings.some((h) => MACHINE_SUMMARY.test(h.heading) || sectionLetter(h.heading) !== null);
      if (batch) tail = batchTail(lines, i);
      seenJd = true;
      jdEnd = batch ? tail : null;
    }
    headings.push({ i, heading });
  });
  return { lines, headings, jdOwned, summary };
}

function sectionsOf(o: Outline): { intro: string; sections: ReportSection[] } {
  const end = (k: number) => o.headings[k + 1]?.i ?? o.lines.length;
  const sections = o.headings.map(({ i, heading }, k) => ({ heading, letter: authorLetter(heading), content: o.lines.slice(i + 1, end(k)).join('\n').trim() }));
  return { intro: o.lines.slice(0, o.headings[0]?.i ?? o.lines.length).join('\n').trim(), sections };
}

export function splitSections(body: string): { intro: string; sections: ReportSection[] } {
  return sectionsOf(outline(body));
}

/** The report's own `## Machine Summary` section: its heading's 1-based line and the text up to the next section. */
function machineSummarySection(o: Outline): { line: number; content: string } | null {
  if (o.summary === -1) return null;
  const start = o.headings[o.summary]!.i;
  return { line: start + 1, content: o.lines.slice(start + 1, o.headings[o.summary + 1]?.i ?? o.lines.length).join('\n') };
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
  const o = outline(markdown.replace(/^\uFEFF/, ''));
  // The header, the title and every other `**Key:**` line come only from text the report owns, never from a JD.
  const own = o.lines.filter((_, i) => !o.jdOwned[i]).join('\n');
  const title = own.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const scoreRaw = headerField(own, SCORE_KEY);
  // The title word is localized ("# Bewertung:", "# Evaluation :"), so a report is told apart by its score header or Machine Summary.
  const summarySection = machineSummarySection(o);
  const scored = new RegExp(`^\\*\\*(?:${SCORE_KEY})\\s*:\\*\\*`, 'mi').test(own) || summarySection !== null;
  if (!title || !/^[^:]+:\s*\S/.test(title) || !scored) {
    throw new ParseError('Not an evaluation report: missing a "# Evaluation: Company - Role" title, a **Score:** header or a Machine Summary', file, 1);
  }
  const machine = machineSummary(summarySection, file);
  const [companyPart, rolePart] = splitTitle(title.replace(/^[^:]+:\s*/, ''));
  const { intro, sections } = sectionsOf(o);
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
    date: headerField(own, DATE_KEY),
    url: postingUrl(headerField(own, 'URL')),
    via: headerField(own, 'Via'),
    // The Machine Summary carries the normalized archetype; the header may read "Not a target - closest default: X".
    archetype: str(machine?.archetype) ?? headerField(own, ARCHETYPE_KEY),
    score: parseScore(scoreRaw) ?? (typeof machine?.score === 'number' ? (machine.score as number) : null),
    legitimacy: headerField(own, LEGITIMACY_KEY) ?? str(machine?.legitimacy_tier),
    workAuth: headerField(own, 'Work Auth'),
    pdf: headerField(own, 'PDF'),
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
      names = reportDirFiles(dataRoot);
    } catch {
      return { kind: 'missing', num };
    }
    const reserved = names.find((n) => isReservedReportFile(n) && reportNumberOf(n) === num);
    return reserved ? { kind: 'reserved', num, file: reserved } : { kind: 'missing', num };
  }
  return parseReportFile(dir, file, num);
}

/** Reads one report by its file name, for a caller that knows which file it means when two share a number. */
export function readReportFile(dataRoot: string, file: string): ReportRead {
  const num = reportNumberOf(file);
  if (num === null) throw new Error(`not a numbered report file: ${file}`);
  if (!listReportNames(dataRoot).includes(file)) return { kind: 'missing', num };
  return parseReportFile(path.join(dataRoot, 'reports'), file, num);
}

function parseReportFile(dir: string, file: string, num: number): ReportRead {
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
