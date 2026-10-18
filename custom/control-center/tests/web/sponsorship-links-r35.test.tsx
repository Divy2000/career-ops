// The Sponsorship page's policy change, official feed and company alert links come from files the daily job and the
// AI policy pass fill: only an http(s) URL is a link, so a javascript: or data: URL there renders as text and cannot run
// in this origin when clicked (R35-links-FC-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { SponsorshipPage } from '@web/features/sponsorship/SponsorshipPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BAD = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', ' JavaScript:alert(1)'];
const GOOD = 'https://www.federalregister.gov/d/2026-1';
const OVERVIEW = {
  digest: { kind: 'missing' },
  policyChanges: [...BAD, GOOD].map((url, i) => ({ detected_date: '2026-10-05', announced_date: '2026-10-01', source: 'fr', url, title: `change ${i}`, impact: 'low' })),
  policyChangesError: null,
  alerts: { latest: [], history: [...BAD, GOOD].map((url, i) => ({ date: '2026-10-05', company: 'Acme', slug: 'acme', status: 'paused', headline: `alert ${i}`, url })) },
  alertsError: null,
  officialFeed: [...BAD, GOOD].map((url, i) => ({ first_seen: '2026-10-05', title: `feed ${i}`, url })),
  companies: [],
  companiesError: null,
  tiers: null,
  seen: null,
  pendingCount: null,
  pendingError: null,
  dailyLog: null,
  logDates: [],
};

let host: HTMLElement;
let root: Root;

async function mount(tab: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/api/immigration/overview') ? OVERVIEW : []), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/sponsorship', component: SponsorshipPage, validateSearch: (s: Record<string, unknown>) => ({ tab: String(s.tab ?? 'overview') }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: [`/sponsorship?tab=${tab}`] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('Sponsorship page links (R35-links-FC-01)', () => {
  for (const [tab, label] of [['changes', 'change'], ['feed', 'feed'], ['alerts', 'alert']] as const) {
    it(`the ${tab} tab links only the http(s) URL and shows the others as text`, async () => {
      await mount(tab);
      await until(() => host.querySelector('tbody tr:nth-child(4)'), `the ${tab} rows`);
      const hrefs = [...host.querySelectorAll('tbody a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual([GOOD]);
      if (tab !== 'feed') for (let i = 0; i < 3; i++) expect(host.querySelector('tbody')!.textContent).toContain(`${label} ${i}`);
    });
  }
});
