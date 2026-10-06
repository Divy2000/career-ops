import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../config.js';
import { coreModuleUrl, runModule, childJson } from '../core/child.js';
import { localDate } from '../../shared/local-date.js';
import { containedTarget, dataRootOnly } from '../lib/atomic-write.js';
import type { FollowupEdit, FollowupEditResult } from './followups-edit.js';

export interface PipelineOffer {
  url: string;
  company: string;
  title: string;
  location?: string;
  portal?: string;
  /** YYYY-MM-DD. */
  postedAt?: string;
}

/**
 * An offer in scan.mjs's own shape: it reads the ATS from `source` (scan-history's portal column) and the posting date
 * from `postedAt` as epoch ms (formatPipelineOffer's `posted:` segment, formatScanHistoryRow's posted_at column).
 */
function scanOffer(o: PipelineOffer): Record<string, unknown> {
  const { portal, postedAt, ...rest } = o;
  return { ...rest, ...(portal !== undefined ? { source: portal } : {}), ...(postedAt !== undefined ? { postedAt: Date.parse(`${postedAt}T00:00:00Z`) } : {}) };
}

const env = (dataRoot: string) => ({ CAREER_OPS_ROOT: dataRoot, NO_COLOR: '1' });

/**
 * Append offers to data/pipeline.md (and scan-history) through the core writers in a child. Idempotent, so a retried
 * request adds nothing twice: an offer whose URL the pipeline already lists (pending or processed), or that came earlier
 * in the same request, is skipped, with the URL keys and pipeline parsing the scanners dedupe with (scan.mjs
 * collectSeenUrls and normalizeUrlForDedup).
 * A URL the pipeline lists but scan-history lacks (an earlier add whose history write failed) gets its history row.
 * The in-process queue serializes this server's adds; appendToPipeline takes the pipeline lock only around its own
 * write, so a scanner appending the very same new URL in between is the one race left (the scanners dedupe too).
 */
export function appendOffers(codeRoot: string, dataRoot: string, offers: PipelineOffer[], history: boolean): Promise<{ added: number; skipped: number }> {
  return serialized(async () => {
    // scan.mjs writes through any symlink: a pipeline or history file that leads outside the data root is refused here.
    const pipelineFile = path.join(dataRoot, 'data', 'pipeline.md');
    const historyFile = path.join(dataRoot, 'data', 'scan-history.tsv');
    containedTarget(pipelineFile, dataRootOnly(dataRoot));
    if (history) containedTarget(historyFile, dataRootOnly(dataRoot));
    const code = `
import fs from 'node:fs';
import { appendToPipeline, appendToScanHistory, collectSeenUrls, normalizeUrlForDedup, PIPELINE_PATH, SCAN_HISTORY_PATH } from ${JSON.stringify(coreModuleUrl(codeRoot, 'scan.mjs'))};
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const pipelineText = fs.existsSync(PIPELINE_PATH) ? fs.readFileSync(PIPELINE_PATH, 'utf8') : '';
const { seen } = collectSeenUrls({ pipelineText });
const listed = new Set(seen);
// Every URL history has a row for, whatever its status.
const recorded = new Set();
if (req.history && fs.existsSync(SCAN_HISTORY_PATH)) {
  const lines = fs.readFileSync(SCAN_HISTORY_PATH, 'utf8').split('\\n');
  // scan.mjs also accepts a headerless (legacy) history: skip line 1 only when it is the header.
  if (lines[0]?.startsWith('url\\t')) lines.shift();
  for (const line of lines) {
    const url = line.split('\\t')[0];
    if (url) recorded.add(normalizeUrlForDedup(url));
  }
}
const fresh = [];
const unrecorded = [];
for (const offer of req.offers) {
  const key = normalizeUrlForDedup(offer.url);
  if (seen.has(key)) {
    if (req.history && listed.has(key) && !recorded.has(key)) unrecorded.push(offer);
    recorded.add(key);
    continue;
  }
  seen.add(key);
  recorded.add(key);
  fresh.push(offer);
}
try {
  await appendToPipeline(fresh);
} catch (err) {
  // Another writer (a scan, rank, the CLI) held the pipeline lock past the wait: busy, not broken.
  if (err && err.name === 'LockTimeoutError') process.exit(75);
  throw err;
}
// The pipeline and history writes are two locked steps, so an add can land in the pipeline and fail before its history
// row; the retry then skips the URL as listed. Such a URL gets its history row now, so it is still recorded once.
const historyRows = [...fresh, ...unrecorded];
if (req.history && historyRows.length) {
  try {
    await appendToScanHistory(historyRows, req.date, 'added');
  } catch (err) {
    if (err && err.name === 'LockTimeoutError') process.exit(75);
    throw err;
  }
}
process.stdout.write(JSON.stringify({ ok: true, added: fresh.length, skipped: req.offers.length - fresh.length }));
`;
    // scan.mjs puts CAREER_OPS_PIPELINE and _SCAN_HISTORY ahead of the data root: pinned to the files checked above, so a
    // stray override in the server's environment cannot send the write somewhere else.
    const pinned = { ...env(dataRoot), CAREER_OPS_PIPELINE: pipelineFile, CAREER_OPS_SCAN_HISTORY: historyFile };
    const r = await runModule(code, { cwd: codeRoot, env: pinned, input: { offers: offers.map(scanOffer), history, date: localDate() }, timeoutMs: 30_000 });
    if (r.code === 75) throw new PipelineBusyError('pipeline is busy, try again in a moment');
    if (r.code !== 0) throw new Error(`pipeline writer exited ${r.code}: ${r.stderr.trim().slice(-600)}`);
    const out = childJson<{ added: number; skipped: number }>(r);
    return { added: out.added, skipped: out.skipped };
  });
}

// In-process queue outside, the core file lock inside (alpha ordering): the
// queue collapses this process's concurrent requests to one before the
// cross-process lock arbitrates against the CLI and the seeder.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export class FollowupsBusyError extends Error {}

/** The pipeline or scan-history lock stayed held past the writer's wait (exit 75 from the child). */
export class PipelineBusyError extends Error {}

export function editFollowups(codeRoot: string, dataRoot: string, edit: FollowupEdit): Promise<FollowupEditResult> {
  return serialized(async () => {
    const code = `
import fs from 'node:fs';
import path from 'node:path';
import { withFollowupsLock } from ${JSON.stringify(coreModuleUrl(codeRoot, 'followup-seed.mjs'))};
import { applyFollowupEdit } from ${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, 'server', 'domains', 'followups-edit.mjs')).href)};
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const out = await withFollowupsLock(req.path, () => {
    const text = fs.existsSync(req.path) ? fs.readFileSync(req.path, 'utf8') : '';
    const r = applyFollowupEdit(text, req.edit);
    if (r.ok && r.text !== text) {
      // The rename goes to the real file, so a follow-ups.md symlink stays a link.
      fs.mkdirSync(path.dirname(req.target), { recursive: true });
      const tmp = req.target + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, r.text);
      fs.renameSync(tmp, req.target);
    }
    return r;
  }, { timeoutMs: req.timeoutMs, retryMs: 50 });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  // Only followup-seed.mjs's own lock timeout is "busy"; any other failure (a path that merely contains "lock") is real.
  const busy = Boolean(e && e.code === 'LOCK_TIMEOUT');
  process.stdout.write(JSON.stringify({ ok: false, error: busy ? 'busy' : String(e && e.message) }));
  process.exit(busy ? 75 : 1);
}
`;
    const file = path.join(dataRoot, 'data', 'follow-ups.md');
    const target = containedTarget(file, dataRootOnly(dataRoot));
    const r = await runModule(code, { cwd: codeRoot, env: env(dataRoot), input: { path: file, target, edit, timeoutMs: 5000 }, timeoutMs: 30_000 });
    if (r.code === 75) throw new FollowupsBusyError('follow-ups file is busy, try again in a moment');
    // A refused edit (no such row, bad date) is ok:false with exit 0; any other exit is a failure the client cannot fix.
    if (r.code !== 0) {
      let reason = r.stderr.trim().slice(-600);
      try {
        reason = (JSON.parse(r.stdout) as { error?: string }).error ?? reason;
      } catch {
        /* no JSON on stdout: keep stderr */
      }
      throw new Error(`follow-ups writer exited ${r.code}: ${reason}`);
    }
    return childJson<FollowupEditResult>(r);
  });
}
