import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { success: () => undefined, warning: () => undefined, error: () => undefined } }));

let host: HTMLElement;
let root: Root;
let starts: unknown[];
// The start's answer: the route's 400 for a refused target, or a running session.
let accept: boolean;
const RUNNING = {
  id: 's-1', claudeSessionId: '44444444-4444-4444-8444-444444444444', mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://jobs.example.com/1' }, model: null, status: 'running',
  createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: null, lastReason: null, policyVersion: 2,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  starts = [];
  accept = false;
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/modes') return json([{ id: 'oferta', policyClass: 'read' }]);
      if (method === 'GET' && url === '/api/sessions') return json([]);
      if (method === 'GET' && url === '/api/sessions/s-1') return json({ meta: RUNNING, events: [{ seq: 1, ts: RUNNING.createdAt, event: { type: 'status', status: 'running' } }] });
      // As server/routes/sessions.ts: a url target that is not a plain posting URL is refused.
      if (method === 'POST' && url === '/api/sessions') {
        starts.push(JSON.parse(String(init?.body)));
        if (accept) return json(RUNNING, 202);
        return json({ error: 'a url target must be a plain http(s) job posting URL: no credentials, no spaces, at most 2048 characters' }, 400);
      }
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

async function renderSessions() {
  const { SessionsPage } = await import('@web/features/sessions/SessionsPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: SessionsPage });
  const detail = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, detail]), history: createMemoryHistory({ initialEntries: ['/sessions'] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

async function openNewSession(target: string) {
  await renderSessions();
  await act(async () => (await until(() => button('New session'), 'New session')).click());
  const input = await until(() => document.querySelector<HTMLInputElement>('input[aria-label="New session target"]'), 'the target input');
  await act(async () => type(input, target));
  const prompt = await until(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for oferta"]'), 'the prompt');
  await act(async () => type(prompt, 'Evaluate this posting'));
}

describe('Sessions > New session: a URL target the server refuses', () => {
  it('given a URL with a space in it, when it is typed, then the page says so and Start session is off, so no start is sent', async () => {
    await openNewSession('https://jobs.example.com/1 Senior Engineer');
    const alert = await until(() => [...document.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes('plain http(s) job posting URL')), 'the target warning');
    expect(alert).toBeTruthy();
    const start = button('Start session')!;
    expect(start.matches(':disabled')).toBe(true);
    await act(async () => start.click());
    expect(starts).toEqual([]);
  });

  it('given a URL carrying credentials, when it is typed, then Start session is off', async () => {
    await openNewSession('https://user:secret@jobs.example.com/1');
    expect(button('Start session')!.matches(':disabled')).toBe(true);
  });

  it('given an upper-case scheme carrying credentials, when it is typed, then it is read as a URL and held back, not sent as a company', async () => {
    await openNewSession('HTTPS://user:secret@jobs.example.com/1');
    expect(button('Start session')!.matches(':disabled')).toBe(true);
  });

  it('given a plain posting URL, when it is typed, then there is no warning and Start session sends it as the url target', async () => {
    await openNewSession('https://jobs.example.com/1');
    expect([...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent?.includes('plain http(s) job posting URL'))).toBe(false);
    const start = button('Start session')!;
    expect(start.matches(':disabled')).toBe(false);
    await act(async () => start.click());
    await until(() => starts.length > 0 || undefined, 'the start');
    expect(starts[0]).toMatchObject({ mode: 'oferta', target: { type: 'url', value: 'https://jobs.example.com/1' } });
  });

  it('given a session already started, when the target is then edited into a refused URL, then its Cancel stays usable', async () => {
    accept = true;
    await openNewSession('https://jobs.example.com/1');
    await act(async () => button('Start session')!.click());
    const cancel = await until(() => button('Cancel'), 'the running session Cancel');
    await act(async () => type(document.querySelector<HTMLInputElement>('input[aria-label="New session target"]')!, 'https://jobs.example.com/1 Senior Engineer'));
    expect(cancel.matches(':disabled')).toBe(false);
  });
});
