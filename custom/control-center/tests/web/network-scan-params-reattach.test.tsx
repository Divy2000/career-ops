// Discover > Network scan re-attaches the last run this tab started. The form must then show the filters that run
// used, so the results card's "No postings matched these filters" and its depth hint describe what is on screen
// (R23-feat-a-L3-01).
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
let sent: Array<Record<string, unknown>>;

beforeEach(async () => {
  FakeEventSource.all = [];
  sessionStorage.clear();
  sent = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions/scan.network') sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const field = <T extends HTMLInputElement | HTMLSelectElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
const checkbox = (name: string) => [...host.querySelectorAll<HTMLLabelElement>('fieldset label')].find((l) => l.textContent?.trim() === name)!.querySelector('input')!;
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('Network scan: coming back to a remembered run', () => {
  it('the form shows the filters that run used, not the defaults', async () => {
    await act(async () => {
      setValue(field('Roles (comma separated)'), 'staff data engineer');
      setValue(field('Exclude keywords'), 'contract');
      setValue(field('Allowed locations'), 'Berlin');
      setValue(field('Posted window'), '30');
      setValue(field('Scan depth'), '500');
    });
    await act(async () => checkbox('lever').click());
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
    const first = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events'), 'the run stream');
    expect(sent[0]!.params).toMatchObject({ roles: ['staff data engineer'], exclude: ['contract'], locationAllow: ['Berlin'], sinceDays: 30, ats: ['greenhouse'], limit: 500 });
    await act(async () => first.emit('line', { line: JSON.stringify({ companiesAvailable: 5, companiesScanned: 5, offers: [] }), stream: 'stdout', seq: 1, ts: 't' }));
    await act(async () => first.emit('run.done', { status: 'done' }));
    await until(() => host.textContent?.includes('No postings matched these filters.'), 'the empty result');

    await act(async () => root.unmount());
    await mount();
    await until(() => FakeEventSource.all.some((s) => s.url === '/api/runs/r1/events' && s !== first), 'the run re-attached');
    expect(field<HTMLInputElement>('Roles (comma separated)').value).toBe('staff data engineer');
    expect(field<HTMLInputElement>('Exclude keywords').value).toBe('contract');
    expect(field<HTMLInputElement>('Allowed locations').value).toBe('Berlin');
    expect(field<HTMLSelectElement>('Posted window').value).toBe('30');
    expect(field<HTMLSelectElement>('Scan depth').value).toBe('500');
    expect(checkbox('greenhouse').checked).toBe(true);
    expect(checkbox('lever').checked).toBe(false);
  });

  it('with no remembered run the form starts on the defaults', async () => {
    expect(field<HTMLInputElement>('Roles (comma separated)').value).toBe('backend, platform');
    expect(field<HTMLSelectElement>('Scan depth').value).toBe('100');
  });

  it('remembered filters that are malformed fall back to the defaults', async () => {
    await act(async () => root.unmount());
    sessionStorage.setItem('cc.discover.networkScan', 'r1');
    sessionStorage.setItem('cc.discover.networkScan.params', JSON.stringify({ roles: 7, sinceDays: 99, limit: 'x', ats: ['nope'] }));
    await mount();
    expect(field<HTMLInputElement>('Roles (comma separated)').value).toBe('backend, platform');
    expect(field<HTMLSelectElement>('Posted window').value).toBe('7');
    expect(field<HTMLSelectElement>('Scan depth').value).toBe('100');
    expect(checkbox('greenhouse').checked).toBe(true);
    expect(checkbox('lever').checked).toBe(true);
  });

  it('remembered sources with a repeat fall back to the defaults, so a rerun does not sweep one source twice', async () => {
    await act(async () => root.unmount());
    sessionStorage.setItem('cc.discover.networkScan', 'r1');
    sessionStorage.setItem('cc.discover.networkScan.params', JSON.stringify({ roles: 'sre', ats: ['greenhouse', 'greenhouse'] }));
    await mount();
    expect(field<HTMLInputElement>('Roles (comma separated)').value).toBe('sre');
    expect(checkbox('greenhouse').checked).toBe(true);
    expect(checkbox('lever').checked).toBe(true);
  });
});
