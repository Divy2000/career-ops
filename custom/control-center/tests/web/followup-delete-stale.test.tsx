// Follow-ups > Cadence: a delete refused as stale (the row's num now belongs to another follow-up) says so in words and
// reloads the list, so the user sees the current rows instead of the bare code (R23-srv-dom-a-L1-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowupCadence } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/ModeLauncher', () => ({ ModeLauncher: () => null }));

const CADENCE: FollowupCadence = {
  metadata: { analysisDate: '2026-10-10', totalTracked: 1, actionable: 1, overdue: 1, urgent: 0, cold: 0, waiting: 0, retired: 0 },
  entries: [
    {
      num: 12, company: 'Acme Robotics', role: 'Backend Engineer', status: 'applied', score: '4.3/5', appliedDate: '2026-09-01', daysSinceApplication: 30,
      daysSinceLastFollowup: 20, followupCount: 1, urgency: 'overdue', nextFollowupDate: '2026-10-01', daysUntilNext: -9, nextOverride: null, contacts: [],
      followups: [{ num: 7, appNum: 12, date: '2026-09-20', company: 'Acme Robotics', role: 'Backend Engineer', channel: 'Email', contact: '', notes: '' }],
    },
  ],
};

let host: HTMLElement;
let root: Root;
let cadenceLoads = 0;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  cadenceLoads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/followups/log' && init?.method === 'DELETE') return Promise.resolve(json(409, { error: 'stale' }));
      if (url === '/api/followups') {
        cadenceLoads += 1;
        return Promise.resolve(json(200, CADENCE));
      }
      return Promise.resolve(json(200, []));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const { CadenceTab } = await import('@web/features/followups/FollowupsPage');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/', component: CadenceTab });
  const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, tracker]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Cadence: deleting a follow-up that changed since the page loaded', () => {
  it('explains the refusal and reloads the cadence', async () => {
    const show = await until(() => host.querySelector<HTMLButtonElement>('button[aria-label="Show history for Acme Robotics"]') ?? undefined, 'the history toggle');
    await act(async () => show.click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Delete follow-up 7"]')!.click());
    const confirmButton = await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Delete'), 'the confirm dialog');
    const loadsBefore = cadenceLoads;
    await act(async () => confirmButton.click());
    const status = await until(() => [...host.querySelectorAll('[role="status"]')].find((s) => s.textContent?.includes('Could not delete')), 'the status line');
    expect(status.textContent).toBe('Could not delete: follow-up #7 changed since this page loaded, so nothing was deleted. The list is reloaded.');
    await until(() => (cadenceLoads > loadsBefore ? true : undefined), 'a cadence reload');
  });
});
