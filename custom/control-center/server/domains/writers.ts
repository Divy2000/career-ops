import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../config.js';
import { coreModuleUrl, runModule, childJson } from '../core/child.js';
import { localDate } from '../../shared/local-date.js';
import type { FollowupEdit, FollowupEditResult } from './followups-edit.js';

export interface PipelineOffer {
  url: string;
  company: string;
  title: string;
  location?: string;
  portal?: string;
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
  for (const line of fs.readFileSync(SCAN_HISTORY_PATH, 'utf8').split('\\n').slice(1)) {
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
await appendToPipeline(fresh);
// The pipeline and history writes are two locked steps, so an add can land in the pipeline and fail before its history
// row; the retry then skips the URL as listed. Such a URL gets its history row now, so it is still recorded once.
const historyRows = [...fresh, ...unrecorded];
if (req.history && historyRows.length) await appendToScanHistory(historyRows, req.date, 'added');
process.stdout.write(JSON.stringify({ ok: true, added: fresh.length, skipped: req.offers.length - fresh.length }));
`;
    const r = await runModule(code, { cwd: codeRoot, env: env(dataRoot), input: { offers, history, date: localDate() }, timeoutMs: 30_000 });
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
      fs.mkdirSync(path.dirname(req.path), { recursive: true });
      const tmp = req.path + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, r.text);
      fs.renameSync(tmp, req.path);
    }
    return r;
  }, { timeoutMs: req.timeoutMs, retryMs: 50 });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  const busy = e && (e.code === 'LOCK_TIMEOUT' || /lock/i.test(String(e.message)));
  process.stdout.write(JSON.stringify({ ok: false, error: busy ? 'busy' : String(e && e.message) }));
  process.exit(busy ? 75 : 1);
}
`;
    const r = await runModule(code, { cwd: codeRoot, env: env(dataRoot), input: { path: path.join(dataRoot, 'data', 'follow-ups.md'), edit, timeoutMs: 5000 }, timeoutMs: 30_000 });
    if (r.code === 75) throw new FollowupsBusyError('follow-ups file is busy, try again in a moment');
    if (r.code !== 0 && !r.stdout.trim()) throw new Error(`follow-ups writer exited ${r.code}: ${r.stderr.trim().slice(-600)}`);
    return childJson<FollowupEditResult>(r);
  });
}
