// Pipeline > Inbox > Evaluate visible starts one paid evaluation per row. The server dedupes URLs within one request
// only, so a second click while the first fan-out is starting must not send a second one (SW-web-a-10).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigations = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigations.push(to),
  // The Inbox stays where it is for the whole start: no navigation off it.
  useRouter: () => ({ state: { location: { pathname: '/pipeline', search: { tab: 'inbox' } } }, subscribe: () => () => undefined }),
}));

let host: HTMLElement;
let root: Root;
let posts: unknown[];
let answer: (r: Response) => void;

const URLS = ['https://jobs.example.com/1', 'https://jobs.example.com/2', 'https://jobs.example.com/3'];

beforeEach(async () => {
  navigations.length = 0;
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      // The reads InboxAi makes for its guards (the sessions list, the pipeline): nothing is running.
      if (!init?.method) return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      posts.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => (answer = resolve));
    }),
  );
  const { InboxAi } = await import('@web/features/pipeline/InboxAi');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(InboxAi, { urls: URLS })))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const evaluate = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Evaluate visible'))!;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Inbox Evaluate visible', () => {
  it('a second click while the fan-out is starting sends nothing more', async () => {
    await act(async () => evaluate().click());
    await act(async () => evaluate().click());
    expect(posts).toEqual([{ mode: 'oferta', urls: URLS }]);
    expect(evaluate().disabled).toBe(true);
    await act(async () => answer(json(200, { sessions: [{}, {}, {}], reserved: [42, 43, 44] })));
    expect(navigations).toEqual([{ to: '/sessions' }]);
  });

  it('a refused fan-out can be retried', async () => {
    await act(async () => evaluate().click());
    await act(async () => answer(json(503, { error: 'Claude is not available' })));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not start the evaluations: Claude is not available');
    expect(evaluate().disabled).toBe(false);
    await act(async () => evaluate().click());
    expect(posts).toHaveLength(2);
  });
});
