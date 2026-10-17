// Pipeline > Inbox > Evaluate visible: a fan-out that answers after the Inbox was unmounted (the Batch tab shown, or the
// pipeline read failing so DataState swaps the Inbox for its error card) still reports what did not start, and why, on
// the next Inbox shown (R28-feat-b-L1-01).
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
  useRouter: () => ({ state: { location: { pathname: '/pipeline', search: { tab: 'inbox' } } }, subscribe: () => () => undefined }),
}));

let host: HTMLElement;
let root: Root;
let answer: (r: Response) => void;
let client: QueryClient;

const URLS = ['https://jobs.example.com/1', 'https://jobs.example.com/2'];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const started = (url: string, status: string, error: string | null = null) => ({ id: url, mode: 'oferta', status, target: { type: 'url', value: url }, error });

async function show(inbox: boolean): Promise<void> {
  const { InboxAi } = await import('@web/features/pipeline/InboxAi');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfirmProvider, null, inbox ? createElement(InboxAi, { urls: URLS }) : null))));
}

beforeEach(async () => {
  navigations.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(json(200, []));
      return new Promise<Response>((resolve) => (answer = resolve));
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await show(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const evaluate = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Evaluate visible'))!;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? null;

describe('Inbox Evaluate visible answered after the Inbox unmounted', () => {
  it('Given a fan-out that partly fails, When the Inbox is shown again, Then the URLs that did not start and why are shown', async () => {
    await act(async () => evaluate().click());
    await show(false);
    await act(async () => answer(json(200, { sessions: [started(URLS[0]!, 'running'), started(URLS[1]!, 'error', `not started: session s1 is already evaluating ${URLS[1]}`)], reserved: [42, 43] })));
    await show(true);
    expect(alertText()).toBe(`Started 1 of 2 evaluations with report number 42. 1 could not start: not started: session s1 is already evaluating ${URLS[1]}`);
    expect(navigations).toEqual([]);
  });

  it('Given a fan-out the server refuses, When the Inbox is shown again, Then the refusal is shown', async () => {
    await act(async () => evaluate().click());
    await show(false);
    await act(async () => answer(json(502, { error: 'spawn failed' })));
    await show(true);
    expect(alertText()).toBe('Could not start the evaluations: spawn failed');
  });

  it('Given a kept failure was shown once, When the Inbox is shown yet again, Then it is not shown a second time', async () => {
    await act(async () => evaluate().click());
    await show(false);
    await act(async () => answer(json(502, { error: 'spawn failed' })));
    await show(true);
    await show(false);
    await show(true);
    expect(alertText()).toBeNull();
  });

  it('Given a fan-out that fully starts, When the Inbox is shown again, Then no stale note is shown', async () => {
    await act(async () => evaluate().click());
    await show(false);
    await act(async () => answer(json(200, { sessions: [started(URLS[0]!, 'running'), started(URLS[1]!, 'running')], reserved: [42, 43] })));
    await show(true);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(alertText()).toBeNull();
  });
});
