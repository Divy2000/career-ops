// Dev Chat change sets (spec 4.6): per-turn snapshots taken by the guard hook
// are turned into unified diffs and can be reverted per file or per turn. This
// lives under supervisor/ so /__recovery keeps working even when Dev Chat broke
// the server; Dev Chat cannot edit supervisor/**.
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';

export interface ChangeRecord {
  path: string;
  abs: string;
  root: 'code' | 'data';
  tool: string;
  ts: string;
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
      if (rec.abs && rec.path) out.push({ path: rec.path, abs: rec.abs, root: rec.root ?? 'code', tool: rec.tool ?? '', ts: rec.ts ?? '' });
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

export type RevertResult = 'restored' | 'deleted' | 'no-snapshot';

/** Restores the pre-turn bytes (or deletes a file the turn created). */
export function revertFile(turnDir: string, abs: string): RevertResult {
  const key = snapshotKey(turnDir, abs);
  if (fs.existsSync(key)) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(key, abs);
    return 'restored';
  }
  if (fs.existsSync(`${key}.absent`)) {
    fs.rmSync(abs, { force: true });
    return 'deleted';
  }
  return 'no-snapshot';
}

export function revertTurn(sessionDir: string, meta: MetaLike, n: number): Array<{ abs: string; result: RevertResult }> {
  const turn = changesByTurn(sessionDir, meta).find((t) => t.n === n);
  if (!turn) return [];
  const turnDir = path.join(sessionDir, 'turns', String(n));
  return turn.records.map((r) => ({ abs: r.abs, result: revertFile(turnDir, r.abs) }));
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
