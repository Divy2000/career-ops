// Process inbox is a paid run over every pending Inbox row. A mount of the Inbox whose start is still in flight marks it
// (cc.pipeline.process:starting); a mount made meanwhile, reading a sessions list from before that start, must wait for
// it rather than offer a start form for a second run (R19-feat-b-L1-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
  useRouter: () => ({ state: { location: { pathname: '/pipeline', search: { tab: 'inbox' } } }, subscribe: () => () => undefined }),
}));

const URLS = ['https://jobs.example.com/1'];
let host: HTMLElement;
let root: Root;
let posts: string[];

beforeEach(async () => {
  posts = [];
  sessionStorage.clear();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url);
      // Nothing is listed as running yet: the other mount's start has not reached this list.
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const mount = async () => {
  const { InboxAi } = await import('@web/features/pipeline/InboxAi');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(InboxAi, { urls: URLS })))));
};
const button = (prefix: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(prefix));

describe('Process inbox while another mount is starting a run', () => {
  it('shows the checking status instead of a start form, and sends no second start', async () => {
    sessionStorage.setItem('cc.pipeline.process:starting', String(Date.now()));
    await mount();
    await act(async () => button('Process inbox')!.click());
    expect(host.textContent).toContain('Checking for a Process inbox already running.');
    expect(button('Start session')).toBeUndefined();
    expect(posts).toEqual([]);
  });

  it('offers the start form when no other mount is starting a run', async () => {
    await mount();
    await act(async () => button('Process inbox')!.click());
    expect(button('Start session')).toBeDefined();
  });
});
