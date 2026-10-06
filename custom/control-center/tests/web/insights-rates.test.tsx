// Insights > Progress on a new search: a rate with no denominator yet reads "n/a", not "n/a%" (SW6-web-b-05).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InsightsPage } from '@web/features/insights/InsightsPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DASHBOARD = {
  totals: { applications: 2, scored: 2, averageScore: 4, byStatus: { Evaluated: 1, Applied: 1 } },
  funnel: [{ stage: 'Evaluated', count: 2 }, { stage: 'Applied', count: 1 }],
  rates: { evaluatedToApplied: 50, appliedToInterview: 0, interviewToOffer: null },
  scoreBuckets: [], weeklyActivity: [], topCompanies: [], archetypes: [], workMode: { remote: 0, hybrid: 0, onsite: 0, unknown: 2 }, stageTransitions: [],
};

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/insights/dashboard' ? { kind: 'ok', dashboard: DASHBOARD } : []), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const insights = createRoute({ getParentRoute: () => rootRoute, path: '/insights', component: InsightsPage, validateSearch: () => ({ tab: 'progress' as const }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([insights]), history: createMemoryHistory({ initialEntries: ['/insights'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Insights > Progress rates', () => {
  it('shows a number as a percentage and a missing rate as n/a', async () => {
    const rates = await until(() => [...host.querySelectorAll('dt')].find((dt) => dt.textContent === 'Interview to offer')?.closest('dl'), 'the rates');
    const value = (label: string) => [...rates.querySelectorAll('dt')].find((dt) => dt.textContent === label)!.nextElementSibling!.textContent;
    expect(value('Evaluated to applied')).toBe('50%');
    expect(value('Applied to interview')).toBe('0%');
    expect(value('Interview to offer')).toBe('n/a');
  });
});
