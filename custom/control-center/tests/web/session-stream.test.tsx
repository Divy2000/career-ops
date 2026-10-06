// A session's event stream holds one of the browser's 6 HTTP/1.1 connections to the app. Streams of finished sessions
// (every ModeLauncher panel, the hidden Ask drawer) used to stay open, so a handful of them froze every fetch in every
// tab. A stream now closes once its turn is over and reopens when a new turn starts (SW3-web-a-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTurn, useSessionStream, type Transcript } from '@web/lib/sessions';
import { useLiveInvalidation } from '@web/lib/sse';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    if (this.closed) return;
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}

type Stored = { seq: number; ts: string; event: Record<string, unknown> & { type: string } };
const ev = (seq: number, event: Stored['event']): Stored => ({ seq, ts: '2026-10-05T12:00:00.000Z', event });
const TURN_1: Stored[] = [ev(1, { type: 'status', status: 'running', turn: 1 }), ev(2, { type: 'text.done', text: 'first answer' }), ev(3, { type: 'status', status: 'done', turn: 1 })];
const TURN_2: Stored[] = [ev(4, { type: 'status', status: 'running', turn: 2 }), ev(5, { type: 'text.done', text: 'second answer' }), ev(6, { type: 'status', status: 'done', turn: 2 })];

let host: HTMLElement;
let root: Root;
let stored: Stored[];
let status: string;
let latest: Transcript;
let holdMeta: boolean;
let heldMeta: Array<() => void>;

function Probe() {
  useLiveInvalidation();
  latest = useSessionStream('s1').transcript;
  return null;
}

const streams = () => FakeEventSource.all.filter((s) => s.url === '/api/sessions/s1/events');
const live = () => streams().filter((s) => !s.closed);
const bus = () => FakeEventSource.all.find((s) => s.url === '/api/events')!;
async function replay(s: FakeEventSource, events: Stored[]) {
  for (const e of events) await act(async () => s.emit(e.event.type, e));
}

beforeEach(async () => {
  FakeEventSource.all = [];
  stored = [...TURN_1];
  status = 'done';
  holdMeta = false;
  heldMeta = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/sessions/s1' ? { meta: { id: 's1', status, turns: [] }, events: stored } : { id: 's1' };
      const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url !== '/api/sessions/s1' || !holdMeta) return response;
      // A held meta GET answers with the state as it was when it was asked, whenever the test lets it.
      return new Promise<Response>((resolve) => heldMeta.push(() => resolve(response)));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Probe))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('session event stream', () => {
  it('closes once the session is over, so a finished session holds no connection', async () => {
    await replay(streams()[0]!, TURN_1);
    await until(() => live().length === 0, 'the finished stream to close');
    expect(latest.status).toBe('done');
    expect(latest.turns.map((t) => t.text)).toEqual(['first answer']);
  });

  it('stays open while a turn is still running', async () => {
    status = 'running';
    stored = [TURN_1[0]!];
    await replay(streams()[0]!, [TURN_1[0]!]);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(live()).toHaveLength(1);
  });

  it('a history with several turns is read to its end before the stream closes', async () => {
    stored = [...TURN_1, ...TURN_2];
    await replay(streams()[0]!, [...TURN_1, ...TURN_2]);
    await until(() => live().length === 0, 'the finished stream to close');
    expect(latest.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
  });

  it('sending a turn reopens the stream, and the replayed history is not applied twice', async () => {
    await replay(streams()[0]!, TURN_1);
    await until(() => live().length === 0, 'the finished stream to close');
    // As the server does: the turn is running (and has its first event) once the POST is answered.
    status = 'running';
    stored = [...TURN_1, TURN_2[0]!];
    await act(async () => void (await sendTurn('s1', 'and then?')));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(live()).toHaveLength(1);
    status = 'done';
    stored = [...TURN_1, ...TURN_2];
    await replay(live()[0]!, [...TURN_1, ...TURN_2]);
    await until(() => live().length === 0, 'the second turn to end the stream');
    expect(latest.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
  });

  it('a turn started elsewhere (another tab, the Apply fill) reopens it through the live event bus', async () => {
    await replay(streams()[0]!, TURN_1);
    await until(() => live().length === 0, 'the finished stream to close');
    status = 'running';
    stored = [...TURN_1, TURN_2[0]!];
    await act(async () => bus().emit('session.status', { sessionId: 's1', status: 'running', mode: 'advisor', turn: 2 }));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(live()).toHaveLength(1);
    await act(async () => bus().emit('session.status', { sessionId: 'other', status: 'running', mode: 'advisor', turn: 1 }));
    expect(live()).toHaveLength(1);
  });

  it('a meta answer asked for before the next turn started does not close that turn\'s stream (SW3-web-a-01 review)', async () => {
    holdMeta = true;
    await replay(streams()[0]!, TURN_1);
    // The terminal status asked for the meta, which is still in flight (done, events up to seq 3) when the next turn starts.
    expect(heldMeta.length).toBeGreaterThan(0);
    await act(async () => void (await sendTurn('s1', 'and then?')));
    await replay(streams()[0]!, [TURN_2[0]!]);
    for (const answer of heldMeta.splice(0)) await act(async () => answer());
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(live()).toHaveLength(1);
    holdMeta = false;
    stored = [...TURN_1, ...TURN_2];
    await replay(live()[0]!, TURN_2.slice(1));
    await until(() => live().length === 0, 'the second turn to end the stream');
    expect(latest.turns.map((t) => t.text)).toEqual(['first answer', 'second answer']);
  });
});

