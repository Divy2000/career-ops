// Discover > Network scan and Fresh render posting URLs from scan output and scan history. Only a real http(s)
// posting URL becomes a link: a `javascript:` URL as an anchor's href runs script when clicked (R23-feat-a-X-01).
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

const UNSAFE = 'javascript:alert(document.domain)';
let host: HTMLElement;
let root: Root;
let added: Array<{ offers: Array<{ url: string }> }>;

beforeEach(() => {
  FakeEventSource.all = [];
  sessionStorage.clear();
  added = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline/add') {
        const body = JSON.parse(String(init?.body)) as { offers: Array<{ url: string }> };
        added.push(body);
        // Like the route: one URL that is not an http(s) posting URL fails the whole body.
        const bad = body.offers.some((o) => !/^https?:/.test(o.url));
        return new Response(JSON.stringify(bad ? { error: 'invalid body' } : { added: body.offers.length, skipped: 0 }), { status: bad ? 400 : 200, headers: { 'content-type': 'application/json' } });
      }
      const body =
        url === '/api/actions/scan.network'
          ? { runId: 'r1' }
          : url === '/api/actions'
            ? []
            : url.startsWith('/api/whats-new')
              ? { offers: [
                  { url: UNSAFE, company: 'Evil Co', title: 'Click me', firstSeen: '2026-10-10' },
                  { url: 'https://jobs.example.com/ok', company: 'Good Co', title: 'SRE', firstSeen: '2026-10-10' },
                ] }
              : {};
      return new Response(JSON.stringify(body), { status: url === '/api/actions/scan.network' ? 202 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(name: 'NetworkScan' | 'Fresh') {
  const mod = await import('@web/features/discover/DiscoverPage');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(mod[name]))));
}
const row = (text: string) => [...host.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(text))!;

describe('Discover: posting links from external sources', () => {
  it('Network scan shows a non-http(s) posting URL as plain text, and keeps a real one a link', async () => {
    await render('NetworkScan');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
    const stream = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events'), 'the run stream');
    const offers = [
      { company: 'Evil Co', title: 'Click me', url: UNSAFE, source: 'greenhouse' },
      { company: 'Good Co', title: 'SRE', url: 'https://jobs.example.com/ok', source: 'lever' },
    ];
    await act(async () => stream.emit('line', { line: JSON.stringify({ companiesScanned: 2, offers }), stream: 'stdout', seq: 1, ts: 't' }));
    await until(() => host.textContent?.includes('Evil Co'), 'the results');
    expect(row('Evil Co').textContent).toContain('Click me');
    expect(row('Evil Co').querySelector('a')).toBeNull();
    expect(row('Good Co').querySelector('a')?.getAttribute('href')).toBe('https://jobs.example.com/ok');
  });

  it('Fresh shows a non-http(s) posting URL as plain text, and keeps a real one a link', async () => {
    await render('Fresh');
    await until(() => host.textContent?.includes('Evil Co'), 'the fresh matches');
    expect(row('Evil Co').textContent).toContain('Click me');
    expect(row('Evil Co').querySelector('a')).toBeNull();
    expect(row('Good Co').querySelector('a')?.getAttribute('href')).toBe('https://jobs.example.com/ok');
  });

  it('Network scan Add all leaves out a non-http(s) posting URL, so the route does not refuse the real ones with it', async () => {
    await render('NetworkScan');
    await act(async () => host.querySelector<HTMLFormElement>('form[aria-label="Network scan filters"]')!.requestSubmit());
    const stream = await until(() => FakeEventSource.all.find((s) => s.url === '/api/runs/r1/events'), 'the run stream');
    const offers = [
      { company: 'Evil Co', title: 'Click me', url: UNSAFE, source: 'greenhouse' },
      { company: 'Good Co', title: 'SRE', url: 'https://jobs.example.com/ok', source: 'lever' },
    ];
    await act(async () => stream.emit('line', { line: JSON.stringify({ companiesScanned: 2, offers }), stream: 'stdout', seq: 1, ts: 't' }));
    await until(() => host.textContent?.includes('Evil Co'), 'the results');
    expect(row('Evil Co').textContent).toContain('not a posting URL');
    expect(row('Evil Co').querySelector('button')).toBeNull();
    const addAll = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Add all'))!;
    expect(addAll.textContent).toContain('(1)');
    await act(async () => addAll.click());
    await until(() => added.length === 1 && (host.textContent?.includes('Added') ?? false), 'the add result');
    expect(added[0]!.offers.map((o) => o.url)).toEqual(['https://jobs.example.com/ok']);
  });
});
