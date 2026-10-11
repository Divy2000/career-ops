// Follow-ups > Cadence: a pin in flight on one row must not swallow a pin click on another row with no request and no
// message, which left the second row on its cadence date while the page only reported the first pin (R20-feat-a-L1-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowupCadence, FollowupCadenceEntry } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/ModeLauncher', () => ({ ModeLauncher: () => null }));

const entry = (over: Partial<FollowupCadenceEntry>): FollowupCadenceEntry => ({
  num: 1, company: 'Acme Robotics', role: 'Backend Engineer', status: 'applied', score: '4.3/5', appliedDate: '2026-09-01', daysSinceApplication: 30,
  daysSinceLastFollowup: 20, followupCount: 2, urgency: 'overdue', nextFollowupDate: '2026-10-01', daysUntilNext: -9, nextOverride: null, contacts: [], followups: [], ...over,
});
const CADENCE: FollowupCadence = {
  metadata: { analysisDate: '2026-10-10', totalTracked: 2, actionable: 2, overdue: 2, urgent: 0, cold: 0, waiting: 0, retired: 0 },
  entries: [entry({}), entry({ num: 7, company: 'Globex' })],
};

let host: HTMLElement;
let root: Root;
let pins: { appNum: number; answer: (r: Response) => void }[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  pins = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/followups/override') {
        const { appNum } = JSON.parse(String(init?.body)) as { appNum: number };
        return new Promise<Response>((resolve) => pins.push({ appNum, answer: resolve }));
      }
      if (url === '/api/followups') return Promise.resolve(json(200, CADENCE));
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

const plus7 = (company: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Pin next follow-up for ${company} in 7 days"]`);

describe('Cadence: +7d on another row while a pin is in flight', () => {
  it('the second row is pinned too, or its button is visibly locked', async () => {
    const acme = await until(() => plus7('Acme Robotics') ?? undefined, 'the Acme +7d button');
    await act(async () => acme.click());
    expect(pins.map((p) => p.appNum)).toEqual([1]);
    const globex = plus7('Globex')!;
    if (globex.disabled) return;
    await act(async () => globex.click());
    expect(pins.map((p) => p.appNum)).toEqual([1, 7]);
  });

  it('a double click on the same row still sends one request', async () => {
    const acme = await until(() => plus7('Acme Robotics') ?? undefined, 'the Acme +7d button');
    await act(async () => {
      acme.click();
      acme.click();
    });
    expect(pins).toHaveLength(1);
  });

  it('once the pin answered, the row can be pinned again', async () => {
    const acme = await until(() => plus7('Acme Robotics') ?? undefined, 'the Acme +7d button');
    await act(async () => acme.click());
    await act(async () => pins[0]!.answer(json(200, { ok: true })));
    await until(() => (host.textContent?.includes('Next follow-up pinned to') ? true : undefined), 'the pinned message');
    expect(plus7('Acme Robotics')!.disabled).toBe(false);
    await act(async () => plus7('Acme Robotics')!.click());
    expect(pins).toHaveLength(2);
  });
});
