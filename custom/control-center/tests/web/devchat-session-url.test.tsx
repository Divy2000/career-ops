// Dev Chat keeps its session in the URL (/dev?session=<id>), so leaving the page (to watch a run, say) and coming back
// reopens the conversation and its per-turn Changes and Revert panel (SW3-web-b-03).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevChatPage, SESSION_CHECK_RETRY, validateDevSearch } from '@web/features/dev/DevChatPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the session's stored events end on: done by default, as the replay of a finished session does. */
let streamStatus: string;
/** The app's one event stream; sessions are read from their stored events, so it carries nothing here. */
class FakeEventSource {
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
const stored = () => [{ seq: 1, ts: '2026-10-05T12:00:00.000Z', event: { type: 'status', status: streamStatus, turn: 1 } }];

let host: HTMLElement;
let root: Root;
let router: AnyRouter;
let changesFetched: string[];
const meta = { id: 's-7', mode: 'devchat', status: 'done', turns: [{ n: 1 }], target: { type: 'none', value: null } };
/** What POST /api/sessions answers; a test can make the start fail. */
let startReply: Record<string, unknown>;
/** Meta fetches of the running session s-r; the first `failingReads` answer 500. */
let runningMetaFetches: number;
let failingReads: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
/** Polls until `cond` holds, so a test waits for what it asserts instead of sleeping a fixed time. */
async function until(cond: () => unknown, what: string, timeoutMs = 1000) {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (cond()) return;
    await act(async () => new Promise((r) => setTimeout(r, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(entry: string) {
  changesFetched = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/sessions') return json(startReply, 202);
      if (init?.method === 'POST' && url === '/api/sessions/s-7/fork') return json({ ...meta, id: 's-8' }, 202);
      if (url === '/api/sessions/s-7') return json({ meta, events: stored() });
      if (url === '/api/sessions/s-8') return json({ meta: { ...meta, id: 's-8' }, events: stored() });
      if (url === '/api/sessions/s-9') return json({ meta: { ...meta, id: 's-9', status: 'error' }, events: stored() });
      // The page's check and the panel's read each ask on open and both get the 500s; their retries get the session.
      if (url === '/api/sessions/s-r') return ++runningMetaFetches <= failingReads ? json({ error: 'internal error' }, 500) : json({ meta: { ...meta, id: 's-r', status: 'running' }, events: stored() });
      if (url === '/api/sessions/s-apply') return json({ meta: { ...meta, id: 's-apply', mode: 'apply' }, events: stored() });
      if (url === '/api/sessions/engine') return json({ playwrightAvailable: false, modes: ['devchat'] });
      if (url.startsWith('/api/sessions/')) return json({ error: 'no such session' }, 404);
      if (url.startsWith('/api/dev/changes/')) {
        changesFetched.push(url);
        return json({ sessionId: 's-7', turns: [{ n: 1, files: [{ path: 'modes/_custom.md', abs: '/x/modes/_custom.md', root: 'data', status: 'modified', additions: 1, deletions: 0, patch: '+rule', canRevert: true }] }] });
      }
      if (url === '/api/actions') return json([]);
      if (url === '/api/dev/git-diff') return json({ ok: true, stat: '', diff: '', error: null });
      return json({ state: 'unavailable' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute({ component: () => createElement('div', null, createElement(Link, { to: '/runs' }, 'Runs'), createElement(Outlet)) });
  const dev = createRoute({ getParentRoute: () => rootRoute, path: '/dev', component: DevChatPage, validateSearch: validateDevSearch });
  const runs = createRoute({ getParentRoute: () => rootRoute, path: '/runs', component: () => createElement('p', null, 'Runs page') });
  const sessions = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => null });
  router = createRouter({ routeTree: rootRoute.addChildren([dev, runs, sessions]), history: createMemoryHistory({ initialEntries: [entry] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  await settle();
}

// The check's retry backoff in milliseconds instead of seconds, so the outage tests do not wait on real delays.
const realRetry = { ...SESSION_CHECK_RETRY };
beforeEach(() => {
  Object.assign(SESSION_CHECK_RETRY, { baseMs: 5, maxMs: 15 });
  changesFetched = [];
  startReply = meta;
  streamStatus = 'done';
  runningMetaFetches = 0;
  failingReads = 2;
  sessionStorage.clear();
});
afterEach(async () => {
  Object.assign(SESSION_CHECK_RETRY, realRetry);
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Dev Chat session in the URL', () => {
  it('given a started session, when the user goes to Runs and back, then the conversation and its Changes come back', async () => {
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await settle();
    expect(router.state.location.search).toEqual({ session: 's-7' });
    await act(async () => router.navigate({ to: '/runs' }));
    await settle();
    expect(host.textContent).toContain('Runs page');
    await act(async () => router.history.back());
    await settle();
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).toBeNull();
    expect(host.querySelector('[aria-label="Reply to the session"]')).not.toBeNull();
    expect(changesFetched.at(-1)).toBe('/api/dev/changes/s-7');
    expect(host.textContent).toContain('modes/_custom.md');
  });

  it('given /dev?session=<id>, when the page opens, then it shows that session, and New conversation starts over', async () => {
    await open('/dev?session=s-7');
    expect(host.querySelector('[aria-label="Reply to the session"]')).not.toBeNull();
    expect(changesFetched).toContain('/api/dev/changes/s-7');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation')!.click());
    await settle();
    expect(router.state.location.search).toEqual({});
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
  });

  it('given a started session, when the nav link opens /dev with no session, then the same session comes back with its Changes and New conversation', async () => {
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await settle();
    await act(async () => router.navigate({ to: '/dev', search: {} }));
    await settle();
    expect(router.state.location.search).toEqual({ session: 's-7' });
    expect(host.querySelector('[aria-label="Reply to the session"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Changes"]')?.textContent).toContain('modes/_custom.md');
    // New conversation forgets it: the next plain /dev starts empty.
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation')!.click());
    await settle();
    await act(async () => router.navigate({ to: '/runs' }));
    await act(async () => router.navigate({ to: '/dev', search: {} }));
    await settle();
    expect(router.state.location.search).toEqual({});
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
  });

  it('given storage that throws (a private window), when /dev opens, then Dev Chat still works', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } });
    await open('/dev');
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
  });

  it('given a stored session that no longer exists, when /dev opens, then it says so, forgets it and offers a new conversation without polling', async () => {
    sessionStorage.setItem('cc.devchat.session', 's-gone');
    await open('/dev');
    await until(() => host.textContent?.includes('That conversation no longer exists'), 'the note', 3000);
    expect(router.state.location.search).toEqual({});
    expect(host.textContent).toContain('That conversation no longer exists');
    expect(sessionStorage.getItem('cc.devchat.session')).toBeNull();
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
    expect(changesFetched.filter((u) => u.endsWith('/s-gone')).length).toBeLessThanOrEqual(1);
  });

  it('given a running session whose first check fails with 500, then the page says so, retries, and the Changes panel polls', async () => {
    streamStatus = 'running';
    // A first retry after a long delay, so the message can be seen before it succeeds.
    Object.assign(SESSION_CHECK_RETRY, { baseMs: 1000, maxMs: 1000 });
    await open('/dev?session=s-r');
    await until(() => host.textContent?.includes('Could not check this conversation'), 'the failed-check message');
    await until(() => changesFetched.filter((u) => u.endsWith('/s-r')).length >= 2, 'Changes polling', 4000);
    expect(runningMetaFetches).toBeGreaterThanOrEqual(3);
    expect(host.textContent).not.toContain('Could not check this conversation');
    expect(router.state.location.search).toEqual({ session: 's-r' });
    expect(changesFetched.filter((u) => u.endsWith('/s-r')).length).toBeGreaterThanOrEqual(2);
  });

  it('given a server down for longer than a few retries (a restart), then the check keeps retrying and polling starts once it is back', async () => {
    streamStatus = 'running';
    // The page's check and the panel's read share the failing answers, so the check fails several times in a row.
    failingReads = 6;
    await open('/dev?session=s-r');
    await until(() => runningMetaFetches > 6 && !host.textContent?.includes('Could not check this conversation'), 'the check to recover', 2000);
    // The Changes panel polls every second once the session is confirmed.
    await until(() => changesFetched.filter((u) => u.endsWith('/s-r')).length >= 2, 'Changes polling', 3000);
  });

  for (const [id, what] of [['s-apply', 'an apply session'], ['engine', 'the engine route']] as const) {
    it(`given ?session=${id} (${what}), then it is treated as no Dev Chat conversation and forgotten`, async () => {
      sessionStorage.setItem('cc.devchat.session', id);
      await open(`/dev?session=${id}`);
      await until(() => host.textContent?.includes('That conversation no longer exists'), 'the note');
      expect(router.state.location.search).toEqual({});
      expect(host.textContent).toContain('That conversation no longer exists');
      expect(sessionStorage.getItem('cc.devchat.session')).toBeNull();
      expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
    });
  }

  it('given a start the server answers with an error, then the error stays on screen', async () => {
    startReply = { ...meta, id: 's-9', status: 'error', error: 'claude is not logged in' };
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await settle();
    expect(router.state.location.search).toEqual({ session: 's-9' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('claude is not logged in');
  });

  it('given a fork from the panel, then the URL follows the fork and the panel is kept, not remounted', async () => {
    await open('/dev?session=s-7');
    const panel = host.querySelector('.session');
    const reply = host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reply, 'Try it another way');
      reply.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fork')!.click());
    await settle();
    expect(router.state.location.search).toEqual({ session: 's-8' });
    expect(host.querySelector('.session')).toBe(panel);
    expect(host.querySelector('.session')!.getAttribute('data-session-id')).toBe('s-8');
  });

  it('keeps only a session id the server could have made', () => {
    expect(validateDevSearch({ session: 's20261005-ab12cd' })).toEqual({ session: 's20261005-ab12cd' });
    expect(validateDevSearch({ session: '../../etc' })).toEqual({});
    expect(validateDevSearch({})).toEqual({});
  });
});
