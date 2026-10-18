// Sponsorship > Lookup links a company alert's headline only when its URL is http(s) (R35-web1-FC-03). Alerts come
// from data/immigration files other writers fill, so a javascript: or data: URL there renders as text instead of a
// link that would run in the Control Center's origin when clicked.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupResult } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null, StatusLabel: () => null }));

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const alert = (url: string, headline: string) => ({ date: '2026-10-10', company: 'Acme', status: 'paused', headline, url });
const LOOKUP: LookupResult = {
  query: 'Acme', state: 'not_found', check: null, error: null, installCommand: null, freshness: null, companyFile: null, markdown: null,
  alerts: [alert('https://news.example.com/acme', 'Good headline'), alert('javascript:alert(document.domain)', 'Evil headline'), alert('data:text/html,<script>alert(1)</script>', 'Data headline')],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function lookup() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/sponsorship/lookup') ? json(LOOKUP) : json({ error: 'not stubbed' }, 404))));
  const { LookupTab } = await import('@web/features/sponsorship/LookupTab');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/sponsorship', component: LookupTab, validateSearch: () => ({ tab: 'lookup', q: 'Acme', mode: 'lookup' }) });
  const sessions = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, sessions]), history: createMemoryHistory({ initialEntries: ['/sponsorship'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));
}
const linkTo = (text: string) => [...host.querySelectorAll('a')].find((a) => a.textContent?.trim() === text);

describe('Sponsorship > Lookup > Company alerts', () => {
  it('given alerts with javascript: and data: URLs, then their headlines are text while an http(s) alert stays a link', async () => {
    await lookup();
    await until(() => linkTo('Good headline'), 'the Good headline link');
    expect(linkTo('Good headline')!.getAttribute('href')).toBe('https://news.example.com/acme');
    expect(host.textContent).toContain('Evil headline');
    expect(host.textContent).toContain('Data headline');
    expect(linkTo('Evil headline')).toBeUndefined();
    expect(linkTo('Data headline')).toBeUndefined();
  });
});
