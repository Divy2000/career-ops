// Discover > Network scan follows its run's event stream once: the results table and the scan log read the same
// stream, since every open stream holds one of the browser's 6 connections to the app (SW3-web-a-01).
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
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/actions/scan.network' ? { runId: 'r1' } : url === '/api/actions' ? [] : {};
      return new Response(JSON.stringify(body), { status: url === '/api/actions/scan.network' ? 202 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { NetworkScan } = await import('@web/features/discover/DiscoverPage');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(NetworkScan))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Network scan run stream', () => {
  it('opens one stream for the run, and its lines reach both the log and the results', async () => {
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
    await until(() => FakeEventSource.all.length > 0, 'the run stream');
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    const streams = FakeEventSource.all.filter((s) => s.url === '/api/runs/r1/events');
    expect(streams).toHaveLength(1);
    const postings = [{ url: 'https://boards.example.com/one/1', company: 'One Co', title: 'Platform Engineer', location: 'Remote', postedAt: null, source: 'greenhouse' }];
    await act(async () => streams[0]!.emit('line', { line: 'scanning greenhouse', stream: 'stderr', seq: 1, ts: 't' }));
    await act(async () => streams[0]!.emit('line', { line: JSON.stringify({ postings }), stream: 'stdout', seq: 2, ts: 't' }));
    expect(host.querySelector('[aria-label="Scan log"]')!.textContent).toContain('scanning greenhouse');
    expect(host.textContent).toContain('One Co');
  });
});
