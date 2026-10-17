// A deleted session's detail page keeps saying so when another session's turn ends: that invalidates the ['sessions']
// prefix, which also matches this page's ['sessions', id] meta query, and its 404 must not replace the deleted state
// with "Could not load." (R29-feat-c-L1-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { success: () => undefined, warning: () => undefined, error: () => undefined } }));
vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));

const meta = { id: 's-1', claudeSessionId: '', mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://jobs.example.com/1' }, model: null, status: 'done', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: null, lastReason: null };
let host: HTMLElement;
let root: Root;
let gone: boolean;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  gone = false;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE' && url === '/api/sessions/s-1') {
        gone = true;
        return json({ ok: true });
      }
      if (method === 'GET' && url === '/api/sessions/s-1') return gone ? json({ error: 'no session s-1' }, 404) : json({ meta });
      return json({ error: 'not stubbed' }, 404);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('given a deleted session, when another turn ends and invalidates the sessions queries, then the page still says Session deleted.', async () => {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const { SessionDetailPage } = await import('@web/features/sessions/SessionsPage');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: SessionDetailPage });
  const router = createRouter({ routeTree: rootRoute.addChildren([page]), history: createMemoryHistory({ initialEntries: ['/sessions/s-1'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));

  const del = await until(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Delete'), 'the Delete button');
  await act(async () => del.click());
  const confirm = await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Delete'), 'the confirm dialog');
  await act(async () => confirm.click());
  await until(() => (host.textContent?.includes('Session deleted.') ? true : undefined), 'the deleted state');

  // What useSessionStream does when any session's turn ends.
  await act(async () => qc.invalidateQueries({ queryKey: ['sessions'] }));
  await act(async () => new Promise((r) => setTimeout(r, 30)));

  expect(host.textContent).toContain('Session deleted.');
  expect(host.textContent).not.toContain('Could not load');
});
