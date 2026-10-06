// A new user with an empty tracker gets one onboarding card on Today: "Find your first matches" once cv.md holds a CV,
// "Start with your CV" otherwise, including when cv.md cannot be read (the supervisor's 502 while the server restarts).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRead } from '@shared/api';
import type { UserFile } from '@web/lib/queries';
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

const EMPTY_TRACKER: TrackerRead = { kind: 'ok', path: 'data/applications.md', rows: [], etag: 't1' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// What the supervisor answers while the server child restarts: plain text, not JSON.
const restarting = () => new Response('server child unavailable: connect ECONNREFUSED 127.0.0.1:4318', { status: 502, headers: { 'content-type': 'text/plain' } });

async function today(cv: () => Response) {
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/tracker' ? json(EMPTY_TRACKER) : url === '/api/files/user/cv' ? cv() : restarting())));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([index]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));
}
const heroes = () => [...host.querySelectorAll('.hero h2')].map((h) => h.textContent);

describe('the Today onboarding card for an empty tracker', () => {
  it('points at Discover when cv.md holds a CV', async () => {
    const cv: UserFile = { key: 'cv', path: 'cv.md', kind: 'ok', text: '# Jane Smith\n', etag: 'c1' };
    await today(() => json(cv));
    await until(() => heroes().length > 0, 'an onboarding card');
    expect(heroes()).toEqual(['Find your first matches']);
  });

  it('asks for a CV when cv.md is missing', async () => {
    const cv: UserFile = { key: 'cv', path: 'cv.md', kind: 'missing', text: '', etag: null };
    await today(() => json(cv));
    await until(() => heroes().length > 0, 'an onboarding card');
    expect(heroes()).toEqual(['Start with your CV']);
  });

  it('asks for a CV when cv.md cannot be read, instead of showing no card', async () => {
    await today(restarting);
    await until(() => heroes().length > 0, 'an onboarding card');
    expect(heroes()).toEqual(['Start with your CV']);
  });
});
