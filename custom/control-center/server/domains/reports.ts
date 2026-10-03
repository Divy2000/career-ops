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

function headerField(md: string, key: string): string | null {
  const re = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.*)$`, 'mi');
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

function bullet(sectionContent: string, label: string): string | null {
  const re = new RegExp(`^\\s*[-*]?\\s*\\**${label}\\**\\s*(?:\\([^)]*\\))?\\s*:\\s*(.+)$`, 'mi');
  const m = sectionContent.match(re);
  return m ? m[1]!.trim() : null;
}

export function parseReport(markdown: string, file: string, num: number): ReportFull {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const scoreRaw = headerField(markdown, 'Score');
  if (!title || !/^Evaluation:/i.test(title) || (scoreRaw === null && !/^\*\*Score:\*\*/m.test(markdown))) {
    throw new ParseError('Not an evaluation report: missing "# Evaluation:" title or **Score:** header', file, 1);
  }
  const machine = machineSummary(markdown, file);
  const [companyPart, rolePart] = title.replace(/^Evaluation:\s*/i, '').split(new RegExp(`\\s+${EM_DASH}\\s+|\\s+-\\s+`));
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
    date: headerField(markdown, 'Date'),
    url: headerField(markdown, 'URL'),
    via: headerField(markdown, 'Via'),
    // The Machine Summary carries the normalized archetype; the header may read "Not a target - closest default: X".
    archetype: str(machine?.archetype) ?? headerField(markdown, 'Archetype'),
    score: parseScore(scoreRaw) ?? (typeof machine?.score === 'number' ? (machine.score as number) : null),
    legitimacy: headerField(markdown, 'Legitimacy') ?? str(machine?.legitimacy_tier),
    workAuth: headerField(markdown, 'Work Auth'),
    pdf: headerField(markdown, 'PDF'),
    tldr: bullet(blockA, 'TL;DR'),
    remote: bullet(blockA, 'Remote'),
    comp: bullet(blockA, 'Comp'),
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
