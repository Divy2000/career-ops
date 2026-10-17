// Dev Chat: moving the page to another session remounts the panel, which reports that session's status only from its
// passive effect. Until it does, the previous session's finished status must not stand for the new one, or New
// conversation is offered beside a running session and the Changes panel treats it as settled (R29-feat-a-X-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let router: AnyRouter;

type PanelProps = { sessionId?: string | null; onStatus?: (s: string, r: string | null) => void };
let panels: PanelProps[];
// Reports nothing by itself, like the real panel before its passive effect runs.
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
}));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const meta = (id: string, status: string) => json({ meta: { id, mode: 'devchat', status, turns: [{ n: 1 }], target: { type: 'none', value: null } }, events: [] });

beforeEach(() => {
  panels = [];
  sessionStorage.clear();
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/sessions/s-a') return meta('s-a', 'done');
      if (url === '/api/sessions/s-b') return meta('s-b', 'running');
      if (url.startsWith('/api/dev/changes/')) return json({ sessionId: url.split('/').pop(), turns: [] });
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
  vi.unstubAllGlobals();
});

async function open(initial: string) {
  const { DevChatPage, validateDevSearch } = await import('@web/features/dev/DevChatPage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const dev = createRoute({ getParentRoute: () => rootRoute, path: '/dev', component: DevChatPage, validateSearch: validateDevSearch });
  router = createRouter({ routeTree: rootRoute.addChildren([dev]), history: createMemoryHistory({ initialEntries: [initial] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}
const newConversation = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation');
const lastPanel = (): PanelProps | undefined => panels[panels.length - 1];

describe('Dev Chat moved to another session', () => {
  it('Given a finished session, When the page moves to a running one, Then New conversation is not offered before the panel reports its status (R29-feat-a-X-01)', async () => {
    await open('/dev?session=s-a');
    await until(() => lastPanel()?.sessionId === 's-a' || undefined, 'the panel on s-a');
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    await until(() => newConversation(), 'New conversation on the finished session');

    await act(async () => router.navigate({ to: '/dev', search: { session: 's-b' } }));
    await until(() => lastPanel()?.sessionId === 's-b' || undefined, 'the panel on s-b');
    expect(newConversation()).toBeUndefined();

    // Once the panel reports the new session finished, it is offered again.
    await act(async () => lastPanel()!.onStatus!('done', 'clean exit with output'));
    await until(() => newConversation(), 'New conversation once s-b reports done');
  });
});
