import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../config.js';
import { coreModuleUrl, runModule, childJson } from '../core/child.js';
import type { FollowupEdit, FollowupEditResult } from './followups-edit.js';

export interface PipelineOffer {
  url: string;
  company: string;
  title: string;
  location?: string;
  portal?: string;
}

const env = (dataRoot: string) => ({ CAREER_OPS_ROOT: dataRoot, NO_COLOR: '1' });

/** Append offers to data/pipeline.md (and scan-history) through the core writers in a child. */
export async function appendOffers(codeRoot: string, dataRoot: string, offers: PipelineOffer[], history: boolean): Promise<{ added: number }> {
  const code = `
import fs from 'node:fs';
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(coreModuleUrl(codeRoot, 'scan.mjs'))};
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
await appendToPipeline(req.offers);
if (req.history) await appendToScanHistory(req.offers, req.date, 'added');
process.stdout.write(JSON.stringify({ ok: true, added: req.offers.length }));
`;
  const r = await runModule(code, { cwd: codeRoot, env: env(dataRoot), input: { offers, history, date: new Date().toISOString().slice(0, 10) }, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`pipeline writer exited ${r.code}: ${r.stderr.trim().slice(-600)}`);
  return childJson<{ added: number }>(r);
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
