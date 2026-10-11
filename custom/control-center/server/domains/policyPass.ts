// The Sponsorship page's manual AI policy pass, run the way custom/immigration/run-daily.sh runs the daily one: the
// items watch.mjs queued in pending.json are snapshotted into an immutable batch file, the pass gets
// daily-prompt.md filled in with them, and only a pass that ends done acknowledges that batch (watch.mjs --ack).
// Its items then leave the queue, so the next daily run does not send them to Claude again; items queued while the
// pass ran are not in the batch and stay pending.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cliScriptPath } from '../core/adapter.js';
import { localDate } from '../../shared/local-date.js';
import { newsSince } from '../../../immigration/lib.mjs';
import { ownerLive, readClaim, releaseClaim, retagClaim, runUnfinished, tryClaim } from '../../../immigration/policy-claim.mjs';
import type { Exec } from '../routes/system.js';

const IMM = path.join('data', 'immigration');
const PENDING = path.join(IMM, 'pending.json');
const SEEN = path.join(IMM, 'seen.json');

/** A queue file the pass reads (pending.json, or seen.json for the last pass) is not in the shape watch.mjs writes. */
export class PendingUnreadableError extends Error {
  constructor(problem: string, file = PENDING) {
    super(`${file} ${problem}; fix or remove it, then run the pass again`);
    this.name = 'PendingUnreadableError';
  }
}

export interface PolicyPass {
  /** daily-prompt.md filled in for this data root, today and the queued items. */
  prompt: string;
  /** The batch file to acknowledge when the pass is done (relative to the data root); null when nothing was queued. */
  batch: string | null;
}

function readPending(dataRoot: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataRoot, PENDING), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch {
    throw new PendingUnreadableError('is not valid JSON');
  }
  if (!Array.isArray(items)) throw new PendingUnreadableError('is not a list of items');
  return items;
}

// The day of the last successful pass, which watch.mjs --ack records; null before the first one.
function readLastPass(dataRoot: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataRoot, SEEN), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let seen: unknown;
  try {
    seen = JSON.parse(text);
  } catch {
    throw new PendingUnreadableError('is not valid JSON', SEEN);
  }
  const lastPass = (seen as { last_pass?: unknown } | null)?.last_pass;
  if (lastPass === undefined || lastPass === null) return null;
  if (typeof lastPass !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastPass)) throw new PendingUnreadableError('has a last_pass that is not a YYYY-MM-DD date', SEEN);
  return lastPass;
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export function preparePolicyPass(codeRoot: string, dataRoot: string, now = new Date()): PolicyPass {
  const items = readPending(dataRoot);
  const today = localDate(now);
  // The news window daily-prompt.md searches, as watch.mjs prints it: back to the last successful pass, at least 3 days.
  const lastPass = readLastPass(dataRoot);
  let since: string;
  try {
    since = newsSince({ lastPass, today });
  } catch {
    throw new PendingUnreadableError('has a last_pass that is not a YYYY-MM-DD date', SEEN);
  }
  // The shape watch.mjs prints and --ack reads (new_items[].id).
  const watchJson = JSON.stringify({ date: today, news_since: since, new_items: items }, null, 2);
  let batch: string | null = null;
  if (items.length > 0) {
    batch = path.join(IMM, 'batches', `${stamp(now)}-cc-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.mkdirSync(path.join(dataRoot, IMM, 'batches'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, batch), watchJson, { flag: 'wx' });
  }
  const template = fs.readFileSync(path.join(codeRoot, 'custom', 'immigration', 'daily-prompt.md'), 'utf8');
  // Replacer functions, as run-daily.sh does: a string replacement would expand $& and the like in the feed JSON or a path.
  const prompt = template
    .replaceAll('{{TODAY}}', () => today)
    .replaceAll('{{IMM}}', () => path.join(dataRoot, IMM))
    .replaceAll('{{PROFILE}}', () => path.join(dataRoot, 'config', 'profile.yml'))
    .replace('{{WATCH_JSON}}', () => watchJson);
  return { prompt, batch };
}

/** A failed ack (pending.json.lock busy, a timeout) is tried this many times, waiting longer each time. */
const ACK_ATTEMPTS = 3;
const ACK_RETRY_MS = 250;

/**
 * Acknowledges a done pass's batch: `ok` says whether it landed, `text` is what to add to the turn's reason. A failed
 * attempt is tried again, since an ack lost here leaves the items queued for the next pass to send to Claude again.
 * watch.mjs --ack is idempotent (it drops the batch's ids from the queue), so a retry is safe.
 */
export async function ackPolicyPass(exec: Exec, codeRoot: string, dataRoot: string, batch: string, opts: { retryMs?: number } = {}): Promise<{ ok: boolean; text: string }> {
  const retryMs = opts.retryMs ?? ACK_RETRY_MS;
  let failure = '';
  for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, retryMs * (attempt - 1)));
    try {
      const r = await exec(process.execPath, [cliScriptPath(codeRoot, 'immigrationWatch'), '--ack', path.join(dataRoot, batch)], { cwd: codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: dataRoot, NO_COLOR: '1' } });
      if (r.code === 0) return { ok: true, text: r.stdout.trim() };
      failure = (r.stderr || r.stdout).trim().slice(-200) || `exit ${r.code}`;
    } catch (err) {
      failure = (err as Error).message;
    }
  }
  return { ok: false, text: `could not acknowledge the policy items it was given: ${failure}` };
}

/**
 * A pass that ended done leaves `<batch>.done` beside its batch until the ack lands, so an ack that failed is tried
 * again later whatever became of the session (a later turn, a delete, a restart).
 */
const DONE_MARK = '.done';

export function recordDonePolicyBatch(dataRoot: string, batch: string): void {
  fs.writeFileSync(path.join(dataRoot, batch + DONE_MARK), `${new Date().toISOString()}\n`);
}

export function forgetDonePolicyBatch(dataRoot: string, batch: string): void {
  fs.rmSync(path.join(dataRoot, batch + DONE_MARK), { force: true });
}

/** The batches (relative to the data root) of done passes whose ack has not landed yet. */
export function donePolicyBatches(dataRoot: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dataRoot, IMM, 'batches'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => n.endsWith(DONE_MARK)).map((n) => path.join(IMM, 'batches', n.slice(0, -DONE_MARK.length)));
}

/** The day a batch's pass was prepared (its watch JSON `date`), or null when the batch cannot be read. */
export function policyBatchDay(dataRoot: string, batch: string): string | null {
  try {
    const date = (JSON.parse(fs.readFileSync(path.join(dataRoot, batch), 'utf8')) as { date?: unknown } | null)?.date;
    return typeof date === 'string' ? date : null;
  } catch {
    return null;
  }
}

/**
 * One AI policy pass at a time, across this app and the scheduled daily job (custom/immigration/policy-claim.mjs): a
 * pass holds data/immigration/.policy-pass.claim from its start until its session ends (done, error, cancelled) or is
 * deleted and its Claude run has exited; a session paused for a reply keeps it.
 */
export const policyClaim = {
  take: (dataRoot: string, owner: string, opts: { batch?: string | null; takeFrom?: string } = {}): { ok: true } | { ok: false; holder: { owner: string } } =>
    tryClaim(dataRoot, { owner, batch: opts.batch ?? null, takeFrom: opts.takeFrom ?? null }),
  retag: (dataRoot: string, from: string, to: string): boolean => retagClaim(dataRoot, from, to),
  release: (dataRoot: string, owner: string): boolean => releaseClaim(dataRoot, owner),
  /** Whether a run has not ended yet (no end time, no exit record). */
  runUnfinished: (dataRoot: string, runId: string | undefined): boolean => runUnfinished(dataRoot, runId),
  /** The live holder of the claim, or null. */
  holder: (dataRoot: string): { owner: string } | null => {
    const c = readClaim(dataRoot) as { owner: string } | null;
    return c && ownerLive(dataRoot, c) ? c : null;
  },
};

/** What a 409 says about who holds the pass. */
export function claimHolderText(owner: string): string {
  if (owner.startsWith('daily:')) return 'the daily job is running its AI policy pass';
  if (owner.startsWith('session:')) return `an AI policy pass is already running or waiting for a reply (session ${owner.slice('session:'.length)})`;
  return 'an AI policy pass is starting';
}
