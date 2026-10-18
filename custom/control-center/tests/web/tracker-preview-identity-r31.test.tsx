// The preview's open Discard picker belongs to the row it was opened on: a delete elsewhere reindexes the tracker, and
// Confirm must not discard the row that inherits the number (R31-feat-c-X-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { TrackerPage, type TrackerSearch } from '@web/features/tracker/TrackerPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let rows: TrackerRow[];

const row = (num: number, company: string, report: number | null): TrackerRow => ({
  num, date: '2026-10-01', company, role: 'Engineer', score: 4, scoreRaw: '4.0/5', status: 'Evaluated', pdf: false, pdfRaw: '-', report, reportLabel: report === null ? null : String(report),
  notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: report === null ? 'none' : 'ok',
});

function makeRouter() {
  const rootRoute = createRootRoute();
  const tracker = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tracker',
    component: TrackerPage,
    validateSearch: (): TrackerSearch => ({ tab: 'all', q: '', sort: 'num', dir: 'asc', view: 'flat' }),
  });
  return createRouter({ routeTree: rootRoute.addChildren([tracker]), history: createMemoryHistory({ initialEntries: ['/tracker'] }) });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'ok', path: 'data/applications.md', rows, etag: 'e' }), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const box = (company: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Select ${company}"]`);
const preview = () => host.querySelector('[aria-label="Preview"]')!;
const picker = () => preview().querySelector('[aria-label="Discard reason picker"]');

describe('tracker preview after a reindex', () => {
  it('does not move an open Discard picker to the row that inherits the selected number', async () => {
    rows = [row(3, 'Foo', 3), row(5, 'Acme', 5), row(6, 'Beta', 6)];
    const qc = new QueryClient();
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: makeRouter() }))));
    await until(() => box('Acme'), 'the tracker rows');
    await act(async () => box('Acme')!.closest('tr')!.querySelector<HTMLElement>('td:nth-child(2)')!.click());
    expect(preview().querySelector('h2')?.textContent).toBe('Acme');
    const select = preview().querySelector<HTMLSelectElement>('select[aria-label="Change status"]')!;
    await act(async () => {
      select.value = 'Discarded';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(picker()).not.toBeNull();

    // Foo (#3) was deleted in another tab: Acme is now #4 and Beta #5.
    rows = [row(4, 'Acme', 5), row(5, 'Beta', 6)];
    await act(async () => qc.invalidateQueries({ queryKey: ['tracker'] }));
    await until(() => box('Foo') === null, 'the refetched tracker');
    expect(preview().querySelector('h2')?.textContent).toBe('Acme');
    expect(picker()).toBeNull();
  });
});
