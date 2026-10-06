// Tracker search lives in the URL. Typing into it must replace the history entry, not push one per keystroke, so Back
// leaves the search as it does on the Pipeline inbox filter (SW3-web-a-06).
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

const ROW = { num: 1, date: '2026-09-20', company: 'Stripe', role: 'Engineer', score: 4, scoreRaw: '4.0/5', status: 'Applied', pdf: false, pdfRaw: '-', report: null, reportLabel: null, notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'none' };

function makeRouter() {
  const rootRoute = createRootRoute();
  const home = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null });
  const tracker = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tracker',
    component: TrackerPage,
    validateSearch: (s: Record<string, unknown>): TrackerSearch => ({ tab: 'all', q: typeof s.q === 'string' ? s.q : '', sort: 'num', dir: 'desc', view: 'flat' }),
  });
  return createRouter({ routeTree: rootRoute.addChildren([home, tracker]), history: createMemoryHistory({ initialEntries: ['/', '/tracker'] }) });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'ok', path: 'data/applications.md', rows: [ROW], etag: 'e' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('tracker search history', () => {
  it('typing a search adds no history entries, so Back leaves the tracker search at once', async () => {
    const router = makeRouter();
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router }))));
    const input = await until(() => host.querySelector<HTMLInputElement>('#tracker-search'), 'the search box');
    const entries = router.history.length;
    for (const q of ['s', 'st', 'str', 'stri', 'strip', 'stripe']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await until(() => router.state.location.search.q === 'stripe', 'the search in the URL');
    expect(router.history.length).toBe(entries);
    await act(async () => router.history.back());
    await until(() => router.state.location.pathname === '/', 'Back to leave the tracker');
  });
});
