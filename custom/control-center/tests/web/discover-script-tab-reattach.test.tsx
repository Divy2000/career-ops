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
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
}

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
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
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
});
