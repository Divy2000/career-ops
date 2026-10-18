// Today > Fresh matches links each offer through postingHref (R35-web1-FC-03). The offers come from scan history,
// which other writers fill, so a javascript: or data: URL there renders as text instead of a link that would run in
// the Control Center's origin when clicked.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FreshOffer, TrackerRead, WhatsNewResponse } from '@shared/api';
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

const TRACKER: TrackerRead = { kind: 'ok', path: 'data/applications.md', rows: [], etag: 't1' };
const offer = (url: string, title: string): FreshOffer => ({ url, title, company: 'Acme', location: 'Remote', postedAt: '2026-10-15', firstSeen: '2026-10-15', ats: 'greenhouse' });
const FRESH: WhatsNewResponse = { offers: [offer('https://jobs.example.com/1', 'Good Role'), offer('javascript:alert(document.domain)', 'Evil Role'), offer('data:text/html,<script>alert(1)</script>', 'Data Role')], count: 3 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function today() {
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/tracker' ? json(TRACKER) : url.startsWith('/api/whats-new') ? json(FRESH) : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([index]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));
}
const linkTo = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === text);

describe('Today > Fresh matches this week', () => {
  it('given offers with javascript: and data: URLs, then their titles are text while an http(s) offer stays a link', async () => {
    await today();
    await until(() => linkTo('Good Role'), 'the Good Role link');
    expect(linkTo('Good Role')!.getAttribute('href')).toBe('https://jobs.example.com/1');
    expect(host.textContent).toContain('Evil Role');
    expect(host.textContent).toContain('Data Role');
    expect(linkTo('Evil Role')).toBeUndefined();
    expect(linkTo('Data Role')).toBeUndefined();
  });
});
