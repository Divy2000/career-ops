// Profile & CV > AI flows and Exports: a session started there is paid and may wait for a reply. Leaving the page and
// coming back must show it again instead of empty launchers (the same loss as SW7-web-b-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; onSessionId?: (id: string) => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
}));

let host: HTMLElement;
let root: Root | null;

async function openPage() {
  const { ProfilePage } = await import('@web/features/profile/ProfilePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const profile = createRoute({ getParentRoute: () => rootRoute, path: '/profile', component: ProfilePage });
  const router = createRouter({ routeTree: rootRoute.addChildren([profile]), history: createMemoryHistory({ initialEntries: ['/profile'] }) });
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
  await until(() => openPrompt('AI flows'), 'the AI flows launcher');
}

const card = (heading: string) => [...host.querySelectorAll('.card')].find((c) => c.querySelector('h2')?.textContent === heading)!;
const openPrompt = (heading: string) => card(heading) && [...card(heading).querySelectorAll('button')].find((b) => b.textContent === 'Open prompt');
const lastPanel = (mode: string) => panels.filter((p) => p.mode === mode).pop();

beforeEach(() => {
  panels = [];
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

describe('Profile & CV launchers keep their sessions', () => {
  it('leaving the page and coming back re-attaches an AI flow and an export, each in its own launcher', async () => {
    await openPage();
    await act(async () => openPrompt('AI flows')!.click());
    await act(async () => lastPanel('interview')!.onSessionId!('interview-1'));
    await act(async () => openPrompt('Exports')!.click());
    await act(async () => lastPanel('text')!.onSessionId!('export-1'));
    await act(async () => root!.unmount());
    root = null;
    panels = [];
    await openPage();
    await until(() => lastPanel('interview') && lastPanel('text'), 'the re-attached panels');
    expect(lastPanel('interview')).toMatchObject({ sessionId: 'interview-1' });
    expect(lastPanel('text')).toMatchObject({ sessionId: 'export-1' });
  });
});
