import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Server domains map to the query keys that go stale when they change. */
export const DOMAIN_KEYS: Record<string, string[][]> = {
  tracker: [['tracker'], ['insights'], ['followups']],
  reports: [['tracker'], ['insights']],
  // The Insights scripts read cv.md, profile.yml, portals.yml, scan-history.tsv, pipeline.md and follow-ups.md.
  pipeline: [['pipeline'], ['insights']],
  shortlist: [['shortlist']],
  // An application's detail carries its company sponsorship file and alert.
  immigration: [['immigration'], ['sponsorship'], ['tracker', 'row']],
  // interview-prep/story-bank.md is also a Profile user file.
  interviews: [['tracker', 'interviews'], ['insights'], ['config', 'user-file']],
  documents: [['tracker', 'documents'], ['apply', 'documents']],
  followups: [['followups'], ['tracker'], ['insights']],
  config: [['config'], ['system'], ['insights']],
  runs: [['runs']],
  sessions: [['sessions']],
};

/** Backoff before opening a stream the browser closed for good (exported so tests can shorten it). */
export const APP_STREAM_RETRY = { baseMs: 1000, maxMs: 30_000 };

type Listener = (ev: MessageEvent) => void;
interface SharedStream {
  es: EventSource;
  listeners: Map<string, Set<Listener>>;
  opens: Set<(reconnect: boolean) => void>;
  opened: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  failures: number;
}
let shared: SharedStream | null = null;

/**
 * Opens `s`'s EventSource and routes its frames to `s`'s subscribers. The browser retries a dropped connection by itself,
 * but an answer that is not a 200 event stream (the supervisor's 503 down page, or its 502, while the server child is
 * down after a crash) closes the source for good: a new one is opened after a backoff, and since `opened` stays true
 * its open reports a reconnect, so every live query refetches and each session panel reloads its stored events.
 */
function connect(s: SharedStream): void {
  const es = new EventSource('/api/events');
  s.es = es;
  es.addEventListener('open', () => {
    // An open after a refused connection is a reconnect even when no earlier one opened: what changed meanwhile sent no event.
    const reconnect = s.opened || s.failures > 0;
    s.failures = 0;
    s.opened = true;
    for (const fn of [...s.opens]) fn(reconnect);
  });
  es.addEventListener('error', () => {
    if (es.readyState !== EventSource.CLOSED || s.es !== es || shared !== s || s.retry) return;
    es.close();
    const delay = Math.min(APP_STREAM_RETRY.baseMs * 2 ** s.failures, APP_STREAM_RETRY.maxMs);
    s.failures += 1;
    s.retry = setTimeout(() => {
      s.retry = null;
      if (shared === s) connect(s);
    }, delay);
  });
  for (const type of s.listeners.keys()) dispatch(s, es, type);
}

function dispatch(s: SharedStream, es: EventSource, type: string): void {
  es.addEventListener(type, (ev) => {
    for (const l of [...(s.listeners.get(type) ?? [])]) l(ev as MessageEvent);
  });
}

/**
 * The page's one connection to /api/events, shared by everything that follows server events (live invalidation and
 * every session panel): HTTP/1.1 allows 6 connections per host, and a stream per session used them up. It opens with
 * the first subscriber and closes with the last.
 */
function stream(): SharedStream {
  if (shared) return shared;
  const s = { listeners: new Map(), opens: new Set(), opened: false, retry: null, failures: 0 } as unknown as SharedStream;
  shared = s;
  connect(s);
  return s;
}

function release(s: SharedStream): void {
  if (shared !== s || s.opens.size > 0 || [...s.listeners.values()].some((l) => l.size > 0)) return;
  if (s.retry) clearTimeout(s.retry);
  s.retry = null;
  s.es.close();
  shared = null;
}

/** Calls `fn` for every `type` frame on the app event stream; returns the unsubscribe. */
export function subscribeAppEvents(type: string, fn: Listener): () => void {
  const s = stream();
  let set = s.listeners.get(type);
  if (!set) {
    set = new Set<Listener>();
    s.listeners.set(type, set);
    dispatch(s, s.es, type);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    release(s);
  };
}

/** Calls `fn` each time the app event stream opens; `reconnect` is false the first time. Returns the unsubscribe. */
export function onAppStreamOpen(fn: (reconnect: boolean) => void): () => void {
  const s = stream();
  s.opens.add(fn);
  return () => {
    s.opens.delete(fn);
    release(s);
  };
}

export function useLiveInvalidation(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const offs = [
      subscribeAppEvents('data.changed', (ev) => {
        try {
          const { domain } = JSON.parse(ev.data) as { domain: string };
          for (const key of DOMAIN_KEYS[domain] ?? []) void qc.invalidateQueries({ queryKey: key });
        } catch {
          /* a malformed frame invalidates nothing */
        }
      }),
      // A job log's status is decided when it is read (a run killed before its done line turns interrupted), so every
      // reader refetches too: the job logs under ['immigration', 'logs'] and the Today chip's overview under ['immigration'].
      subscribeAppEvents('daily.status', () => {
        void qc.invalidateQueries({ queryKey: ['system', 'daily'] });
        void qc.invalidateQueries({ queryKey: ['immigration'] });
      }),
      subscribeAppEvents('run.status', () => void qc.invalidateQueries({ queryKey: ['runs'] })),
      // The bus keeps no replay and a restarted server's watcher ignores what changed before it started, so whatever
      // changed while the stream was down sent no event: a reconnect refetches everything instead.
      onAppStreamOpen((reconnect) => {
        if (reconnect) void qc.invalidateQueries();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [qc]);
}
