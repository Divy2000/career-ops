// Dev Chat: a session that goes 'gone' while it was running must stop the Changes panel's poll. A 'gone' status is not
// terminal in isTerminal(), so without the guard the Changes panel polls a 404 every second with a standing alert
// (R17-feat-a-L3-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

let onStatus: ((s: string, r: string | null) => void) | null = null;
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: { onStatus?: (s: string, r: string | null) => void }) => {
    onStatus = props.onStatus ?? null;
    return null;
  },
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let changesFetches: number;

beforeEach(() => {
  onStatus = null;
  changesFetches = 0;
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-r') return json({ meta: { id: 's-r', mode: 'devchat', status: 'running', turns: [{ n: 1 }], target: { type: 'none', value: null } }, events: [] });
      if (url.startsWith('/api/dev/changes/')) {
        changesFetches += 1;
        return json({ sessionId: 's-r', turns: [] });
      }
      if (url === '/api/actions') return json([]);
      if (url === '/api/dev/git-diff') return json({ ok: true, stat: '', diff: '', error: null });
      return json({ state: 'unavailable' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  const { DevChatPage, validateDevSearch } = await import('@web/features/dev/DevChatPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const dev = createRoute({ getParentRoute: () => rootRoute, path: '/dev', component: DevChatPage, validateSearch: validateDevSearch });
  const router = createRouter({ routeTree: rootRoute.addChildren([dev]), history: createMemoryHistory({ initialEntries: ['/dev?session=s-r'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}

describe('a Dev Chat session that goes gone', () => {
  it('stops the Changes panel poll once the stream reports gone (R17-feat-a-L3-03)', async () => {
    await open();
    await act(async () => onStatus!('running', null));
    const before = changesFetches;
    await act(async () => vi.advanceTimersByTime(3000));
    expect(changesFetches).toBeGreaterThan(before);

    await act(async () => onStatus!('gone', null));
    const atGone = changesFetches;
    await act(async () => vi.advanceTimersByTime(3000));
    expect(changesFetches).toBe(atGone);
  });
});
