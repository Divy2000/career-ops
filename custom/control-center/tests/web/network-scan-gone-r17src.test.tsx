// Discover > Network scan re-attaches the last run this tab started. A run the server no longer has (its stream
// answers 404, so the browser closes it for good) is let go instead of showing "scanning" forever (R16-feata-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  readyState = 0;
  private listeners = new Map<string, Array<(ev: Event) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** What the browser does when the stream's response is not a 200 event stream: closed, no reconnect. */
  fail() {
    this.readyState = 2;
    for (const fn of this.listeners.get('error') ?? []) fn(new Event('error'));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const STALE = 'stale-run-1';
let host: HTMLElement;
let root: Root;
let runStatus: number;

beforeEach(async () => {
  FakeEventSource.all = [];
  sessionStorage.clear();
  sessionStorage.setItem('cc.discover.networkScan', STALE);
  runStatus = 404;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === `/api/runs/${STALE}`) {
        const body = runStatus === 404 ? { error: 'no such run' } : runStatus === 200 ? { id: STALE, status: 'done' } : { error: 'bad gateway' };
        return new Response(JSON.stringify(body), { status: runStatus, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(url === '/api/actions' ? [] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  const { NetworkScan } = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(NetworkScan))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const streams = () => FakeEventSource.all.filter((s) => s.url === `/api/runs/${STALE}/events`);

describe('Network scan: a re-attached run the server no longer has', () => {
  it('is let go: no "scanning" results card, and it is not re-attached next time', async () => {
    const stream = await until(() => streams()[0], 'the run stream');
    expect(host.textContent).toContain('scanning');
    await act(async () => stream.fail());
    await until(() => !host.textContent?.includes('scanning'), 'the stale run let go');
    expect(host.textContent).not.toContain('Results');
    expect(sessionStorage.getItem('cc.discover.networkScan')).toBeNull();
  });

  it('a stream closed for another reason (the run still exists) is opened again', async () => {
    runStatus = 200;
    const first = await until(() => streams()[0], 'the run stream');
    await act(async () => first.fail());
    await until(() => streams().length > 1, 'the stream opened again', 400);
    expect(sessionStorage.getItem('cc.discover.networkScan')).toBe(STALE);
    expect(host.textContent).toContain('Results');
  });
});
