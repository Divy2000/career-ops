// Discover > Network scan: while the remembered run is still running, Run network scan (the button and Enter in a
// filter field) must not start a second sweep that replaces the first run on the page (R19-feat-a-L1-01).
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
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

const meta = { id: 'scan.network', label: 'Network scan', cost: 'network', confirm: null, resources: [], claude: false, sync: false, params: { type: 'object', properties: {} } };

let host: HTMLElement;
let root: Root;
let n = 0;
/** While set, POST /api/actions/scan.network waits for it, so a test can leave the tab while the start is in flight. */
let startGate: Promise<void> | null = null;

async function mount() {
  const { NetworkScan } = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(NetworkScan))));
}

beforeEach(async () => {
  FakeEventSource.all = [];
  sessionStorage.clear();
  n = 0;
  startGate = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions/scan.network' && init?.method === 'POST') {
        n += 1;
        if (startGate) await startGate;
        return new Response(JSON.stringify({ runId: `r${n}` }), { status: 202, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(url === '/api/actions' ? [meta] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
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

const runButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Run network scan'));
const posts = () => (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([u, i]) => u === '/api/actions/scan.network' && i?.method === 'POST').length;
const submitForm = () => act(async () => host.querySelector('form[aria-label="Network scan filters"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

async function startScan() {
  const b = await until(() => { const found = runButton(); return found && !found.disabled ? found : undefined; }, 'Run network scan to be ready');
  await act(async () => b.click());
  return await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream');
}

describe('Network scan: a running scan blocks a second one', () => {
  it('Run network scan is disabled while the started run is running', async () => {
    await startScan();
    expect(runButton()!.disabled).toBe(true);
    await act(async () => runButton()!.click());
    expect(posts()).toBe(1);
  });

  it('Enter in a filter field (form submit) does not start a second sweep while the run is running', async () => {
    await startScan();
    await submitForm();
    expect(posts()).toBe(1);
    expect(sessionStorage.getItem('cc.discover.networkScan')).toBe('r1');
  });

  it('the re-attached running run disables Run network scan after coming back', async () => {
    await startScan();
    await act(async () => root.unmount());
    await mount();
    const again = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream after coming back');
    // The actions list loaded again, so nothing but the running run keeps the button disabled.
    await until(() => ((fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.filter(([u]) => u === '/api/actions').length >= 2 ? true : undefined), 'the actions list after coming back');
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    await submitForm();
    expect(runButton()!.disabled).toBe(true);
    expect(posts()).toBe(1);
    await act(async () => again.emit('run.done', { status: 'done' }));
    await until(() => (runButton()!.disabled ? undefined : true), 'Run network scan to be enabled once the re-attached run ended');
  });

  it('a finished run re-enables Run network scan', async () => {
    const stream = await startScan();
    await act(async () => stream.emit('run.done', { status: 'done' }));
    await until(() => (runButton()!.disabled ? undefined : true), 'Run network scan to be enabled after run.done');
  });

  it('Given a sweep still starting, When the tab is left and comes back, Then Run network scan stays off and the results follow the run once it starts (R30-feat-a-L1-01)', async () => {
    let release!: () => void;
    startGate = new Promise((r) => (release = r));
    const b = await until(() => { const found = runButton(); return found && !found.disabled ? found : undefined; }, 'Run network scan to be ready');
    const roles = host.querySelector<HTMLInputElement>('[aria-label="Roles (comma separated)"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(roles, 'Robotics engineer');
      roles.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => b.click());
    await act(async () => root.unmount());
    await mount();
    await until(() => ((fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.filter(([u]) => u === '/api/actions').length >= 2 ? true : undefined), 'the actions list after coming back');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(runButton()!.disabled).toBe(true);
    await submitForm();
    expect(posts()).toBe(1);
    await act(async () => release());
    await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events' && !s.closed), 'the run stream of the start that answered');
    expect(runButton()!.disabled).toBe(true);
    expect(posts()).toBe(1);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Roles (comma separated)"]')!.value).toBe('Robotics engineer');
  });
});
