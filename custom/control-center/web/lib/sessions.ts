import { useEffect, useReducer } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiSend } from './api';
import { onAppStreamOpen, subscribeAppEvents } from './sse';
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
        // An earlier turn's failure is not this turn's: its alert would sit under the new answer.
        t.error = null;
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

interface StreamState {
  id: string | null;
  transcript: Transcript;
  meta: SessionMeta | null;
  gone: boolean;
}
type StreamAction = { type: 'events'; id: string; events: SessionEvent[] } | { type: 'meta'; id: string; meta: SessionMeta } | { type: 'gone'; id: string };

/** State is keyed by session id, so switching sessions resets without a setState inside the effect. */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  const base: StreamState = state.id === action.id ? state : { id: action.id, transcript: EMPTY_TRANSCRIPT, meta: null, gone: false };
  if (action.type === 'meta') return { ...base, meta: action.meta };
  if (action.type === 'gone') return { ...base, gone: true };
  return { ...base, transcript: action.events.reduce(reduceEvent, base.transcript) };
}

/** The stored events' retry backoff (doubling from baseMs, capped at maxMs); tests shorten it. */
export const SESSION_LOAD_RETRY = { baseMs: 1000, maxMs: 3000 };

/** A status that ends the turn, or an error event (a session can fail before its turn spawns: an error and no status). */
const ends = (e: StoredEvent) => (e.event.type === 'status' && isTerminal(e.event.status)) || e.event.type === 'error';

/**
 * Replays a session's stored events, then follows it on the app's one event stream (session.event frames), applying
 * each event once, in seq order. No session holds a connection of its own, so finished and running sessions alike cost
 * nothing beyond the page's one stream. Frames that arrive while the stored events load wait for them; each time the
 * stream opens, and whenever a frame skips a seq, the stored events are read again, since the stream keeps no replay of
 * what it sent while it was not attached. A read that fails is retried until it answers, and frames wait for it; a 404
 * is an answer: the session is gone and nothing more is read.
 * The meta decides how the session stands (one marked failed after a restart can end on a running event), but only a
 * meta answer that counts the last turn start the stream delivered: an older one was asked before that turn started.
 */
export function useSessionStream(id: string | null): { transcript: Transcript; meta: SessionMeta | null; gone: boolean } {
  const [state, dispatch] = useReducer(streamReducer, { id: null, transcript: EMPTY_TRANSCRIPT, meta: null, gone: false });
  const qc = useQueryClient();
  useEffect(() => {
    if (!id) return;
    let closed = false;
    let last = 0;
    let lastStart = 0;
    let loading = true;
    let pending: StoredEvent[] = [];
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const apply = (events: StoredEvent[]) => {
      // The stored events and the frames that waited for them overlap: one event per seq.
      const fresh = [...new Map(events.filter((e) => e.seq > last).map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) return false;
      last = fresh.at(-1)!.seq;
      for (const e of fresh) if (e.event.type === 'status' && e.event.status === 'running') lastStart = e.seq;
      dispatch({ type: 'events', id, events: fresh.map((e) => e.event) });
      return fresh.some(ends);
    };
    const load = (): void => {
      clearTimeout(retry);
      void apiGet<{ meta?: SessionMeta; events: StoredEvent[] }>(`/api/sessions/${id}`).then(
        (r) => {
          if (closed) return;
          failures = 0;
          if (!r.meta) {
            // Not a session at all (another route under /api/sessions/, such as engine): nothing to follow, and meta
            // stays null, so the page that names the session says why.
            closed = true;
            return;
          }
          const meta = r.meta;
          const counted = Math.max(0, ...r.events.map((e) => e.seq));
          const waiting = pending;
          pending = [];
          const ended = apply([...r.events, ...waiting]);
          if (lastStart > counted) {
            // Asked before the stream delivered later events (a next turn started): its meta is stale, ask again.
            load();
            return;
          }
          dispatch({ type: 'meta', id, meta });
          loading = false;
          if (ended && waiting.length > 0) void qc.invalidateQueries({ queryKey: ['sessions'] });
        },
        (err: unknown) => {
          if (closed) return;
          if (err instanceof ApiError && err.status === 404) {
            // The server does not have it (deleted, or a stale id): an answer, not an outage. Nothing more to follow.
            closed = true;
            dispatch({ type: 'gone', id });
            return;
          }
          // Still loading: live frames keep waiting, since applying them first would move past the history it filters.
          retry = setTimeout(load, Math.min(SESSION_LOAD_RETRY.baseMs * 2 ** failures, SESSION_LOAD_RETRY.maxMs));
          failures += 1;
        },
      );
    };
    const offEvents = subscribeAppEvents('session.event', (raw) => {
      let frame: { sessionId?: string; stored?: StoredEvent };
      try {
        frame = JSON.parse(raw.data) as typeof frame;
      } catch {
        return;
      }
      if (closed || frame.sessionId !== id || !frame.stored) return;
      if (loading) {
        pending.push(frame.stored);
        return;
      }
      if (frame.stored.seq > last + 1) {
        // An event in between never arrived (sent while the stream was not attached): the store has it.
        pending.push(frame.stored);
        loading = true;
        load();
        return;
      }
      if (apply([frame.stored])) {
        // The turn ended: the meta says how (and its totals); the Sessions list moves on.
        loading = true;
        load();
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    });
    // Every open follows a load this panel already asked for (on mount, or before a reconnect), and whatever the server
    // sent between that answer and the open reached no subscriber: read the stored events again.
    const offOpen = onAppStreamOpen(() => {
      if (closed) return;
      loading = true;
      load();
    });
    load();
    return () => {
      closed = true;
      clearTimeout(retry);
      offEvents();
      offOpen();
    };
  }, [id, qc]);
  return state.id === id ? { transcript: state.transcript, meta: state.meta, gone: state.gone } : { transcript: EMPTY_TRANSCRIPT, meta: null, gone: false };
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
  return apiSend<SessionMeta>('POST', `/api/sessions/${id}/turns`, { prompt, ...unlock.body }, unlock.headers);
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
