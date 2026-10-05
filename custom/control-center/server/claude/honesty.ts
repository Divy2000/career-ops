// Evaluation honesty gate (spec 4.3): a turn counts as "done" only when the
// process exited cleanly, produced output and, for report-producing modes, a
// new report appeared under reports/ (RESERVED sentinels ignored). A verdict
// line alone is never trusted; the score is read from the new report header.
import fs from 'node:fs';
import path from 'node:path';
import { isReservedReportFile, reportNumberOf, readReport } from '../domains/reports.js';
import { englishModeOf, type PolicyClass } from './modes.js';
import type { SessionStatus } from './sessions.js';

export interface NewReport {
  num: number;
  file: string;
  score: number | null;
}

export function snapshotReports(dataRoot: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(dataRoot, 'reports')).filter((n) => !isReservedReportFile(n) && reportNumberOf(n) !== null));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

/** Reports present now that were not in the snapshot, with the header score (null when unreadable). */
export function detectNewReports(dataRoot: string, before: Set<string>): NewReport[] {
  const out: NewReport[] = [];
  for (const file of snapshotReports(dataRoot)) {
    if (before.has(file)) continue;
    const num = reportNumberOf(file)!;
    const read = readReport(dataRoot, num);
    out.push({ num, file, score: read.kind === 'ok' ? read.report.score : null });
  }
  return out.sort((a, b) => a.num - b.num);
}

/**
 * The reports a turn may claim: with a reserved number, exactly that report;
 * otherwise only reports the turn itself wrote (its files log), so parallel
 * sessions never credit each other's reports.
 */
export function ownReports(found: NewReport[], opts: { reportNum: number | null; turnFiles: string[] }): NewReport[] {
  if (opts.reportNum !== null) return found.filter((r) => r.num === opts.reportNum);
  const written = new Set(opts.turnFiles.filter((p) => p.startsWith('reports/')).map((p) => p.slice('reports/'.length)));
  return found.filter((r) => written.has(r.file));
}

/** Modes whose turn is an evaluation of one posting and must leave a report behind, in every language. */
export function isReportGated(modeId: string): boolean {
  const id = englishModeOf(modeId);
  return id === 'oferta' || id === 'auto-pipeline' || id.startsWith('regional/') || id.endsWith('/oferta');
}

/**
 * Modes whose contract demands a terminal envelope (invocation.ts ENVELOPE_CONTRACT). Advisor proposes an action
 * only when one fits and ai-search emits one line per posting it found, so both may end in prose and follow the
 * question rule like any other mode.
 */
export const ENVELOPE_MODES = new Set(['apply', 'cv-ingest', 'projects-ingest']);

export function endsWithQuestion(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /\?\s*$/.test(last) || /\?\s*\**\s*$/.test(last);
}

export interface TurnOutcomeInput {
  modeId: string;
  policyClass: PolicyClass;
  cancelled: boolean;
  exitCode: number | null;
  isError: boolean;
  sawResult: boolean;
  finalText: string;
  envelopeCount: number;
  newReports: NewReport[];
}

export type TurnOutcome = { status: Extract<SessionStatus, 'done' | 'awaiting_user' | 'error' | 'cancelled'>; reason: string };

export function decideTurnOutcome(i: TurnOutcomeInput): TurnOutcome {
  if (i.cancelled) return { status: 'cancelled', reason: 'cancelled by the user' };
  if (i.exitCode !== 0) return { status: 'error', reason: `claude exited ${i.exitCode ?? 'by signal'}` };
  if (i.isError) return { status: 'error', reason: 'claude reported is_error' };
  if (!i.sawResult) return { status: 'error', reason: 'the stream ended without a result event' };
  if (isReportGated(i.modeId)) {
    if (i.newReports.length === 0) return { status: 'awaiting_user', reason: 'clean exit but no new report under reports/; not marked done' };
    if (!i.finalText.trim()) return { status: 'awaiting_user', reason: 'a report appeared but the turn produced no output' };
    return { status: 'done', reason: `report ${i.newReports.map((r) => r.file).join(', ')} created` };
  }
  if (ENVELOPE_MODES.has(i.modeId)) {
    return i.envelopeCount > 0 ? { status: 'done', reason: 'terminal envelope received' } : { status: 'awaiting_user', reason: 'no terminal envelope in the output' };
  }
  if (endsWithQuestion(i.finalText)) return { status: 'awaiting_user', reason: 'the turn ended with a question' };
  return { status: 'done', reason: 'clean exit with output' };
}
