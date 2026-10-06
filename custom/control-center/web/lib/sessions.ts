import { useEffect, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from './api';
import type { SessionEvent, SessionMeta, StoredEvent } from '@shared/api';

export interface ToolView {
  id: string;
  name: string;
  summary: string;
  ok: boolean | null;
  result: string | null;
}

export interface TurnView {
  n: number;
  text: string;
  tools: ToolView[];
  stderr: string[];
}

export interface Transcript {
  status: string;
  reason: string | null;
  turns: TurnView[];
  envelopes: Array<{ kind: string; payload: unknown; turn: number }>;
  invalidEnvelopes: Array<{ kind: string; error: string }>;
  denials: Array<{ tool: string; input: unknown }>;
  files: string[];
  evaluation: Array<{ num: number; file: string; score: number | null }>;
  costUsd: number;
  tokens: number;
  model: string | null;
  error: string | null;
}

export const EMPTY_TRANSCRIPT: Transcript = { status: 'queued', reason: null, turns: [], envelopes: [], invalidEnvelopes: [], denials: [], files: [], evaluation: [], costUsd: 0, tokens: 0, model: null, error: null };

export function isTerminal(status: string): boolean {
  return status === 'done' || status === 'awaiting_user' || status === 'error' || status === 'cancelled';
}

function current(t: Transcript): TurnView {
  if (t.turns.length === 0) t.turns.push({ n: 1, text: '', tools: [], stderr: [] });
  return t.turns[t.turns.length - 1]!;
}

/** Pure reducer over normalized session events (unit-tested in the web project). */
export function reduceEvent(prev: Transcript, ev: SessionEvent): Transcript {
  const t: Transcript = { ...prev, turns: prev.turns.map((x) => ({ ...x, tools: [...x.tools], stderr: [...x.stderr] })) };
  switch (ev.type) {
    case 'status':
      if (ev.status === 'running' && ev.turn !== undefined) {
        if (!t.turns.some((x) => x.n === ev.turn)) t.turns.push({ n: ev.turn, text: '', tools: [], stderr: [] });
      }
      t.status = ev.status;
      t.reason = ev.reason ?? (ev.status === 'running' ? null : t.reason);
      return t;
    case 'session.init':
      t.model = ev.model;
      return t;
    case 'text.delta':
      current(t).text += ev.text;
      return t;
    case 'text.done':
      current(t).text = ev.text;
      return t;
    case 'tool.use':
      current(t).tools.push({ id: ev.id, name: ev.name, summary: ev.summary, ok: null, result: null });
      return t;
    case 'tool.result': {
      const tool = current(t).tools.find((x) => x.id === ev.id);
      if (tool) {
        tool.ok = ev.ok;
        tool.result = ev.summary;
      }
      return t;
    }
    case 'envelope':
      t.envelopes = [...t.envelopes, { kind: ev.kind, payload: ev.payload, turn: current(t).n }];
      return t;
    case 'envelope.invalid':
      t.invalidEnvelopes = [...t.invalidEnvelopes, { kind: ev.kind, error: ev.error }];
      return t;
    case 'permission.denied':
      t.denials = [...t.denials, { tool: ev.tool, input: ev.input }];
      return t;
    case 'files.changed':
      t.files = [...new Set([...t.files, ...ev.paths])];
      return t;
    case 'evaluation':
      t.evaluation = ev.reports;
      return t;
    case 'turn.done':
      t.costUsd = Math.round((t.costUsd + ev.costUsd) * 1e6) / 1e6;
      t.tokens += ev.tokens;
      return t;
    case 'stderr':
      current(t).stderr.push(ev.text);
      return t;
    case 'error':
      t.error = ev.message;
      t.status = 'error';
      return t;
    default:
      return t;
  }
}

export function reduceAll(events: StoredEvent[]): Transcript {
  return events.reduce((acc, e) => reduceEvent(acc, e.event), EMPTY_TRANSCRIPT);
}

const EVENT_TYPES = ['status', 'session.init', 'text.delta', 'text.done', 'tool.use', 'tool.result', 'envelope', 'envelope.invalid', 'permission.denied', 'files.changed', 'evaluation', 'turn.done', 'stderr', 'error'];

interface StreamState {
  id: string | null;
  transcript: Transcript;
  meta: SessionMeta | null;
}
type StreamAction = { type: 'event'; id: string; event: SessionEvent } | { type: 'meta'; id: string; meta: SessionMeta };

/** State is keyed by session id, so switching sessions resets without a setState inside the effect. */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  const base: StreamState = state.id === action.id ? state : { id: action.id, transcript: EMPTY_TRANSCRIPT, meta: null };
  if (action.type === 'meta') return { ...base, meta: action.meta };
  return { ...base, transcript: reduceEvent(base.transcript, action.event) };
}

// Who to tell when a session starts another turn: its stream closed when the last turn ended (SW3-web-a-01).
const turnListeners = new Map<string, Set<() => void>>();

/** A new turn of `id` is running: a closed stream for it reopens. Called by sendTurn and by the live event bus. */
export function sessionTurnStarted(id: string): void {
  for (const fn of turnListeners.get(id) ?? []) fn();
}

function onSessionTurn(id: string, fn: () => void): () => void {
  const set = turnListeners.get(id) ?? new Set();
  set.add(fn);
  turnListeners.set(id, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) turnListeners.delete(id);
  };
}

/**
 * Replays stored events, then follows the live SSE stream for one session. The stream closes once the session is over
 * and every stored event has arrived: each open stream holds one of the browser's 6 HTTP/1.1 connections to the app, so
 * finished sessions left open froze every fetch. A new turn reopens it; the replayed history is skipped by its seq.
 */
export function useSessionStream(id: string | null): { transcript: Transcript; meta: SessionMeta | null } {
  const [state, dispatch] = useReducer(streamReducer, { id: null, transcript: EMPTY_TRANSCRIPT, meta: null });
  const qc = useQueryClient();
  const [opening, setOpening] = useState(0);
  const seen = useRef<{ id: string | null; seq: number; open: boolean }>({ id: null, seq: 0, open: false });
  useEffect(() => {
    if (!id) return;
    return onSessionTurn(id, () => {
      if (!seen.current.open) setOpening((n) => n + 1);
    });
  }, [id]);
  useEffect(() => {
    if (!id) return;
    if (seen.current.id !== id) seen.current = { id, seq: 0, open: false };
    let closed = false;
    const es = new EventSource(`/api/sessions/${id}/events`);
    seen.current.open = true;
    const close = () => {
      closed = true;
      es.close();
      if (seen.current.id === id) seen.current.open = false;
    };
    const loadMeta = () =>
      void apiGet<{ meta: SessionMeta; events?: StoredEvent[] }>(`/api/sessions/${id}`).then((r) => {
        if (closed) return;
        dispatch({ type: 'meta', id, meta: r.meta });
        const last = Math.max(0, ...(r.events ?? []).map((e) => e.seq));
        if (isTerminal(r.meta.status) && seen.current.seq >= last) close();
      });
    const onEvent = (raw: Event) => {
      // The EventSource "error" event (connection drop) shares a name with our error event and carries no data.
      if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') return;
      const stored = JSON.parse(raw.data) as StoredEvent;
      if (stored.seq <= seen.current.seq) return;
      seen.current.seq = stored.seq;
      dispatch({ type: 'event', id, event: stored.event });
      if (stored.event.type === 'status' && isTerminal(stored.event.status)) {
        loadMeta();
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    };
    for (const type of EVENT_TYPES) es.addEventListener(type, onEvent);
    es.onerror = () => undefined;
    loadMeta();
    return close;
  }, [id, qc, opening]);
  return state.id === id ? { transcript: state.transcript, meta: state.meta } : { transcript: EMPTY_TRANSCRIPT, meta: null };
}

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => apiGet<SessionMeta[]>('/api/sessions'), refetchInterval: 5000 });
export const useEngine = () => useQuery({ queryKey: ['sessions', 'engine'], queryFn: () => apiGet<{ playwrightAvailable: boolean; modes: string[] }>('/api/sessions/engine'), staleTime: 60_000 });

export type Target = SessionMeta['target'];

/** The Dev Chat blacklist unlock travels with the explicit header the server requires on that very request. */
const blacklistUnlock = (allowed?: boolean): { body: { blacklistAllowed?: true }; headers: Record<string, string> } => (allowed ? { body: { blacklistAllowed: true }, headers: { 'X-CC-Explicit': 'blacklist' } } : { body: {}, headers: {} });

export function startSession(input: { mode: string; target?: Target; prompt: string; model?: string | null; blacklistAllowed?: boolean }): Promise<SessionMeta> {
  const { blacklistAllowed, ...rest } = input;
  const unlock = blacklistUnlock(blacklistAllowed);
  return apiSend<SessionMeta>('POST', '/api/sessions', { target: { type: 'none', value: null }, ...rest, ...unlock.body }, unlock.headers);
}
/** The oferta session that evaluates one posting URL (Quick evaluate, and Evaluate on a shortlist row). */
export function startEvaluateSession(url: string): Promise<SessionMeta> {
  return startSession({ mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` });
}
/** The pdf-mode session that writes the tailored CV PDF for one tracker row. */
export function startTailoredCvSession(n: string): Promise<SessionMeta> {
  return startSession({ mode: 'pdf', target: { type: 'app', value: n }, prompt: `Generate the tailored CV PDF for tracker row #${n}.` });
}
export async function sendTurn(id: string, prompt: string, blacklistAllowed?: boolean): Promise<SessionMeta> {
  const unlock = blacklistUnlock(blacklistAllowed);
  const meta = await apiSend<SessionMeta>('POST', `/api/sessions/${id}/turns`, { prompt, ...unlock.body }, unlock.headers);
  sessionTurnStarted(id);
  return meta;
}
export function forkSession(id: string, prompt: string, blacklistAllowed?: boolean): Promise<SessionMeta> {
  const unlock = blacklistUnlock(blacklistAllowed);
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/fork`, { prompt, ...unlock.body }, unlock.headers);
}
export function cancelSession(id: string): Promise<SessionMeta> {
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/cancel`);
}
export function fanOut(mode: string, urls: string[]): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
  return apiSend('POST', '/api/sessions/fanout', { mode, urls });
}
