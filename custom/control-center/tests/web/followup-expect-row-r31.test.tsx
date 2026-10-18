// Follow-ups > Cadence: Log and Pin name the application by tracker row number, and a tracker delete reindexes the rows
// while the page is open. Each write sends the row the user picked, so the server can refuse a number that now holds
// another application, and the open Log form stays on the application it was opened for (R31-feat-a-X-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowupCadenceEntry } from '@shared/api';
import { LogForm } from '@web/features/followups/FollowupsPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/ModeLauncher', () => ({ ModeLauncher: () => null }));

const entry = (over: Partial<FollowupCadenceEntry>): FollowupCadenceEntry => ({
  num: 4, company: 'Acme Robotics', role: 'Backend Engineer', status: 'applied', score: '4.3/5', appliedDate: '2026-09-01', daysSinceApplication: 30,
  daysSinceLastFollowup: 20, followupCount: 1, urgency: 'overdue', nextFollowupDate: '2026-10-01', daysUntilNext: -9, nextOverride: '2026-10-08', contacts: [], followups: [], ...over,
});
const ACME = entry({});
// After a delete of row #3, row #4 holds the application that was #5.
const BETA = entry({ company: 'Beta Labs', role: 'Data Engineer' });

let host: HTMLElement;
let root: Root;
let sent: { url: string; method: string; body: Record<string, unknown> }[];
let reply: () => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sent = [];
  reply = () => json(200, { ok: true, num: 3 });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/followups') return Promise.resolve(json(200, { metadata: { analysisDate: '2026-10-10', totalTracked: 1, actionable: 1, overdue: 1, urgent: 0, cold: 0, waiting: 0, retired: 0 }, entries: [ACME] }));
      if (init?.method && init.method !== 'GET') {
        sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Promise.resolve(reply());
      }
      return Promise.resolve(json(200, []));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('Log follow-up after the tracker was reindexed', () => {
  it('names the application the form was opened for, even once its row number holds another', async () => {
    const done: string[] = [];
    const render = (e: FollowupCadenceEntry) => act(async () => root.render(createElement(LogForm, { entry: e, onDone: (m: string) => void done.push(m) })));
    await render(ACME);
    await render(BETA);
    await act(async () => button('Save follow-up').click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ appNum: 4, expectCompany: 'Acme Robotics', expectRole: 'Backend Engineer' });
  });

  it('shows the application it logs for in its visible text', async () => {
    await act(async () => root.render(createElement(LogForm, { entry: ACME, onDone: () => undefined })));
    expect(host.textContent).toContain('Acme Robotics');
  });

  it('a stale refusal says the row changed and nothing was logged', async () => {
    reply = () => json(409, { error: 'stale' });
    await act(async () => root.render(createElement(LogForm, { entry: ACME, onDone: () => undefined })));
    await act(async () => button('Save follow-up').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Acme Robotics.*no longer.*nothing was logged/i);
  });
});

describe('Pin after the tracker was reindexed', () => {
  const mountCadence = async () => {
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    const { CadenceTab } = await import('@web/features/followups/FollowupsPage');
    const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
    const page = createRoute({ getParentRoute: () => rootRoute, path: '/', component: CadenceTab });
    const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker/$n', component: () => null });
    const router = createRouter({ routeTree: rootRoute.addChildren([page, tracker]), history: createMemoryHistory({ initialEntries: ['/'] }) });
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  };

  it('+7d sends the row it was clicked on', async () => {
    await mountCadence();
    const plus7 = await until(() => host.querySelector<HTMLButtonElement>('button[aria-label="Pin next follow-up for Acme Robotics in 7 days"]') ?? undefined, 'the +7d button');
    await act(async () => plus7.click());
    await until(() => sent[0], 'the pin request');
    expect(sent[0]).toMatchObject({ url: '/api/followups/override', method: 'POST', body: { appNum: 4, expectCompany: 'Acme Robotics', expectRole: 'Backend Engineer' } });
  });

  it('Clear pin sends the row it was clicked on, and a stale refusal says nothing was changed', async () => {
    reply = () => json(409, { error: 'stale' });
    await mountCadence();
    const clear = await until(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear pinned date for Acme Robotics"]') ?? undefined, 'the Clear pin button');
    await act(async () => clear.click());
    const confirmButton = await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Clear pin'), 'the confirm dialog');
    await act(async () => confirmButton.click());
    await until(() => sent[0], 'the clear request');
    expect(sent[0]).toMatchObject({ url: '/api/followups/override', method: 'DELETE', body: { appNum: 4, expectCompany: 'Acme Robotics', expectRole: 'Backend Engineer' } });
    const status = await until(() => [...host.querySelectorAll('[role="status"]')].find((s) => s.textContent?.includes('Could not')), 'the status line');
    expect(status.textContent).toMatch(/Acme Robotics.*no longer.*nothing was changed/i);
  });
});
