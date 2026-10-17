// Compare runs a paid session on the ticked rows. A delete elsewhere reindexes the tracker, so a ticked number can come
// to name a row the user never picked: the selection belongs to the rows that were ticked (R30-feat-c-L1-02).
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
const selectionBar = () => host.querySelector('[aria-label="Selected rows"]');

describe('tracker selection after a reindex', () => {
  it('does not carry a ticked number over to the rows that now hold it', async () => {
    rows = [row(3, 'Foo', 3), row(4, 'Bar', 4), row(5, 'Acme', 5), row(6, 'Initech', null)];
    const qc = new QueryClient();
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router: makeRouter() }))));
    await until(() => box('Acme'), 'the tracker rows');
    await act(async () => box('Bar')!.click());
    await act(async () => box('Acme')!.click());
    expect(selectionBar()?.textContent).toContain('2 selected');

    // Foo (#3) was deleted in another tab: Bar is now #3, Acme #4 and Initech #5.
    rows = [row(3, 'Bar', 4), row(4, 'Acme', 5), row(5, 'Initech', null)];
    await act(async () => qc.invalidateQueries({ queryKey: ['tracker'] }));
    await until(() => box('Foo') === null, 'the refetched tracker');
    expect(box('Acme')!.checked).toBe(false);
    expect(box('Initech')!.checked).toBe(false);
    expect(selectionBar()).toBeNull();

    // Ticking a row again selects that row.
    await act(async () => box('Initech')!.click());
    expect(box('Initech')!.checked).toBe(true);
    expect(selectionBar()?.textContent).toContain('1 selected');
  });
});
