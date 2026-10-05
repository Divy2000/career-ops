import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../core/adapter.js';
import { parseTsv, readText } from './files.js';

export interface DigestSection {
  date: string;
  body: string;
}

export interface CompanyFile {
  slug: string;
  name: string;
  checkedAt: string | null;
  verdict: string | null;
  dolTier: string | null;
  policyChangesSeen: number | null;
  path: string;
}

export interface DailyLogStep {
  name: string;
  time: string;
  failed: boolean;
}

export interface DailyLog {
  date: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** interrupted: the last run has no done line and the job is known not to be running (cancelled, killed or exited early). */
  status: 'ok' | 'failed' | 'running' | 'interrupted' | 'empty';
  steps: DailyLogStep[];
  failedSteps: string[];
  /** Other `!!!` lines of the last run (sync.sh's fail, run-daily.sh's early exits), without the marker: each fails the run. */
  problems: string[];
  failedCount: number | null;
}

export interface ImmigrationOverview {
  digest: { kind: 'missing' } | { kind: 'ok'; sections: DigestSection[]; latestDate: string | null; staleDays: number | null };
  policyChanges: Record<string, unknown>[];
  alerts: { latest: Record<string, unknown>[]; history: Record<string, unknown>[] };
  officialFeed: Record<string, string>[];
  companies: CompanyFile[];
  tiers: unknown;
  seen: unknown;
  /** Items the watcher queued for the AI pass (pending.json); null when absent or unreadable. */
  pendingCount: number | null;
  /** Set when pending.json exists but cannot be read as a list; null when it is absent or fine. */
  pendingError: string | null;
  dailyLog: DailyLog | null;
  logDates: string[];
}

interface ImmigrationLib {
  parsePolicyChanges: (tsv: string) => Record<string, unknown>[];
  /** Latest alert per company slug. */
  parseCompanyAlerts: (tsv: string) => Map<string, Record<string, unknown>>;
  readCheckedAt: (md: string) => string | null;
  companySlug: (name: string) => string;
}

export function parseDigest(md: string): DigestSection[] {
  const sections: DigestSection[] = [];
  let cur: DigestSection | null = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) {
      if (cur) sections.push({ ...cur, body: cur.body.trim() });
      cur = { date: m[1]!, body: '' };
    } else if (cur) cur.body += line + '\n';
  }
  if (cur) sections.push({ ...cur, body: cur.body.trim() });
  return sections;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function parseCompanyFile(md: string, slug: string, filePath: string, readCheckedAt: (md: string) => string | null): CompanyFile {
  const field = (key: string) => md.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
  const seen = field('policy_changes_seen');
  return {
    slug,
    name: md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug,
    checkedAt: readCheckedAt(md),
    verdict: field('verdict') ?? field('decision'),
    dolTier: field('dol_tier'),
    policyChangesSeen: seen !== null && /^\d+$/.test(seen) ? Number(seen) : null,
    path: filePath,
  };
}

const RUN_START = /^===\s+(\S+\s+\S+)\s+start/;

/** A dated log gets one block per run of that day (run-daily.sh appends); only the last run counts. */
export function parseDailyLog(text: string, date: string): DailyLog {
  const lines = text.split('\n');
  const lastStart = lines.findLastIndex((line) => RUN_START.test(line));
  const steps: DailyLogStep[] = [];
  const failedSteps: string[] = [];
  const problems: string[] = [];
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let failedCount: number | null = null;
  for (const line of lines.slice(Math.max(lastStart, 0))) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(RUN_START))) startedAt = m[1]!;
    // run-daily.sh ends with `done (failed=N)`; the weekly sync.sh with a bare `done` or `done (up to date)`.
    else if ((m = line.match(/^===\s+(\S+\s+\S+)\s+done\b(?:\s*\(failed=(\d+)\))?/))) {
      finishedAt = m[1]!;
      failedCount = m[2] === undefined ? null : Number(m[2]);
    } else if ((m = line.match(/^---\s+(\d{2}:\d{2}:\d{2})\s+(.+)$/))) steps.push({ name: m[2]!.trim(), time: m[1]!, failed: false });
    else if ((m = line.match(/^!!!\s+step failed:\s+(.+)$/))) {
      const name = m[1]!.trim();
      failedSteps.push(name);
      const step = steps.find((s) => s.name === name);
      if (step) step.failed = true;
    } else if ((m = line.match(/^!!!\s+(.+)$/))) problems.push(m[1]!.trim());
  }
  // A failure line fails the run even with no done line: the scripts write one and exit.
  const failed = failedSteps.length > 0 || problems.length > 0 || (failedCount ?? 0) > 0;
  const status: DailyLog['status'] = !startedAt ? 'empty' : failed ? 'failed' : !finishedAt ? 'running' : 'ok';
  return { date, startedAt, finishedAt, status, steps, failedSteps, problems, failedCount };
}

/** The local calendar date (YYYY-MM-DD) the job scripts name their logs by (`date +%Y-%m-%d`). */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local date the day before `date` (YYYY-MM-DD). */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y!, m! - 1, d! - 1));
}

/**
 * A run with no done line is running only while the job runs, and only a log dated today or yesterday (a run that
 * crossed midnight writes to the file of the day it started) can belong to the run going on now: an older one is
 * interrupted without asking. Today's log asks the probe and null (unknown) keeps it running; yesterday's runs on only
 * when the probe says so, so a job with no probe (the weekly sync) does not keep yesterday's run alive, and only while
 * no run has started today: one run holds the job's lock, and a run started today writes today's log.
 */
export async function withJobState<T extends DailyLog>(log: T, today: string, jobRunning: () => Promise<boolean | null>, startedToday: () => boolean): Promise<T> {
  if (log.status !== 'running') return log;
  const interrupted = { ...log, status: 'interrupted' as const };
  if (log.date === today) return (await jobRunning()) === false ? interrupted : log;
  if (log.date === dayBefore(today)) return !startedToday() && (await jobRunning()) === true ? log : interrupted;
  return interrupted;
}

/** Whether the job's log dated `date` has a run start line. */
export function logHasStart(dataRoot: string, date: string, logDir = path.join('data', 'immigration', 'logs')): boolean {
  const raw = readText(path.join(dataRoot, logDir, `${date}.log`));
  return raw.kind === 'ok' && parseDailyLog(raw.text, date).startedAt !== null;
}

export function listLogDates(dataRoot: string, logDir = path.join('data', 'immigration', 'logs')): string[] {
  const dir = path.join(dataRoot, logDir);
  try {
    return fs
      .readdirSync(dir)
      .map((n) => n.match(/^(\d{4}-\d{2}-\d{2})\.log$/)?.[1])
      .filter((d): d is string => Boolean(d))
      .sort()
      .reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function readDailyLog(dataRoot: string, date: string): DailyLog | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const read = readText(path.join(dataRoot, 'data', 'immigration', 'logs', `${date}.log`));
  return read.kind === 'ok' ? parseDailyLog(read.text, date) : null;
}

function pendingOf(v: unknown): { count: number | null; error: string | null } {
  if (v === null) return { count: null, error: null };
  if (Array.isArray(v)) return { count: v.length, error: null };
  const malformed = typeof v === 'object' && (v as { error?: unknown }).error === 'malformed JSON';
  return { count: null, error: malformed ? 'pending.json is not valid JSON' : 'pending.json is not a list of items' };
}

function readJson(p: string): unknown {
  const read = readText(p);
  if (read.kind !== 'ok') return null;
  try {
    return JSON.parse(read.text);
  } catch {
    return { error: 'malformed JSON', path: p };
  }
}

/**
 * `today` is the local date, as the scripts date their logs and digest sections; it dates digest staleness and the
 * latest log. dailyRunning answers whether run-daily.sh runs now (null: unknown), asked only for a recent run with no done line.
 */
export async function readImmigrationOverview(codeRoot: string, dataRoot: string, today = localDate(), dailyRunning: () => Promise<boolean | null> = async () => null): Promise<ImmigrationOverview> {
  const lib = await importCore<ImmigrationLib>(codeRoot, 'custom/immigration/lib.mjs');
  const imm = path.join(dataRoot, 'data', 'immigration');
  const digestRead = readText(path.join(imm, 'policy-digest.md'));
  let digest: ImmigrationOverview['digest'] = { kind: 'missing' };
  if (digestRead.kind === 'ok') {
    const sections = parseDigest(digestRead.text);
    const latestDate = sections.map((s) => s.date).sort().pop() ?? null;
    digest = { kind: 'ok', sections, latestDate, staleDays: latestDate ? daysBetween(latestDate, today) : null };
  }
  const changesRead = readText(path.join(imm, 'policy-changes.tsv'));
  const alertsRead = readText(path.join(imm, 'company-alerts.tsv'));
  const feedRead = readText(path.join(imm, 'official-feed.tsv'));
  // The core keeps only the latest alert per slug; the full history comes from the raw TSV.
  const latest = alertsRead.kind === 'ok' ? [...lib.parseCompanyAlerts(alertsRead.text)].map(([slug, a]) => ({ slug, ...a })) : [];
  const history: Record<string, unknown>[] = alertsRead.kind === 'ok' ? parseTsv(alertsRead.text) : [];
  const companies: CompanyFile[] = [];
  const companiesDir = path.join(imm, 'companies');
  try {
    for (const name of fs.readdirSync(companiesDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const p = path.join(companiesDir, name);
      companies.push(parseCompanyFile(fs.readFileSync(p, 'utf8'), name.replace(/\.md$/, ''), p, lib.readCheckedAt));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const logDates = listLogDates(dataRoot);
  const pending = pendingOf(readJson(path.join(imm, 'pending.json')));
  const latestLog = logDates[0] ? readDailyLog(dataRoot, logDates[0]) : null;
  return {
    digest,
    policyChanges: changesRead.kind === 'ok' ? lib.parsePolicyChanges(changesRead.text) : [],
    alerts: { latest, history },
    officialFeed: feedRead.kind === 'ok' ? parseTsv(feedRead.text) : [],
    companies,
    tiers: readJson(path.join(imm, 'sponsor-tiers.json')),
    seen: readJson(path.join(imm, 'seen.json')),
    pendingCount: pending.count,
    pendingError: pending.error,
    dailyLog: latestLog && (await withJobState(latestLog, today, dailyRunning, () => logHasStart(dataRoot, today))),
    logDates,
  };
}
