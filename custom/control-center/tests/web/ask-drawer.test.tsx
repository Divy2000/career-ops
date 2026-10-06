import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The advisor session itself is out of scope: the stub hands its envelope callback to the test while it is mounted, as
// the real panel only delivers envelopes while mounted, and counts how often it was mounted (its session id is its state).
let emitEnvelope: ((kind: string, payload: unknown, turn: number) => void) | null = null;
const panelMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@web/components/SessionPanel', async () => {
  const { useEffect } = await import('react');
  return {
    SessionPanel: (props: { onEnvelope?: (kind: string, payload: unknown, turn: number) => void }) => {
      emitEnvelope = props.onEnvelope ?? null;
      useEffect(() => {
        panelMounts.count++;
        return () => void (emitEnvelope = null);
      }, []);
      return null;
    },
  };
});
const navigations = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ navigate: async (to: unknown) => void navigations.push(to) }),
  useRouterState: () => '/',
}));

let host: HTMLElement;
let root: Root;

beforeEach(async () => {
  document.body.innerHTML = '';
  emitEnvelope = null;
  panelMounts.count = 0;
  navigations.length = 0;
  const { AskDrawer } = await import('@web/components/AskDrawer');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  renderDrawer = (open: boolean) => act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(AskDrawer, { open, onClose: () => undefined })))));
  await renderDrawer(true);
});
let renderDrawer: (open: boolean) => Promise<void>;
afterEach(async () => {
  await act(async () => root.unmount());
});

describe('Ask drawer: proposed actions', () => {
  it('an act envelope naming an Object property is shown as not allowlisted and offers nothing to run', async () => {
    for (const action of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      await act(async () => emitEnvelope!('act', { action, params: {} }, 1));
    }
    const items = [...host.querySelectorAll<HTMLLIElement>('li.proposal')];
    expect(items.map((li) => li.dataset.proposalState)).toEqual(['unsupported', 'unsupported', 'unsupported', 'unsupported']);
    expect(items.map((li) => li.textContent!.replace(/\s+/g, ' '))).toEqual([
      'toString "toString" is not in the action allowlistunsupported',
      'constructor "constructor" is not in the action allowlistunsupported',
      'hasOwnProperty "hasOwnProperty" is not in the action allowlistunsupported',
      '__proto__ "__proto__" is not in the action allowlistunsupported',
    ]);
    expect(host.querySelectorAll('li.proposal button')).toHaveLength(0);
  });

  it('an allowlisted act envelope is offered to run with its label', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/pipeline' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    expect(item.dataset.proposalState).toBe('pending');
    expect(item.textContent).toContain('Open /pipeline');
    expect([...item.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run', 'Dismiss']);
  });

  it('Filter the pipeline opens the Inbox filtered by the proposed query (SW-web-a-07)', async () => {
    await act(async () => emitEnvelope!('act', { action: 'filterPipeline', params: { q: 'Stripe' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => [...item.querySelectorAll('button')].find((b) => b.textContent === 'Run')!.click());
    expect(navigations).toEqual([{ to: '/pipeline', search: { tab: 'inbox', q: 'Stripe' } }]);
    expect(item.dataset.proposalState).toBe('done');
  });
});

describe('Ask drawer: closing and reopening (SW-web-a-13)', () => {
  it('keeps the advisor session while closed, so the conversation is there on reopen and later proposals still arrive', async () => {
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/tracker' } }, 1));
    await renderDrawer(false);
    expect(host.querySelector('[role="dialog"][aria-label="Ask"]:not([hidden])')).toBeNull();
    await act(async () => emitEnvelope!('act', { action: 'navigate', params: { to: '/pipeline' } }, 1));
    await renderDrawer(true);
    expect(panelMounts.count).toBe(1);
    expect([...host.querySelectorAll('li.proposal')].map((li) => li.textContent)).toEqual([expect.stringContaining('Open /tracker'), expect.stringContaining('Open /pipeline')]);
  });
});

describe('Ask drawer: the confirm gate on proposed writes (SW-tests-15)', () => {
  let posts: Array<{ url: string; body: unknown }>;
  beforeEach(() => {
    posts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  async function propose() {
    await act(async () => emitEnvelope!('act', { action: 'setStatus', params: { row: 1, state: 'Responded' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('The advisor proposes a write');
    return item;
  }

  it('a proposed write asks first, and declining writes nothing', async () => {
    const item = await propose();
    expect(posts).toEqual([]);
    await act(async () => bodyButton('Cancel')!.click());
    expect(posts).toEqual([]);
    expect(item.dataset.proposalState).toBe('rejected');
    expect(item.textContent).toContain('declined');
  });

  it('confirming runs the write with the proposed params', async () => {
    const item = await propose();
    await act(async () => bodyButton('Do it')!.click());
    expect(posts).toEqual([{ url: '/api/actions/tracker.setStatus', body: { params: { row: 1, state: 'Responded' } } }]);
    expect(item.dataset.proposalState).toBe('done');
  });
});

describe('Ask drawer: remembering a fact the profile already holds (SW3-tests-25)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: 'deduped' }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says it was already remembered instead of done', async () => {
    await act(async () => emitEnvelope!('act', { action: 'remember', params: { fact: 'Prefers remote roles' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    // remember writes the profile, so it always goes through the write confirm (ASK_ACTIONS: confirm true).
    const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
    await act(async () => button('Review and run').click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('The advisor proposes a write');
    await act(async () => button('Do it').click());
    expect(item.dataset.proposalState).toBe('done');
    expect(item.textContent).toContain('Already remembered');
  });
});

describe('Ask drawer: a confirmed paid proposal starts once (SW3-web-a-05)', () => {
  let starts: number;
  beforeEach(() => {
    starts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST' && url === '/api/sessions') {
          starts++;
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyButton = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);

  it('runs the proposal once while its session is starting, and shows it as running', async () => {
    await act(async () => emitEnvelope!('act', { action: 'evaluate', params: { url: 'https://jobs.example.com/1' } }, 1));
    const item = host.querySelector<HTMLLIElement>('li.proposal')!;
    await act(async () => bodyButton('Review and run')!.click());
    await act(async () => bodyButton('Do it')!.click());
    expect(starts).toBe(1);
    expect(item.dataset.proposalState).toBe('running');
    expect(bodyButton('Review and run')).toBeUndefined();
  });
});

