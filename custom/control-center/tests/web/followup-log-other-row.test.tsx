// Follow-ups > Cadence: a Log save in flight on one row must not be unmounted by opening Log on another row, which hid
// that save's error and let its success close the other row's form with its draft (R19-feat-a-L1-02).
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
let answer: (r: Response) => void;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/followups/log') return new Promise<Response>((resolve) => (answer = resolve));
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

const logButton = (company: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Log follow-up for ${company}"]`);
const form = (company: string) => host.querySelector<HTMLElement>(`[role="dialog"][aria-label="Log follow-up for ${company}"]`);
const saveIn = (f: HTMLElement) => [...f.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save follow-up')!;

async function startSaveOnAcme() {
  const log = await until(() => logButton('Acme Robotics') ?? undefined, 'the Acme Log button');
  await act(async () => log.click());
  await act(async () => saveIn(form('Acme Robotics')!).click());
}

describe('Cadence: Log on another row while a save is in flight', () => {
  it('the failed save on the first row is still shown', async () => {
    await startSaveOnAcme();
    await act(async () => logButton('Globex')!.click());
    await act(async () => answer(json(409, { error: 'follow-ups are busy' })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('follow-ups are busy');
  });

  it('a form opened on another row is not closed by the first row finishing its save', async () => {
    await startSaveOnAcme();
    const locked = logButton('Globex')!.disabled;
    await act(async () => logButton('Globex')!.click());
    // Either Log stays shut on the other row while the save is in flight, or the form it opened survives the save.
    if (!locked) expect(form('Globex')).not.toBeNull();
    else expect(form('Globex')).toBeNull();
    const opened = form('Globex') !== null;
    await act(async () => answer(json(200, { num: 3 })));
    await until(() => (host.textContent?.includes('Logged follow-up #3 for Acme Robotics') ? true : undefined), 'the logged message');
    expect(form('Globex') !== null).toBe(opened);
  });

  it('once the save answered, Log opens on the other row', async () => {
    await startSaveOnAcme();
    await act(async () => answer(json(200, { num: 3 })));
    await until(() => (form('Acme Robotics') ? undefined : true), 'the Acme form to close');
    await act(async () => logButton('Globex')!.click());
    expect(form('Globex')).not.toBeNull();
  });
});
