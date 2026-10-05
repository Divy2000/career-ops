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
const EM_DASH = String.fromCharCode(0x2014);

export function isReservedReportFile(name: string): boolean {
  return RESERVED_RE.test(name);
}

export function reportNumberOf(name: string): number | null {
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

export function splitSections(body: string): { intro: string; sections: ReportSection[] } {
  const intro: string[] = [];
  const sections: ReportSection[] = [];
  let cur: { heading: string; letter: string | null; lines: string[] } | null = null;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? line.match(/^##\s+(.*)$/) : null;
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

function machineSummary(md: string, file: string): Record<string, unknown> | null {
  const idx = md.search(/^##\s+Machine Summary\s*$/m);
  if (idx === -1) return null;
  const after = md.slice(idx);
  const fence = after.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  try {
    const parsed = YAML.parse(fence[1]!);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    const line = md.slice(0, idx).split('\n').length + ((err as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line ?? 0);
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
 * "Company <sep> Role", split once at the first separator by position, whichever it is: the em dash or " -- " the
 * templates write, or the " - " of a legacy hand-written title. A role such as "Software Engineer - Platform" after an
 * em dash, or one with an em dash in it after a plain dash, stays whole.
 */
function splitTitle(rest: string): [string, string | undefined] {
  const sep = rest.match(new RegExp(`\\s+(?:${EM_DASH}|--?)\\s+`));
  if (!sep || sep.index === undefined) return [rest, undefined];
  return [rest.slice(0, sep.index), rest.slice(sep.index + sep[0].length)];
}

export function parseReport(markdown: string, file: string, num: number): ReportFull {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const scoreRaw = headerField(markdown, SCORE_KEY);
  // The title word is localized ("# Bewertung:", "# Evaluation :"), so a report is told apart by its score header or Machine Summary.
  const scored = new RegExp(`^\\*\\*(?:${SCORE_KEY})\\s*:\\*\\*`, 'mi').test(markdown) || /^##\s+Machine Summary\s*$/m.test(markdown);
  if (!title || !/^[^:]+:\s*\S/.test(title) || !scored) {
    throw new ParseError('Not an evaluation report: missing a "# Evaluation: Company - Role" title, a **Score:** header or a Machine Summary', file, 1);
  }
  const machine = machineSummary(markdown, file);
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
    url: headerField(markdown, 'URL'),
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
