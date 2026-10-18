// Tracker preview: "Open posting" and the o key open a row's posting. A saved-JD reference (local:jds/<file>) opens
// through /api/files/serve, as Application > Open posting does, not as a raw local: link (R19-feat-c-L1-02). A URL
// postingHref refuses (javascript:, data:) gives neither a link nor a blank tab from the o key (R35-web1-FC-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackerPage, type TrackerSearch } from '@web/features/tracker/TrackerPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let opened: unknown[][];

const row = (url: string) => ({ num: 1, date: '2026-09-20', company: 'Acme', role: 'Engineer', score: 4, scoreRaw: '4.0/5', status: 'Applied', pdf: false, pdfRaw: '-', report: null, reportLabel: null, notes: '', location: null, url, posted: null, lastContact: null, summary: null, reportState: 'none' });

async function select(url: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'ok', path: 'data/applications.md', rows: [row(url)], etag: 'e' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const rootRoute = createRootRoute();
  const tracker = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tracker',
    component: TrackerPage,
    validateSearch: (): TrackerSearch => ({ tab: 'all', q: '', sort: 'num', dir: 'desc', view: 'flat' }),
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([tracker]), history: createMemoryHistory({ initialEntries: ['/tracker'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
  const tr = await until(() => [...host.querySelectorAll('tr')].find((r) => r.textContent?.includes('Acme')), 'the Acme row');
  await act(async () => tr.click());
  await until(() => host.textContent?.includes('Open report'), 'the preview');
}

async function render(url: string) {
  await select(url);
  return await until(() => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Open posting'), 'the Open posting link');
}

const pressO = async () => {
  const table = host.querySelector<HTMLElement>('.table-wrap')!;
  await act(async () => void table.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true })));
};

beforeEach(() => {
  opened = [];
  vi.stubGlobal('open', (...args: unknown[]) => void opened.push(args));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('tracker preview Open posting', () => {
  it('opens a saved-JD reference through the file server, from the link and the o key', async () => {
    const link = await render('local:jds/acme-eng.md');
    const served = `/api/files/serve?path=${encodeURIComponent('jds/acme-eng.md')}`;
    expect(link.getAttribute('href')).toBe(served);
    await pressO();
    expect(opened).toEqual([[served, '_blank', 'noopener']]);
  });

  it('opens a posting URL as it is', async () => {
    const link = await render('https://jobs.example.com/acme/1');
    expect(link.getAttribute('href')).toBe('https://jobs.example.com/acme/1');
    await pressO();
    expect(opened).toEqual([['https://jobs.example.com/acme/1', '_blank', 'noopener']]);
  });

  for (const url of ['javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>']) {
    it(`given the posting reference ${url}, then there is no Open posting link and the o key opens nothing`, async () => {
      await select(url);
      expect([...host.querySelectorAll('a')].some((a) => a.textContent?.trim() === 'Open posting')).toBe(false);
      await pressO();
      expect(opened).toEqual([]);
    });
  }
});
