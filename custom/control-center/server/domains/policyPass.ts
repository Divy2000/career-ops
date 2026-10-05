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
import type { Exec } from '../routes/system.js';

const IMM = path.join('data', 'immigration');
const PENDING = path.join(IMM, 'pending.json');

export class PendingUnreadableError extends Error {
  constructor(problem: string) {
    super(`${PENDING} ${problem}; fix or remove it, then run the pass again`);
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

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export function preparePolicyPass(codeRoot: string, dataRoot: string, now = new Date()): PolicyPass {
  const items = readPending(dataRoot);
  const today = localDate(now);
  // The shape watch.mjs prints and --ack reads (new_items[].id).
  const watchJson = JSON.stringify({ date: today, new_items: items }, null, 2);
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

/** Acknowledges a done pass's batch; returns what to add to the turn's reason. */
export async function ackPolicyPass(exec: Exec, codeRoot: string, dataRoot: string, batch: string): Promise<string> {
  const r = await exec(process.execPath, [cliScriptPath(codeRoot, 'immigrationWatch'), '--ack', path.join(dataRoot, batch)], { cwd: codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: dataRoot, NO_COLOR: '1' } });
  if (r.code !== 0) return `could not acknowledge the policy items it was given: ${(r.stderr || r.stdout).trim().slice(-200)}`;
  return r.stdout.trim();
}
