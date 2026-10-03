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
  status: 'ok' | 'failed' | 'running' | 'empty';
  steps: DailyLogStep[];
  failedSteps: string[];
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

export function parseDailyLog(text: string, date: string): DailyLog {
  const steps: DailyLogStep[] = [];
  const failedSteps: string[] = [];
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let failedCount: number | null = null;
  for (const line of text.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^===\s+(\S+\s+\S+)\s+start/))) startedAt = m[1]!;
    else if ((m = line.match(/^===\s+(\S+\s+\S+)\s+done\s*\(failed=(\d+)\)/))) {
      finishedAt = m[1]!;
      failedCount = Number(m[2]);
    } else if ((m = line.match(/^---\s+(\d{2}:\d{2}:\d{2})\s+(.+)$/))) steps.push({ name: m[2]!.trim(), time: m[1]!, failed: false });
    else if ((m = line.match(/^!!!\s+step failed:\s+(.+)$/))) {
      const name = m[1]!.trim();
      failedSteps.push(name);
      const step = steps.find((s) => s.name === name);
      if (step) step.failed = true;
    }
  }
  const status: DailyLog['status'] = !startedAt ? 'empty' : !finishedAt ? 'running' : failedSteps.length || (failedCount ?? 0) > 0 ? 'failed' : 'ok';
  return { date, startedAt, finishedAt, status, steps, failedSteps, failedCount };
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

function readJson(p: string): unknown {
  const read = readText(p);
  if (read.kind !== 'ok') return null;
  try {
    return JSON.parse(read.text);
  } catch {
    return { error: 'malformed JSON', path: p };
  }
}

export async function readImmigrationOverview(codeRoot: string, dataRoot: string, today = new Date().toISOString().slice(0, 10)): Promise<ImmigrationOverview> {
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
  return {
    digest,
    policyChanges: changesRead.kind === 'ok' ? lib.parsePolicyChanges(changesRead.text) : [],
    alerts: { latest, history },
    officialFeed: feedRead.kind === 'ok' ? parseTsv(feedRead.text) : [],
    companies,
    tiers: readJson(path.join(imm, 'sponsor-tiers.json')),
    seen: readJson(path.join(imm, 'seen.json')),
    dailyLog: logDates[0] ? readDailyLog(dataRoot, logDates[0]) : null,
    logDates,
  };
}
