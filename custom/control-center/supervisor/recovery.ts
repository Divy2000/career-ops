// Dev Chat change sets (spec 4.6): per-turn snapshots taken by the guard hook
// are turned into unified diffs and can be reverted per file or per turn. This
// lives under supervisor/ so /__recovery keeps working even when Dev Chat broke
// the server; Dev Chat cannot edit supervisor/**.
//
// Reverts write and delete files, so every target is re-checked: it must
// resolve inside the code or data root, match the allow list (and miss the deny
// list) of the policy that turn ran under, and still hold the bytes the turn
// left (the post-turn sha256 recorded at finalize). Anything else is refused.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { locate, matches, resolveReal } from '../server/claude/guard-policy.mjs';

export interface ChangeRecord {
  path: string;
  abs: string;
  root: 'code' | 'data';
  tool: string;
  ts: string;
  /** sha256 of the file right after this write (null: absent), taken by the PostToolUse hook; missing on old records. */
  sha256?: string | null;
}

export interface FileDiff {
  path: string;
  abs: string;
  root: 'code' | 'data';
  status: 'added' | 'modified' | 'deleted' | 'unchanged' | 'no-snapshot';
  additions: number;
  deletions: number;
  patch: string;
  canRevert: boolean;
}

export interface TurnChanges {
  n: number;
  files: FileDiff[];
}

interface MetaLike {
  id: string;
  mode: string;
  turns: Array<{ n: number }>;
}

/**
 * Per-session bookkeeping (turn policies, hook settings, files.ndjson, per-turn
 * snapshots) under the guard root, which is outside every session's write scope.
 */
export function guardSessionDir(guardRoot: string, sessionId: string): string {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('bad session id');
  return path.join(guardRoot, 'sessions', sessionId);
}

export function snapshotKey(turnDir: string, abs: string): string {
  return path.join(turnDir, 'before', encodeURIComponent(abs));
}

export function readFilesLog(sessionDir: string): ChangeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(sessionDir, 'files.ndjson'), 'utf8');
  } catch {
    return [];
  }
  const out: ChangeRecord[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line) as Partial<ChangeRecord>;
      if (!rec.abs || !rec.path) continue;
      const sha256 = rec.sha256 === null || (typeof rec.sha256 === 'string' && /^[0-9a-f]{64}$/.test(rec.sha256)) ? rec.sha256 : undefined;
      out.push({ path: rec.path, abs: rec.abs, root: rec.root ?? 'code', tool: rec.tool ?? '', ts: rec.ts ?? '', ...(sha256 !== undefined ? { sha256 } : {}) });
    } catch {
      /* torn line */
    }
  }
  return out;
}

function turnOffset(sessionDir: string, n: number): number | null {
  try {
    return (JSON.parse(fs.readFileSync(path.join(sessionDir, 'turns', String(n), 'turn.json'), 'utf8')) as { filesOffset?: number }).filesOffset ?? 0;
  } catch {
    return null;
  }
}

/** Change records grouped by turn using the files.ndjson offsets recorded at each turn start. */
export function changesByTurn(sessionDir: string, meta: MetaLike): Array<{ n: number; records: ChangeRecord[] }> {
  const all = readFilesLog(sessionDir);
  const turns = meta.turns.map((t) => t.n).sort((a, b) => a - b);
  return turns.map((n, i) => {
    const start = turnOffset(sessionDir, n) ?? 0;
    const next = turns[i + 1];
    const end = next !== undefined ? (turnOffset(sessionDir, next) ?? all.length) : all.length;
    const seen = new Set<string>();
    const records = all.slice(start, end).filter((r) => (seen.has(r.abs) ? false : (seen.add(r.abs), true)));
    return { n, records };
  });
}

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** `after` is the file as the turn left it: the next turn's snapshot when one exists, else the file on disk now. */
export function diffFile(turnDir: string, rec: ChangeRecord, after?: { exists: boolean; text: string }): FileDiff {
  const key = snapshotKey(turnDir, rec.abs);
  const hadSnapshot = fs.existsSync(key);
  const wasAbsent = fs.existsSync(`${key}.absent`);
  const exists = after ? after.exists : fs.existsSync(rec.abs);
  const current = after ? after.text : exists ? fs.readFileSync(rec.abs, 'utf8') : '';
  if (!hadSnapshot && !wasAbsent) return { ...rec, status: 'no-snapshot', additions: 0, deletions: 0, patch: '', canRevert: false };
  const before = hadSnapshot ? fs.readFileSync(key, 'utf8') : '';
  const status: FileDiff['status'] = wasAbsent ? (exists ? 'added' : 'unchanged') : !exists ? 'deleted' : before === current ? 'unchanged' : 'modified';
  const patch = status === 'unchanged' ? '' : createTwoFilesPatch(wasAbsent ? '/dev/null' : `a/${rec.path}`, exists ? `b/${rec.path}` : '/dev/null', before, current, '', '', { context: 3 });
  return { ...rec, status, ...countLines(patch), patch, canRevert: status !== 'unchanged' };
}

function snapshotState(turnDir: string, abs: string): { exists: boolean; text: string } | null {
  const key = snapshotKey(turnDir, abs);
  if (fs.existsSync(key)) return { exists: true, text: fs.readFileSync(key, 'utf8') };
  if (fs.existsSync(`${key}.absent`)) return { exists: false, text: '' };
  return null;
}

export function listChanges(sessionDir: string, meta: MetaLike): TurnChanges[] {
  const grouped = changesByTurn(sessionDir, meta);
  return grouped.map(({ n, records }, i) => ({
    n,
    files: records.map((r) => {
      let after: { exists: boolean; text: string } | undefined;
      for (const later of grouped.slice(i + 1)) {
        const snap = snapshotState(path.join(sessionDir, 'turns', String(later.n)), r.abs);
        if (snap) {
          after = snap;
          break;
        }
      }
      return diffFile(path.join(sessionDir, 'turns', String(n)), r, after);
    }),
  }));
}

/** 'unchanged': the file already holds its pre-turn bytes, so there is nothing to do. */
export type RevertResult = 'restored' | 'deleted' | 'unchanged' | 'no-snapshot';

/** The roots the caller itself is configured with (never the ones a record or policy claims). */
export interface RevertContext {
  codeRoot: string;
  dataRoot: string;
}

/** A revert that was not performed: 403 out of scope, 404 unknown, 409 conflict or unverifiable. */
export class RevertRefused extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    message: string,
    readonly conflicts: string[] = [],
  ) {
    super(message);
  }
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function fileHash(abs: string): string | null {
  try {
    return sha256(fs.readFileSync(abs));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Writes turns/<n>/after.json: for every file the turn changed, the sha256 its
 * last write left (null for absent), as the hook recorded it at write time. The
 * disk is not read here: finalizing late (after a restart) must not adopt edits
 * made since. A file whose last record has no hash gets no entry, so a revert
 * of it is refused.
 */
export function recordTurnAfter(sessionDir: string, n: number, fromLine: number): void {
  const files: Record<string, string | null> = {};
  for (const r of readFilesLog(sessionDir).slice(fromLine)) {
    if (r.sha256 === undefined) delete files[r.abs];
    else files[r.abs] = r.sha256;
  }
  const turnDir = path.join(sessionDir, 'turns', String(n));
  fs.mkdirSync(turnDir, { recursive: true });
  const file = path.join(turnDir, 'after.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ files, at: new Date().toISOString() }, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

type RevertPlan = { abs: string; action: 'restore' | 'delete' | 'unchanged' | 'no-snapshot'; key: string };

function planRevert(turnDir: string, abs: string, ctx: RevertContext): RevertPlan {
  const n = path.basename(turnDir);
  const found = locate({ codeRoot: ctx.codeRoot, dataRoot: ctx.dataRoot }, abs);
  if (!found || !path.isAbsolute(abs)) throw new RevertRefused(403, `${abs} is outside the code and data roots; refusing to revert it`);
  const policy = readJson<{ allow?: string[]; deny?: string[] }>(path.join(turnDir, 'policy.json'));
  if (!policy || !Array.isArray(policy.allow) || !Array.isArray(policy.deny)) throw new RevertRefused(409, `turn ${n} has no recorded policy, so ${found.rel} cannot be checked against its write scope`);
  if (!matches(found.rel, policy.allow) || matches(found.rel, policy.deny)) throw new RevertRefused(403, `${found.rel} is outside turn ${n}'s write scope; refusing to revert it`);
  const key = snapshotKey(turnDir, abs);
  const hadSnapshot = fs.existsSync(key);
  const wasAbsent = !hadSnapshot && fs.existsSync(`${key}.absent`);
  if (!hadSnapshot && !wasAbsent) return { abs, action: 'no-snapshot', key };
  const after = readJson<{ files?: Record<string, string | null> }>(path.join(turnDir, 'after.json'))?.files;
  if (!after || !(abs in after)) throw new RevertRefused(409, `turn ${n} has no post-turn record for ${found.rel} (it did not finish), so a later edit cannot be ruled out; nothing was reverted`, [found.rel]);
  const current = fileHash(abs);
  if (current === after[abs]) return { abs, action: wasAbsent ? 'delete' : 'restore', key };
  const before = wasAbsent ? null : sha256(fs.readFileSync(key));
  if (current === before) return { abs, action: 'unchanged', key };
  throw new RevertRefused(409, `${found.rel} changed after turn ${n} (a later turn or another edit); revert that change first or edit the file by hand. Nothing was reverted.`, [found.rel]);
}

function applyRevert(plan: RevertPlan): RevertResult {
  if (plan.action === 'restore') {
    // Write next to the real file and rename over it, so a crash never leaves a half-written file.
    const real = resolveReal(plan.abs);
    fs.mkdirSync(path.dirname(real), { recursive: true });
    const tmp = `${real}.cc-revert-${process.pid}`;
    fs.copyFileSync(plan.key, tmp);
    fs.renameSync(tmp, real);
    return 'restored';
  }
  if (plan.action === 'delete') {
    fs.rmSync(plan.abs, { force: true });
    return 'deleted';
  }
  return plan.action;
}

/** Restores the pre-turn bytes (or deletes a file the turn created) after the checks above; throws RevertRefused otherwise. */
export function revertFile(turnDir: string, abs: string, ctx: RevertContext): RevertResult {
  return applyRevert(planRevert(turnDir, abs, ctx));
}

/** All or nothing: every file of the turn is checked before any is written. */
export function revertTurn(sessionDir: string, meta: MetaLike, n: number, ctx: RevertContext): Array<{ abs: string; result: RevertResult }> {
  const turn = changesByTurn(sessionDir, meta).find((t) => t.n === n);
  if (!turn) return [];
  const turnDir = path.join(sessionDir, 'turns', String(n));
  const plans: RevertPlan[] = [];
  const conflicts: string[] = [];
  let first: RevertRefused | null = null;
  for (const r of turn.records) {
    try {
      plans.push(planRevert(turnDir, r.abs, ctx));
    } catch (err) {
      if (!(err instanceof RevertRefused)) throw err;
      if (err.status === 403) throw err;
      first ??= err;
      conflicts.push(...err.conflicts);
    }
  }
  if (first) throw new RevertRefused(409, conflicts.length > 1 ? `${conflicts.join(', ')} changed after turn ${n} or cannot be verified; nothing was reverted` : first.message, conflicts);
  return plans.map((p) => ({ abs: p.abs, result: applyRevert(p) }));
}

/** The recovery page's POSTs carry the app origin and X-CC: 1 (sent by its inline script), like every mutating API call. */
export function recoveryRequestAllowed(headers: Record<string, string | string[] | undefined>, port: number): boolean {
  const origin = headers.origin;
  return (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) && headers['x-cc'] === '1';
}

/** POST /__recovery/revert after the request checks: the same rules as POST /api/dev/revert. */
export function recoveryRevert(opts: { sessionsDir: string; guardRoot: string; ctx: RevertContext; sessionId: string; turn: number; abs?: string | null }): { status: number; text: string } {
  const meta = listDevSessions(opts.sessionsDir).find((m) => m.id === opts.sessionId);
  if (!meta || !Number.isInteger(opts.turn)) return { status: 404, text: 'unknown session or turn' };
  if (meta.status === 'running' || meta.status === 'queued') return { status: 409, text: 'the session is still running; cancel it before reverting' };
  const sessionDir = guardSessionDir(opts.guardRoot, meta.id);
  try {
    if (opts.abs) {
      const known = changesByTurn(sessionDir, meta).find((t) => t.n === opts.turn)?.records.some((r) => r.abs === opts.abs);
      if (!known) return { status: 404, text: 'that file was not changed in that turn' };
      const result = revertFile(path.join(sessionDir, 'turns', String(opts.turn)), opts.abs, opts.ctx);
      return { status: 200, text: `${path.basename(opts.abs)}: ${result}` };
    }
    const results = revertTurn(sessionDir, meta, opts.turn, opts.ctx);
    return { status: 200, text: results.map((r) => `${path.basename(r.abs)}: ${r.result}`).join('\n') || 'nothing to revert' };
  } catch (err) {
    if (err instanceof RevertRefused) return { status: err.status, text: err.message };
    throw err;
  }
}

/** Dev Chat sessions on disk, newest first, for the recovery page. */
export function listDevSessions(sessionsDir: string): Array<MetaLike & { createdAt: string; status: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const out: Array<MetaLike & { createdAt: string; status: string }> = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, name, 'meta.json'), 'utf8')) as MetaLike & { createdAt: string; status: string };
      if (meta.mode === 'devchat') out.push(meta);
    } catch {
      /* not a session */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
