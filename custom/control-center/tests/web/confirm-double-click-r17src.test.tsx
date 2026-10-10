// Confirms queue (#72), so a double click on a button that asks first must ask once: the second click is ignored while
// the first is asking or writing. The confirm-opening buttons the feat-a sweep left: the registry ActionButton, Session
// Delete, Evaluate visible, the CV import's Replace cv.md and the advisor's Review and run (R16-merge-01).
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { success: () => undefined, warning: () => undefined, error: () => undefined } }));
vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('@web/components/ModeLauncher', () => ({ ModeLauncher: () => null }));

let host: HTMLElement;
let root: Root;
let routes: Record<string, unknown>;
let calls: Array<{ method: string; url: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {};
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const key = `${method} ${url}`;
      if (key in routes) return json(routes[key]);
      if (method !== 'GET') return json({ ok: true, etag: 'e2', reverted: [], sessions: [], reserved: [] });
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

async function render(component: () => ReactNode, search: Record<string, unknown> = {}, path = '/', pattern = path) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path: pattern, component, validateSearch: () => search });
  const other = createRoute({ getParentRoute: () => rootRoute, path: '/$a/$b', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, other]), history: createMemoryHistory({ initialEntries: [path] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}
// The advisor drawer is a dialog too; only confirm dialogs count.
const dialogs = () => document.querySelectorAll('[role="dialog"]:not(.drawer)').length;
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text));
async function doubleClickAsksOnce(target: () => HTMLButtonElement | null | undefined, confirmLabel: string) {
  const el = await until(target, 'the button');
  await act(async () => {
    el.click();
    el.click();
  });
  const inDialog = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === confirmLabel);
  await until(inDialog, 'the confirm dialog');
  await act(async () => inDialog()!.click());
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(dialogs()).toBe(0);
}


describe('a double click on a confirm-opening button asks once', () => {
  it('a registry action that asks first (ActionButton)', async () => {
    const runs: unknown[] = [];
    const { ActionButton } = await import('@web/components/ActionBar');
    const meta = { id: 'merge', label: 'Merge tracker', cost: 'free', confirm: 'Rewrites applications.md.' };
    await render(() => createElement(ActionButton, { meta: meta as never, onRun: (p: unknown) => void runs.push(p) }));
    await doubleClickAsksOnce(() => byText('Merge tracker'), 'Run');
    expect(runs).toHaveLength(1);
  });

  it('Session Delete', async () => {
    routes['GET /api/sessions/s-1'] = { meta: { id: 's-1', claudeSessionId: '', mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://jobs.example.com/1' }, model: null, status: 'done', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: null, lastReason: null } };
    const { SessionDetailPage } = await import('@web/features/sessions/SessionsPage');
    await render(SessionDetailPage, {}, '/sessions/s-1', '/sessions/$id');
    await doubleClickAsksOnce(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Delete'), 'Delete');
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === '/api/sessions/s-1')).toHaveLength(1);
  });

  it('Evaluate visible above the confirm threshold', async () => {
    const { InboxAi } = await import('@web/features/pipeline/InboxAi');
    const urls = [1, 2, 3, 4].map((i) => `https://jobs.example.com/${i}`);
    await render(() => createElement(InboxAi, { urls }));
    await doubleClickAsksOnce(() => byText('Evaluate visible'), 'Start them');
    expect(calls.filter((c) => c.url === '/api/sessions/fanout')).toHaveLength(1);
  });

  it('CV import Save as cv.md over a written cv.md', async () => {
    routes['GET /api/files/user/cv'] = { kind: 'ok', path: 'cv.md', etag: 'e1', text: '# Old CV\n' };
    const { CvImport } = await import('@web/features/profile/ProfilePage');
    await render(() => createElement(CvImport));
    const area = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="CV markdown"]'), 'the box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '# New CV');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await doubleClickAsksOnce(() => byText('Save as cv.md'), 'Replace cv.md');
    expect(calls.filter((c) => c.method === 'PUT' && c.url === '/api/files/user/cv')).toHaveLength(1);
  });

  it('Advisor Review and run', async () => {
    const envelopes: Array<(k: string, p: unknown) => void> = [];
    const panel = await import('@web/components/SessionPanel');
    vi.spyOn(panel, 'SessionPanel').mockImplementation(((props: { onEnvelope?: (k: string, p: unknown) => void }) => {
      if (props.onEnvelope) envelopes.push(props.onEnvelope);
      return null;
    }) as never);
    const { AskDrawer } = await import('@web/components/AskDrawer');
    await render(() => createElement(AskDrawer, { open: true, onClose: () => undefined }));
    await until(() => envelopes.length > 0 || undefined, 'the panel');
    await act(async () => envelopes.at(-1)!('act', { action: 'remember', params: { fact: 'Prefers remote roles.' } }));
    await doubleClickAsksOnce(() => byText('Review and run'), 'Do it');
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/memory')).toHaveLength(1);
  });
});
