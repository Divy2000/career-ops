import { useEffect, useReducer } from 'react';
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

/** Replays stored events, then follows the live SSE stream for one session. */
export function useSessionStream(id: string | null): { transcript: Transcript; meta: SessionMeta | null } {
  const [state, dispatch] = useReducer(streamReducer, { id: null, transcript: EMPTY_TRANSCRIPT, meta: null });
  const qc = useQueryClient();
  useEffect(() => {
    if (!id) return;
    let closed = false;
    const es = new EventSource(`/api/sessions/${id}/events`);
    const loadMeta = () => void apiGet<{ meta: SessionMeta }>(`/api/sessions/${id}`).then((r) => !closed && dispatch({ type: 'meta', id, meta: r.meta }));
    const onEvent = (raw: Event) => {
      // The EventSource "error" event (connection drop) shares a name with our error event and carries no data.
      if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') return;
      const stored = JSON.parse(raw.data) as StoredEvent;
      dispatch({ type: 'event', id, event: stored.event });
      if (stored.event.type === 'status' && isTerminal(stored.event.status)) {
        loadMeta();
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    };
    for (const type of EVENT_TYPES) es.addEventListener(type, onEvent);
    es.onerror = () => undefined;
    loadMeta();
    return () => {
      closed = true;
      es.close();
    };
  }, [id, qc]);
  return state.id === id ? { transcript: state.transcript, meta: state.meta } : { transcript: EMPTY_TRANSCRIPT, meta: null };
}

export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => apiGet<SessionMeta[]>('/api/sessions'), refetchInterval: 5000 });
export const useEngine = () => useQuery({ queryKey: ['sessions', 'engine'], queryFn: () => apiGet<{ playwrightAvailable: boolean; modes: string[] }>('/api/sessions/engine'), staleTime: 60_000 });

export type Target = SessionMeta['target'];

export function startSession(input: { mode: string; target?: Target; prompt: string; model?: string | null; blacklistAllowed?: boolean }): Promise<SessionMeta> {
  return apiSend<SessionMeta>('POST', '/api/sessions', { target: { type: 'none', value: null }, ...input });
}
export function sendTurn(id: string, prompt: string, blacklistAllowed?: boolean): Promise<SessionMeta> {
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/turns`, { prompt, ...(blacklistAllowed ? { blacklistAllowed } : {}) });
}
export function forkSession(id: string, prompt: string): Promise<SessionMeta> {
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/fork`, { prompt });
}
export function cancelSession(id: string): Promise<SessionMeta> {
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/cancel`);
}
export function fanOut(mode: string, urls: string[]): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
  return apiSend('POST', '/api/sessions/fanout', { mode, urls });
}
