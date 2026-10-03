// Session storage (spec 4.3): {DATA_ROOT}/data/control-center/sessions/<id>/
// {meta.json, events.ndjson, turns/<n>/, before/}. Sessions are never pruned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PolicyClass } from './modes.js';
import { monotonicIso } from '../runner/store.js';
import type { SessionEvent } from './stream-parse.js';

export type SessionStatus = 'queued' | 'running' | 'awaiting_user' | 'done' | 'error' | 'cancelled';
export type TargetType = 'app' | 'url' | 'company' | 'text' | 'none';

export interface SessionTurn {
  n: number;
  runId: string;
  userText: string;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  tokens: number;
  permissionDenials: number;
}

export interface SessionMeta {
  id: string;
  claudeSessionId: string;
  mode: string;
  policyClass: PolicyClass;
  target: { type: TargetType; value: string | null };
  model: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
  totals: { costUsd: number; tokens: number };
  filesChanged: string[];
  forkedFrom: string | null;
  error: string | null;
  /** Report number reserved for this evaluation (fan-out), released when unused. */
  reportNum: number | null;
  /** Why the last turn ended in its status (honesty gate reason). */
  lastReason: string | null;
}

export interface StoredEvent {
  seq: number;
  ts: string;
  event: SessionEvent;
}

export function sessionsDir(dataRoot: string): string {
  return path.join(dataRoot, 'data', 'control-center', 'sessions');
}

function newId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `s${ts}-${crypto.randomBytes(3).toString('hex')}`;
}

export class SessionStore {
  constructor(private dataRoot: string) {
    fs.mkdirSync(sessionsDir(dataRoot), { recursive: true });
  }

  dirOf(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('bad session id');
    return path.join(sessionsDir(this.dataRoot), id);
  }

  create(input: { mode: string; policyClass: PolicyClass; target: SessionMeta['target']; model: string | null; claudeSessionId?: string; forkedFrom?: string; reportNum?: number | null }): SessionMeta {
    const now = monotonicIso();
    const meta: SessionMeta = {
      id: newId(),
      claudeSessionId: input.claudeSessionId ?? crypto.randomUUID(),
      mode: input.mode,
      policyClass: input.policyClass,
      target: input.target,
      model: input.model,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      turns: [],
      totals: { costUsd: 0, tokens: 0 },
      filesChanged: [],
      forkedFrom: input.forkedFrom ?? null,
      error: null,
      reportNum: input.reportNum ?? null,
      lastReason: null,
    };
    fs.mkdirSync(path.join(this.dirOf(meta.id), 'before'), { recursive: true });
    this.write(meta);
    return meta;
  }

  /** Fork: a new session id that resumes the same Claude uuid (`--resume <uuid> --fork-session`). */
  fork(id: string): SessionMeta {
    const src = this.mustRead(id);
    return this.create({ mode: src.mode, policyClass: src.policyClass, target: src.target, model: src.model, claudeSessionId: src.claudeSessionId, forkedFrom: src.id });
  }

  write(meta: SessionMeta): void {
    const p = path.join(this.dirOf(meta.id), 'meta.json');
    fs.writeFileSync(`${p}.tmp`, JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(`${p}.tmp`, p);
  }

  read(id: string): SessionMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirOf(id), 'meta.json'), 'utf8')) as SessionMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private mustRead(id: string): SessionMeta {
    const meta = this.read(id);
    if (!meta) throw new Error(`no session ${id}`);
    return meta;
  }

  list(): SessionMeta[] {
    const out: SessionMeta[] = [];
    for (const name of fs.readdirSync(sessionsDir(this.dataRoot))) {
      const meta = this.read(name);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  beginTurn(id: string, input: { runId: string; userText: string }): SessionMeta {
    const meta = this.mustRead(id);
    const n = meta.turns.length + 1;
    meta.turns.push({ n, runId: input.runId, userText: input.userText, startedAt: new Date().toISOString(), endedAt: null, costUsd: 0, tokens: 0, permissionDenials: 0 });
    meta.status = 'running';
    meta.error = null;
    fs.mkdirSync(path.join(this.dirOf(id), 'turns', String(n)), { recursive: true });
    this.write(meta);
    return meta;
  }

  endTurn(id: string, n: number, result: { costUsd: number; tokens: number; permissionDenials: number; status: Extract<SessionStatus, 'awaiting_user' | 'done' | 'error' | 'cancelled'>; error?: string; reason?: string }): SessionMeta {
    const meta = this.mustRead(id);
    const turn = meta.turns.find((t) => t.n === n);
    if (!turn) throw new Error(`no turn ${n} in session ${id}`);
    turn.endedAt = new Date().toISOString();
    turn.costUsd = result.costUsd;
    turn.tokens = result.tokens;
    turn.permissionDenials = result.permissionDenials;
    meta.totals = { costUsd: round(meta.totals.costUsd + result.costUsd), tokens: meta.totals.tokens + result.tokens };
    meta.status = result.status;
    meta.error = result.error ?? null;
    meta.lastReason = result.reason ?? null;
    this.write(meta);
    return meta;
  }

  /** Removes the session directory (sessions are kept until the user deletes them). */
  delete(id: string): boolean {
    const dir = this.dirOf(id);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  setStatus(id: string, status: SessionStatus, error?: string): SessionMeta {
    const meta = this.mustRead(id);
    meta.status = status;
    if (error !== undefined) meta.error = error;
    this.write(meta);
    return meta;
  }

  addFilesChanged(id: string, paths: string[]): SessionMeta {
    const meta = this.mustRead(id);
    for (const p of paths) if (!meta.filesChanged.includes(p)) meta.filesChanged.push(p);
    this.write(meta);
    return meta;
  }

  /** Appends one normalized event; the returned seq is the SSE event id. */
  appendEvent(id: string, event: SessionEvent): number {
    const file = path.join(this.dirOf(id), 'events.ndjson');
    const seq = this.lastSeq(file) + 1;
    fs.appendFileSync(file, JSON.stringify({ seq, ts: new Date().toISOString(), event } satisfies StoredEvent) + '\n');
    return seq;
  }

  readEvents(id: string, afterSeq = 0): StoredEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dirOf(id), 'events.ndjson'), 'utf8');
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as StoredEvent;
        if (ev.seq > afterSeq) out.push(ev);
      } catch {
        /* torn tail line */
      }
    }
    return out;
  }

  private lastSeq(file: string): number {
    try {
      const text = fs.readFileSync(file, 'utf8').trimEnd();
      const last = text.slice(text.lastIndexOf('\n') + 1);
      return last ? (JSON.parse(last) as StoredEvent).seq : 0;
    } catch {
      return 0;
    }
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
