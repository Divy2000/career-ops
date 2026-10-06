// A policy-changes.tsv or company-alerts.tsv line the core parser rejects: the Sponsorship page says which line, and
// the policy changes tab shows that reason alone, not an empty table under it (SW2-server-01 review).
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

const OVERVIEW = {
  digest: { kind: 'missing' },
  policyChanges: [],
  policyChangesError: 'policy-changes.tsv line 4: detected_date must be a real YYYY-MM-DD date, got "Oct 5"',
  alerts: { latest: [], history: [{ date: '2026-10-05', company: 'Acme Robotics', slug: 'acme-robotics', status: 'pause', headline: 'Acme pauses H-1B', url: 'https://news.example/acme' }] },
  alertsError: 'company-alerts.tsv line 4: status must be one of paused/stopped/restricted/resumed/expanded, got "pause"',
  officialFeed: [],
  companies: [],
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

describe('Sponsorship page, a file the parser rejects', () => {
  it('the policy changes tab shows the reason and no empty table under it', async () => {
    await mount('changes');
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the policy changes error');
    expect(alert.textContent).toContain('policy-changes.tsv line 4: detected_date must be a real YYYY-MM-DD date');
    expect(host.querySelector('table')).toBeNull();
  });

  it('the company alerts tab shows the reason above the raw rows, which are still listed', async () => {
    await mount('alerts');
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the alerts error');
    expect(alert.textContent).toContain('company-alerts.tsv line 4: status must be one of');
    expect(host.querySelector('table')?.textContent).toContain('Acme pauses H-1B');
  });
});
