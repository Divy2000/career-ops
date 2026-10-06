// Insights > AI analyses: an analysis session is paid and may wait for a reply. Switching tabs, or leaving the page and
// coming back, must show the same session again instead of an empty launcher (SW7-web-b-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void };
let panels: PanelProps[];
let mounts: number;
vi.mock('@web/components/SessionPanel', async () => {
  const { useEffect } = await import('react');
  return {
    SessionPanel: (props: PanelProps) => {
      panels.push(props);
      useEffect(() => void mounts++, []);
      return null;
    },
  };
});

let host: HTMLElement;
let root: Root | null;

async function openPage(tab = 'ai') {
  const { InsightsPage } = await import('@web/features/insights/InsightsPage');
  const rootRoute = createRootRoute({ component: () => createElement(Outlet) });
  const insights = createRoute({ getParentRoute: () => rootRoute, path: '/insights', component: InsightsPage, validateSearch: (s: Record<string, unknown>) => ({ tab: (typeof s.tab === 'string' ? s.tab : 'overview') as 'overview' }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([insights]), history: createMemoryHistory({ initialEntries: [`/insights?tab=${tab}`] }) });
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  await until(() => host.querySelector('[role="tablist"]'), 'the Insights tabs');
}
async function leavePage() {
  await act(async () => root!.unmount());
  root = null;
}

const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const openPrompt = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open prompt')!;
const lastPanel = (mode: string) => panels.filter((p) => p.mode === mode).pop();

async function startCalibrate() {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="AI analyses mode"]')!;
  await act(async () => {
    select.value = 'calibrate';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => openPrompt().click());
  await act(async () => lastPanel('calibrate')!.onSessionId!('cal-1'));
  await act(async () => lastPanel('calibrate')!.onStatus!('awaiting_user', 'question'));
}

beforeEach(() => {
  panels = [];
  mounts = 0;
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Insights AI analyses keep their session', () => {
  it('switching to another tab and back shows the same session, still mounted', async () => {
    await openPage();
    await startCalibrate();
    const mounted = mounts;
    await act(async () => tab('Overview').click());
    await act(async () => tab('AI analyses').click());
    expect(mounts).toBe(mounted);
    expect(lastPanel('calibrate')).toMatchObject({ sessionId: 'cal-1' });
  });

  it('leaving the page and coming back re-attaches the session', async () => {
    await openPage();
    await startCalibrate();
    await leavePage();
    panels = [];
    await openPage();
    await until(() => lastPanel('calibrate'), 'the re-attached calibrate panel');
    expect(lastPanel('calibrate')).toMatchObject({ sessionId: 'cal-1' });
  });

  it('a session deleted on the Sessions page is let go instead of re-attached', async () => {
    await openPage();
    await startCalibrate();
    await act(async () => lastPanel('calibrate')!.onStatus!('gone', null));
    await leavePage();
    panels = [];
    await openPage();
    expect(lastPanel('calibrate')).toBeUndefined();
  });
});
