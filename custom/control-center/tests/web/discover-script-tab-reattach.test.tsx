// Discover > Portal scan: the run id must survive leaving the tab and coming back, so the running scan's log re-attaches
// instead of showing an idle button and letting a second scan.portals be queued (R18-feat-a-L3-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  closed = false;
  readyState = 1;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  /** What the browser does: `error` after it gave up (readyState 2) on a non-stream answer, or a server event. */
  emit(type: string, data?: unknown) {
    if (type === 'error') this.readyState = 2;
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const STORE_KEY = 'cc.discover.script.scan.portals';
/** Whether the server still has run r1: GET /api/runs/r1 answers 404 once it does not. */
let runGone = false;

let host: HTMLElement;
let root: Root;

const meta = (id: string, label: string, cost: string) => ({ id, label, cost, confirm: null, resources: [], claude: cost === 'tokens', sync: false, params: { type: 'object', properties: {} } });
const ACTIONS = [meta('scan.portals', 'Scan portals', 'network')];

async function mount() {
  const { ScriptTab } = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(ScriptTab, { id: 'scan.portals', intro: 'x', params: {} }))),
    ),
  );
}

beforeEach(async () => {
  FakeEventSource.all = [];
  sessionStorage.clear();
  runGone = false;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/runs/r1' && runGone) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const body = url === '/api/actions/scan.portals' ? { runId: 'r1' } : url === '/api/actions' ? ACTIONS : {};
      return new Response(JSON.stringify(body), { status: url === '/api/actions/scan.portals' ? 202 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const scanButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Scan portals'));

async function runScan() {
  const b = await until(() => scanButton() ?? undefined, 'the Scan portals button');
  await act(async () => b!.click());
  return await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream');
}

describe('Discover > Portal scan re-attaches its run', () => {
  it('switching away and back follows the same running scan without queuing another', async () => {
    const first = await runScan();
    await act(async () => root.unmount());
    expect(first.closed).toBe(true);
    await mount();
    const again = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && s !== first && !s.closed), 'the run stream after coming back');
    expect(again).toBeDefined();
    const posts = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([u, i]) => u === '/api/actions/scan.portals' && i?.method === 'POST').length;
    expect(posts).toBe(1);
  });

  it('the reattached running scan disables Scan portals, so a click cannot queue a second scan', async () => {
    await runScan();
    await act(async () => root.unmount());
    await mount();
    await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream after coming back');
    const b = await until(() => scanButton() ?? undefined, 'the Scan portals button');
    expect(b!.disabled).toBe(true);
    await act(async () => b!.click());
    const posts = (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([u, i]) => u === '/api/actions/scan.portals' && i?.method === 'POST').length;
    expect(posts).toBe(1);
  });

  it('a run the server no longer has clears the remembered id: the log goes, Scan portals is enabled, and coming back opens no stream', async () => {
    const stream = await runScan();
    expect(sessionStorage.getItem(STORE_KEY)).toBe('r1');
    runGone = true;
    await act(async () => stream.emit('error'));
    await until(() => (sessionStorage.getItem(STORE_KEY) === null ? true : undefined), 'the remembered run id to be cleared');
    expect(host.querySelector('[aria-label="Scan log"]')).toBeNull();
    expect(scanButton()!.disabled).toBe(false);
    await act(async () => root.unmount());
    const opened = FakeEventSource.all.length;
    await mount();
    await until(() => scanButton() ?? undefined, 'the Scan portals button after coming back');
    expect(FakeEventSource.all.length).toBe(opened);
    expect(scanButton()!.disabled).toBe(false);
  });

  it('a finished run re-enables Scan portals, and does again once its stream replays run.done after coming back', async () => {
    const stream = await runScan();
    expect(scanButton()!.disabled).toBe(true);
    await act(async () => stream.emit('run.done', { status: 'done' }));
    expect(stream.closed).toBe(true);
    await until(() => (scanButton()!.disabled ? undefined : true), 'Scan portals to be enabled after run.done');
    await act(async () => root.unmount());
    await mount();
    const again = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && s !== stream && !s.closed), 'the run stream after coming back');
    await act(async () => again!.emit('run.done', { status: 'done' }));
    await until(() => (scanButton()!.disabled ? undefined : true), 'Scan portals to be enabled after the replayed run.done');
  });
});
