// Every session a page follows rides the app's one event stream: no EventSource per session, so five running
// sessions plus the app stream no longer reach the browser's 6-per-host limit and stall every request (seed from
// SW3-web-a-01). A panel replays the stored events, then applies session.event frames by seq, once each.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { SESSION_LOAD_RETRY, sendTurn, useSessionStream, type Transcript } from '@web/lib/sessions';
import type { SessionMeta } from '@shared/api';
import { useLiveInvalidation } from '@web/lib/sse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Set<(ev: MessageEvent | Event) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent | Event) => void) {
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), fn]));
  }
  removeEventListener(type: string, fn: (ev: MessageEvent | Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  open() {
    for (const fn of this.listeners.get('open') ?? []) fn(new Event('open'));
  }
  frame(sessionId: string, seq: number, event: Record<string, unknown>) {
    if (this.closed) return;
    const data = JSON.stringify({ sessionId, stored: { seq, ts: '2026-10-05T12:00:00.000Z', event }, ts: '2026-10-05T12:00:00.000Z' });
    for (const fn of this.listeners.get('session.event') ?? []) fn(new MessageEvent('session.event', { data }));
  }
}

const stored = (seq: number, event: Record<string, unknown>) => ({ seq, ts: '2026-10-05T12:00:00.000Z', event });
let history: Record<string, Array<ReturnType<typeof stored>>>;
let status: Record<string, string>;
let reads: string[];
let host: HTMLElement;
let root: Root;

function Panel({ id }: { id: string }) {
  const { transcript, meta } = useSessionStream(id);
  return createElement('output', { 'aria-label': id, 'data-status': meta?.status ?? '' }, transcript.turns.map((t) => t.text).join('|'));
}
function Page({ ids }: { ids: string[] }) {
  useLiveInvalidation();
  return createElement('div', null, ...ids.map((id) => createElement(Panel, { key: id, id })));
}

describe('session events over the app event stream', () => {
  beforeEach(async () => {
    FakeEventSource.all = [];
    reads = [];
    history = {};
    status = {};
    for (const n of [1, 2, 3]) {
      history[`s-${n}`] = [stored(1, { type: 'status', status: 'running', turn: 1 }), stored(2, { type: 'text.done', text: `hello ${n}` })];
      status[`s-${n}`] = 'running';
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const id = url.match(/^\/api\/sessions\/(s-\d+)$/)?.[1];
        if (!id) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        reads.push(id);
        return new Response(JSON.stringify({ meta: { id, status: status[id] }, events: history[id] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Page, { ids: ['s-1', 's-2', 's-3'] }))));
    await until(() => ['s-1', 's-2', 's-3'].every((id) => text(id).startsWith('hello')), 'the replayed transcripts');
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const text = (id: string) => host.querySelector(`output[aria-label="${id}"]`)?.textContent ?? '';
  const stream = () => FakeEventSource.all[0]!;

  it('three session panels and the live invalidation share one connection, the app stream', () => {
    expect(FakeEventSource.all.map((es) => es.url)).toEqual(['/api/events']);
  });

  it('applies a session\'s frames once each, in seq order, and ignores another session\'s', async () => {
    await act(async () => {
      stream().frame('s-1', 2, { type: 'text.done', text: 'hello 1' });
      stream().frame('s-1', 3, { type: 'text.delta', text: ' more' });
      stream().frame('s-9', 3, { type: 'text.delta', text: ' stray' });
    });
    expect(text('s-1')).toBe('hello 1 more');
    expect(text('s-2')).toBe('hello 2');
  });

  it('after the stream reconnects, catches up from the stored events instead of losing what was sent while it was down', async () => {
    await act(async () => stream().open());
    history['s-2'] = [...history['s-2']!, stored(3, { type: 'text.delta', text: ' while down' })];
    await act(async () => stream().open());
    await until(() => text('s-2') === 'hello 2 while down', 'the caught-up transcript');
    expect(text('s-1')).toBe('hello 1');
  });

  it('a terminal status frame reloads the session\'s meta', async () => {
    status['s-3'] = 'done';
    await act(async () => stream().frame('s-3', 3, { type: 'status', status: 'done' }));
    await until(() => host.querySelector('output[aria-label="s-3"]')?.getAttribute('data-status') === 'done', 'the reloaded meta');
  });

  it('closes the shared stream once nothing follows it any more', async () => {
    await act(async () => root.render(createElement('div')));
    expect(stream().closed).toBe(true);
  });
});

// One session across its turns (rewritten from SW3-web-a-01's per-session stream tests for the shared stream): no
// session ever holds a connection of its own, a stale meta never ends a later turn, and a later turn clears an error.
describe('one session across its turns', () => {
  type Stored = ReturnType<typeof stored>;
  const TURN_1: Stored[] = [stored(1, { type: 'status', status: 'running', turn: 1 }), stored(2, { type: 'text.done', text: 'first answer' }), stored(3, { type: 'status', status: 'done', turn: 1 })];
  const TURN_2: Stored[] = [stored(4, { type: 'status', status: 'running', turn: 2 }), stored(5, { type: 'text.done', text: 'second answer' }), stored(6, { type: 'status', status: 'done', turn: 2 })];
  let events: Stored[];
  let state: string;
  let latest: { transcript: Transcript; meta: SessionMeta | null };
  let holdMeta: boolean;
  let heldMeta: Array<() => void>;
  let failing: number;
  const retry = { ...SESSION_LOAD_RETRY };

  function Probe() {
    useLiveInvalidation();
    latest = useSessionStream('s1');
    return null;
  }
  const appStream = () => FakeEventSource.all.find((s) => s.url === '/api/events')!;
  const live = () => FakeEventSource.all.filter((s) => !s.closed);
  async function frames(list: Stored[], sessionId = 's1') {
    for (const e of list) await act(async () => appStream().frame(sessionId, e.seq, e.event));
  }
  async function mount() {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Probe))));
  }
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

  beforeEach(() => {
    FakeEventSource.all = [];
    events = [...TURN_1];
    state = 'done';
    holdMeta = false;
    heldMeta = [];
    failing = 0;
    // The load's retry backoff in milliseconds instead of seconds, so the outage test does not wait on real delays.
    Object.assign(SESSION_LOAD_RETRY, { baseMs: 5, maxMs: 20 });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/sessions/s1' && failing > 0) {
          failing -= 1;
          return new Response('{"error":"server restarting"}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        const body = url === '/api/sessions/s1' ? { meta: { id: 's1', status: state, turns: [] }, events } : { id: 's1' };
        const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        if (url !== '/api/sessions/s1' || !holdMeta) return response;
        // A held GET answers with the session as it was when it was asked, whenever the test lets it.
        return new Promise<Response>((resolve) => heldMeta.push(() => resolve(response)));
      }),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(SESSION_LOAD_RETRY, retry);
  });

  it('a finished session is read from its stored events and holds no connection of its own', async () => {
    await mount();
    await until(() => latest.meta?.status === 'done', 'the loaded session');
    expect(latest.transcript.status).toBe('done');
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer']);
    expect(FakeEventSource.all.map((s) => s.url)).toEqual(['/api/events']);
  });

  it('a running session keeps following its turn on the app stream', async () => {
    state = 'running';
    events = [TURN_1[0]!];
    await mount();
    await until(() => latest.meta?.status === 'running', 'the loaded session');
    await frames(TURN_1.slice(1, 2));
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer']);
    expect(latest.transcript.status).toBe('running');
    expect(live().map((s) => s.url)).toEqual(['/api/events']);
  });

  it('a history with several turns is read to its end', async () => {
    events = [...TURN_1, ...TURN_2];
    await mount();
    await until(() => latest.transcript.turns.length === 2, 'both turns');
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
    expect(latest.transcript.status).toBe('done');
  });

  it('a turn sent from this page arrives on the app stream, and events it already has are not applied twice', async () => {
    await mount();
    await until(() => latest.meta?.status === 'done', 'the loaded session');
    state = 'running';
    events = [...TURN_1, TURN_2[0]!];
    await act(async () => void (await sendTurn('s1', 'and then?')));
    state = 'done';
    events = [...TURN_1, ...TURN_2];
    // The stream may deliver an event the panel already read again (a replay after a reconnect): its seq skips it.
    await frames([TURN_1[1]!, ...TURN_2]);
    await until(() => latest.meta?.status === 'done' && latest.transcript.status === 'done', 'the second turn to end');
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
    expect(FakeEventSource.all.map((s) => s.url)).toEqual(['/api/events']);
  });

  it('a turn started elsewhere (another tab, the Apply fill) arrives too, and another session\'s frames are ignored', async () => {
    await mount();
    await until(() => latest.meta?.status === 'done', 'the loaded session');
    await frames([TURN_2[0]!]);
    await frames([stored(5, { type: 'text.done', text: 'not this session' })], 'other');
    expect(latest.transcript.status).toBe('running');
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer', '']);
  });

  it('a meta answer asked for before the next turn started does not end that turn (SW3-web-a-01 review)', async () => {
    holdMeta = true;
    events = [TURN_1[0]!, TURN_1[1]!];
    state = 'running';
    await mount();
    for (const answer of heldMeta.splice(0)) await act(async () => answer());
    await until(() => latest.meta?.status === 'running', 'the loaded session');
    // The terminal status asks for the meta, still in flight (done, events up to seq 3) when the next turn starts.
    events = [...TURN_1];
    state = 'done';
    await frames([TURN_1[2]!]);
    expect(heldMeta.length).toBeGreaterThan(0);
    await frames([TURN_2[0]!]);
    events = [...TURN_1, TURN_2[0]!];
    state = 'running';
    for (const answer of heldMeta.splice(0)) await act(async () => answer());
    await settle();
    for (const answer of heldMeta.splice(0)) await act(async () => answer());
    await until(() => latest.meta?.status === 'running', 'the meta asked again');
    expect(latest.transcript.status).toBe('running');
    holdMeta = false;
    events = [...TURN_1, ...TURN_2];
    state = 'done';
    await frames(TURN_2.slice(1));
    await until(() => latest.meta?.status === 'done' && latest.transcript.status === 'done', 'the second turn to end');
    expect(latest.transcript.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
  });

  it('events the server sent after the stored events were read, but before the app stream opened, are not lost', async () => {
    state = 'running';
    events = [TURN_1[0]!, stored(2, { type: 'text.delta', text: 'a' })];
    await mount();
    await until(() => latest.transcript.turns[0]?.text === 'a', 'the stored events');
    // The stream is still connecting: this event reaches the store but no subscriber.
    events = [...events, stored(3, { type: 'text.delta', text: 'b' })];
    await act(async () => appStream().open());
    events = [...events, stored(4, { type: 'text.delta', text: 'c' })];
    await frames([events[3]!]);
    await until(() => latest.transcript.turns[0]?.text === 'abc', 'every event, in order');
  });

  it('a frame past a gap in the seqs reads the stored events instead of applying over the gap', async () => {
    state = 'running';
    events = [TURN_1[0]!, stored(2, { type: 'text.delta', text: 'a' })];
    await mount();
    await act(async () => appStream().open());
    await until(() => latest.transcript.turns[0]?.text === 'a', 'the stored events');
    await settle();
    // Seq 3 never arrives on the stream (sent by another server process on the same data, say).
    events = [...events, stored(3, { type: 'text.delta', text: 'b' }), stored(4, { type: 'text.delta', text: 'c' })];
    await frames([events[3]!]);
    await until(() => latest.transcript.turns[0]?.text === 'abc', 'every event, in order');
  });

  it('stored events that failed to load are read again until they load, and live frames wait for them', async () => {
    state = 'running';
    events = [TURN_1[0]!, stored(2, { type: 'text.delta', text: 'a' })];
    // The first read and the one a live frame asks for both fail (the server is restarting), then it answers.
    failing = 2;
    await mount();
    await settle();
    events = [...events, stored(3, { type: 'text.delta', text: 'b' })];
    await frames([events[2]!]);
    await until(() => latest.transcript.turns[0]?.text === 'ab' && latest.meta?.status === 'running', 'the whole history');
    expect(failing).toBe(0);
  });

  it('a session that failed before its turn could start (only an error event) shows the error, and a later turn clears it (SW3-web-a-01 review 2)', async () => {
    state = 'error';
    events = [stored(1, { type: 'error', message: 'Keychain item not found' })];
    await mount();
    await until(() => latest.meta?.status === 'error', 'the loaded session');
    expect(latest.transcript.error).toBe('Keychain item not found');
    expect(live().map((s) => s.url)).toEqual(['/api/events']);
    await frames([stored(2, { type: 'status', status: 'running', turn: 2 })]);
    expect(latest.transcript.error).toBeNull();
    expect(latest.transcript.status).toBe('running');
  });

  it('a session the server marked failed after a restart, whose last event is running, is ended by its meta (SW3-web-a-01 review 2)', async () => {
    state = 'error';
    events = [TURN_1[0]!];
    await mount();
    await until(() => latest.meta?.status === 'error', 'the reconciled session');
    // The stream delivering the same running event again (a replay) changes nothing.
    await frames([TURN_1[0]!]);
    expect(latest.meta?.status).toBe('error');
    expect(live().map((s) => s.url)).toEqual(['/api/events']);
  });
});
