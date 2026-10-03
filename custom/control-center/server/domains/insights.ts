import path from 'node:path';
import { readText } from './files.js';
import type { TrackerRow } from './tracker.js';

export interface StatusLogRow {
  num: number;
  date: string;
  from: string;
  to: string;
  source: string;
  note: string;
}

export function parseStatusLog(text: string): StatusLogRow[] {
  const rows: StatusLogRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [num, date, from, to, source, ...note] = line.split('\t');
    const n = parseInt(num ?? '', 10);
    if (Number.isNaN(n) || !date) continue;
    rows.push({ num: n, date, from: from ?? '-', to: to ?? '-', source: source ?? '', note: note.join('\t').trim() });
  }
  return rows;
}

export function readStatusLog(dataRoot: string): StatusLogRow[] {
  const read = readText(path.join(dataRoot, 'data', 'status-log.tsv'));
  return read.kind === 'ok' ? parseStatusLog(read.text) : [];
}

export const FUNNEL_STAGES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired'] as const;
export const SCORE_BUCKETS = [
  { label: '< 3.0', min: -Infinity, max: 3 },
  { label: '3.0 to 3.9', min: 3, max: 4 },
  { label: '4.0 to 4.4', min: 4, max: 4.5 },
  { label: '4.5 and up', min: 4.5, max: Infinity },
];

export interface Dashboard {
  totals: { applications: number; scored: number; averageScore: number | null; byStatus: Record<string, number> };
  funnel: Array<{ stage: string; count: number }>;
  rates: { appliedToInterview: number | null; interviewToOffer: number | null; evaluatedToApplied: number | null };
  scoreBuckets: Array<{ label: string; count: number }>;
  weeklyActivity: Array<{ week: string; transitions: number }>;
  topCompanies: Array<{ company: string; count: number; averageScore: number | null }>;
  archetypes: Array<{ archetype: string; count: number; averageScore: number | null }>;
  workMode: Record<'remote' | 'hybrid' | 'onsite' | 'unknown', number>;
  stageTransitions: Array<{ from: string; to: string; count: number }>;
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function workModeOf(remote: string | null): keyof Dashboard['workMode'] {
  const r = (remote ?? '').toLowerCase();
  if (!r) return 'unknown';
  if (/hybrid/.test(r)) return 'hybrid';
  if (/remote/.test(r)) return 'remote';
  if (/on-?site|in office|in-office/.test(r)) return 'onsite';
  return 'unknown';
}

/** Stage reached by an application: its current status, plus every stage the ledger shows it passed. */
function stagesReached(row: TrackerRow, log: StatusLogRow[]): Set<string> {
  const reached = new Set<string>();
  const idx = (s: string) => (FUNNEL_STAGES as readonly string[]).indexOf(s);
  const mark = (s: string) => {
    const i = idx(s);
    if (i === -1) return;
    for (let k = 0; k <= i; k++) reached.add(FUNNEL_STAGES[k]!);
  };
  mark(row.status);
  for (const t of log) if (t.num === row.num) mark(t.to);
  if (row.score !== null || row.report !== null) reached.add('Evaluated');
  return reached;
}

export function computeDashboard(rows: TrackerRow[], log: StatusLogRow[]): Dashboard {
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const scored = rows.filter((r) => r.score !== null);
  const funnelCounts = new Map<string, number>(FUNNEL_STAGES.map((s) => [s, 0]));
  for (const r of rows) for (const s of stagesReached(r, log)) funnelCounts.set(s, (funnelCounts.get(s) ?? 0) + 1);
  const get = (s: string) => funnelCounts.get(s) ?? 0;
  const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);
  const weekly = new Map<string, number>();
  for (const t of log) weekly.set(isoWeek(t.date), (weekly.get(isoWeek(t.date)) ?? 0) + 1);
  const companies = new Map<string, TrackerRow[]>();
  for (const r of rows) companies.set(r.company, [...(companies.get(r.company) ?? []), r]);
  const archetypes = new Map<string, TrackerRow[]>();
  for (const r of rows) {
    const a = r.summary?.archetype ?? 'Unknown';
    archetypes.set(a, [...(archetypes.get(a) ?? []), r]);
  }
  const workMode: Dashboard['workMode'] = { remote: 0, hybrid: 0, onsite: 0, unknown: 0 };
  for (const r of rows) workMode[workModeOf(r.summary?.remote ?? null)]++;
  const transitions = new Map<string, number>();
  for (const t of log) {
    const key = `${t.from}>${t.to}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  return {
    totals: { applications: rows.length, scored: scored.length, averageScore: avg(scored.map((r) => r.score!)), byStatus },
    funnel: FUNNEL_STAGES.map((stage) => ({ stage, count: get(stage) })),
    rates: {
      evaluatedToApplied: ratio(get('Applied'), get('Evaluated')),
      appliedToInterview: ratio(get('Interview'), get('Applied')),
      interviewToOffer: ratio(get('Offer'), get('Interview')),
    },
    scoreBuckets: SCORE_BUCKETS.map((b) => ({ label: b.label, count: scored.filter((r) => r.score! >= b.min && r.score! < b.max).length })),
    weeklyActivity: [...weekly.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, transitions]) => ({ week, transitions })),
    topCompanies: [...companies.entries()]
      .map(([company, rs]) => ({ company, count: rs.length, averageScore: avg(rs.filter((r) => r.score !== null).map((r) => r.score!)) }))
      .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company))
      .slice(0, 10),
    archetypes: [...archetypes.entries()]
      .map(([archetype, rs]) => ({ archetype, count: rs.length, averageScore: avg(rs.filter((r) => r.score !== null).map((r) => r.score!)) }))
      .sort((a, b) => b.count - a.count || a.archetype.localeCompare(b.archetype)),
    workMode,
    stageTransitions: [...transitions.entries()]
      .map(([k, count]) => {
        const [from, to] = k.split('>');
        return { from: from!, to: to!, count };
      })
      .sort((a, b) => b.count - a.count),
  };
}
