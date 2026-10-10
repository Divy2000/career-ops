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
  sessionStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url === '/api/actions/scan.network' ? { runId: 'r1' } : url === '/api/actions' ? [] : {};
      return new Response(JSON.stringify(body), { status: url === '/api/actions/scan.network' ? 202 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  await mount();
});
async function mount() {
  const { NetworkScan } = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(NetworkScan))));
}
async function runScan() {
  await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
  return await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream');
}
const summaryLine = (summary: unknown) => ({ line: JSON.stringify(summary), stream: 'stdout', seq: 2, ts: 't' });
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Network scan run stream', () => {
  it('opens one stream for the run, and its lines reach both the log and the results', async () => {
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
    const stream = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events'), 'the run stream');
    // The summary scan-ats-full.mjs --json prints: its offers, the cap and the outage flags (not a `postings` list).
    const offers = [{ company: 'One Co', title: 'Platform Engineer', url: 'https://boards.example.com/one/1', location: 'Remote', postedAt: null, dateStatus: 'unknown', blacklisted: false, note: null, source: 'greenhouse' }];
    await act(async () => stream.emit('line', { line: 'scanning greenhouse', stream: 'stderr', seq: 1, ts: 't' }));
    await act(async () => stream.emit('line', { line: JSON.stringify({ companiesScanned: 1, capHit: false, stoppedByOutage: false, offers }), stream: 'stdout', seq: 2, ts: 't' }));
    await until(() => host.textContent?.includes('One Co'), 'the results');
    expect(host.querySelector('[aria-label="Scan log"]')!.textContent).toContain('scanning greenhouse');
    // Counted once the results and the log have both mounted: either one opening its own stream shows here.
    expect(FakeEventSource.all.filter((s) => s.url === '/api/runs/r1/events')).toHaveLength(1);
  });

  it('a scan whose company lists could not be loaded says so instead of "No postings matched" (R13-feat-a-L3-02)', async () => {
    const stream = await runScan();
    await act(async () => stream.emit('line', summaryLine({ companiesAvailable: 0, companiesScanned: 0, capHit: false, stoppedByOutage: false, datasetStatus: { greenhouse: 'empty', lever: 'empty' }, unreachableBoards: 0, offers: [] })));
    await act(async () => stream.emit('run.done', { status: 'done' }));
    await until(() => host.textContent?.includes('scan done'), 'the end of the scan');
    expect(host.textContent).toContain('could not load the company list for greenhouse, lever');
    expect(host.textContent).not.toContain('No postings matched these filters.');
  });

  it('a scan on an expired cached list or with unreachable boards says it is degraded (R13-feat-a-L3-02)', async () => {
    const stream = await runScan();
    await act(async () => stream.emit('line', summaryLine({ companiesAvailable: 900, companiesScanned: 100, capHit: false, stoppedByOutage: false, datasetStatus: { greenhouse: 'stale', lever: 'ok' }, unreachableBoards: 7, offers: [] })));
    await act(async () => stream.emit('run.done', { status: 'done' }));
    await until(() => host.textContent?.includes('scan done'), 'the end of the scan');
    expect(host.textContent).toContain('an expired cached company list for greenhouse');
    expect(host.textContent).toContain('7 boards could not be reached');
    expect(host.textContent).toContain('No postings matched these filters.');
  });

  it('leaving the tab while a scan runs and coming back follows the same run again (R13-feat-a-L1-06)', async () => {
    const first = await runScan();
    await act(async () => root.unmount());
    expect(first.closed).toBe(true);
    await mount();
    const again = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && s !== first), 'the run stream after coming back');
    await act(async () => again.emit('line', summaryLine({ companiesAvailable: 1, companiesScanned: 1, capHit: false, stoppedByOutage: false, datasetStatus: { greenhouse: 'ok' }, offers: [{ company: 'Back Co', title: 'SRE', url: 'https://boards.example.com/back/1', source: 'greenhouse' }] })));
    await until(() => host.textContent?.includes('Back Co'), 'the results');
  });
});
