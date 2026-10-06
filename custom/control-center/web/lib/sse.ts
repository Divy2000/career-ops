import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** Server domains map to the query keys that go stale when they change. */
export const DOMAIN_KEYS: Record<string, string[][]> = {
  tracker: [['tracker'], ['insights'], ['followups']],
  reports: [['tracker'], ['insights']],
  pipeline: [['pipeline']],
  shortlist: [['shortlist']],
  // An application's detail carries its company sponsorship file and alert.
  immigration: [['immigration'], ['sponsorship'], ['tracker', 'row']],
  interviews: [['tracker', 'interviews'], ['insights']],
  documents: [['tracker', 'documents'], ['apply', 'documents']],
  followups: [['followups'], ['tracker']],
  config: [['config'], ['system']],
  runs: [['runs']],
  sessions: [['sessions']],
};

type Listener = (ev: MessageEvent) => void;
interface SharedStream {
  es: EventSource;
  listeners: Map<string, Set<Listener>>;
  opens: Set<(reconnect: boolean) => void>;
  opened: boolean;
}
let shared: SharedStream | null = null;

/**
 * The page's one connection to /api/events, shared by everything that follows server events (live invalidation and
 * every session panel): HTTP/1.1 allows 6 connections per host, and a stream per session used them up. It opens with
 * the first subscriber and closes with the last.
 */
function stream(): SharedStream {
  if (shared) return shared;
  const es = new EventSource('/api/events');
  const s: SharedStream = { es, listeners: new Map(), opens: new Set(), opened: false };
  es.addEventListener('open', () => {
    const reconnect = s.opened;
    s.opened = true;
    for (const fn of [...s.opens]) fn(reconnect);
  });
  shared = s;
  return s;
}

function release(s: SharedStream): void {
  if (shared !== s || s.opens.size > 0 || [...s.listeners.values()].some((l) => l.size > 0)) return;
  s.es.close();
  shared = null;
}

/** Calls `fn` for every `type` frame on the app event stream; returns the unsubscribe. */
export function subscribeAppEvents(type: string, fn: Listener): () => void {
  const s = stream();
  let set = s.listeners.get(type);
  if (!set) {
    const listeners = new Set<Listener>();
    set = listeners;
    s.listeners.set(type, listeners);
    s.es.addEventListener(type, (ev) => {
      for (const l of [...listeners]) l(ev as MessageEvent);
    });
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
