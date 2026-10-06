// A panel opened on a session the server no longer has (deleted, or a stale remembered id) says so once, instead of
// showing an empty queued transcript and asking for it forever.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/sessions/gone-1'
        ? new Response('{"error":"session not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
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

describe('a session panel on a session that no longer exists', () => {
  it('says the session no longer exists and offers no reply', async () => {
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'advisor', sessionId: 'gone-1' }))));
    await until(() => host.textContent?.includes('This session no longer exists'), 'the gone message');
    expect(host.querySelector('input[aria-label="Reply to the session"]')).toBeNull();
    expect(host.textContent).not.toMatch(/queued/i);
  });
});
