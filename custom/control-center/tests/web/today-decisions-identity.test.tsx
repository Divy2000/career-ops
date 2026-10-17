// Today's Decisions act on the row the user saw: a delete elsewhere reindexes the tracker, so the number the page loaded
// can name another application by the time Applied or Skip is clicked (R30-feat-c-L2-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRead, TrackerRow } from '@shared/api';
import { TodayPage } from '@web/features/today/TodayPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const row = (num: number, company: string, report: number | null): TrackerRow => ({
  num,
  date: '2026-10-01',
  company,
  role: `${company} Engineer`,
  score: 4.2,
  scoreRaw: '4.2/5',
  status: 'Evaluated',
  pdf: false,
  pdfRaw: '❌',
  report,
  reportLabel: report === null ? null : String(report),
  notes: '',
  location: null,
  url: null,
  posted: null,
  lastContact: null,
  summary: null,
  reportState: report === null ? 'none' : 'ok',
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const unavailable = () => new Response('unavailable', { status: 502, headers: { 'content-type': 'text/plain' } });

async function today(rows: () => TrackerRow[]) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/tracker') return json({ kind: 'ok', path: 'data/applications.md', rows: rows(), etag: 't' } satisfies TrackerRead);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ result: {} });
      }
      return unavailable();
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });
  const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([index, tracker]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));
  return { posts, qc };
}
const decision = (company: string) => [...host.querySelectorAll('[aria-label="Decisions"] li')].find((li) => li.querySelector('a')?.textContent === company) as HTMLElement | undefined;
const button = (li: HTMLElement, text: string) => [...li.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

describe('Today Decisions after the tracker is reindexed', () => {
  it('names the row it saw when setting its status, so the server can refuse a different row under that number', async () => {
    const { posts } = await today(() => [row(5, 'Acme', 7), row(6, 'Hooli', null)]);
    await until(() => decision('Acme') !== undefined, 'the Acme decision');
    await act(async () => button(decision('Acme')!, 'Applied').click());
    await until(() => posts.length === 1, 'the setStatus request');
    expect(posts[0]).toEqual({ url: '/api/actions/tracker.setStatus', body: { params: { row: 5, state: 'Applied', expectCompany: 'Acme', expectRole: 'Acme Engineer', expectReport: 7 } } });
    await act(async () => button(decision('Hooli')!, 'Applied').click());
    await until(() => posts.length === 2, 'the second setStatus request');
    expect(posts[1]!.body).toEqual({ params: { row: 6, state: 'Applied', expectCompany: 'Hooli', expectRole: 'Hooli Engineer', expectReport: null } });
  });

  it('does not move an open Skip reason picker to the company that now holds that number', async () => {
    let rows = [row(4, 'Bar', 4), row(5, 'Acme', 5)];
    const { qc } = await today(() => rows);
    await until(() => decision('Acme') !== undefined, 'the Acme decision');
    await act(async () => button(decision('Acme')!, 'Skip').click());
    expect(decision('Acme')!.querySelector('[aria-label="Discard reason picker"]')).not.toBeNull();
    // Bar (#4) was deleted elsewhere: Acme is now #4 and Initech took #5.
    rows = [row(4, 'Acme', 5), row(5, 'Initech', 9)];
    await act(async () => qc.invalidateQueries({ queryKey: ['tracker'] }));
    await until(() => decision('Initech') !== undefined, 'the refetched decisions');
    expect(decision('Initech')!.querySelector('[aria-label="Discard reason picker"]')).toBeNull();
    expect(decision('Acme')!.querySelector('[aria-label="Discard reason picker"]')).not.toBeNull();
  });
});
