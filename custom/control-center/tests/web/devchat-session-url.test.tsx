// Dev Chat keeps its session in the URL (/dev?session=<id>), so leaving the page (to watch a run, say) and coming back
// reopens the conversation and its per-turn Changes and Revert panel (SW3-web-b-03).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevChatPage, SESSION_CHECK_RETRY, validateDevSearch } from '@web/features/dev/DevChatPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { START_REPORT_WINDOW_MS, lastSession } from '@web/lib/lastSession';

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
/** What POST /api/sessions answers; a test can make the start fail, or make the server refuse it with START_REFUSED. */
let startReply: Record<string, unknown>;
const START_REFUSED = { refused: true };
/** While set, POST /api/sessions waits for it, so a test can act while the start is in flight. */
let startGate: Promise<void> | null;
/** While set, a reply to s-7 (POST /api/sessions/s-7/turns) waits for it; `turnRefused` makes the server refuse it. */
let turnGate: Promise<void> | null;
let turnRefused: boolean;
/** Meta fetches of the running session s-r; the first `failingReads` answer 500. */
let runningMetaFetches: number;
let failingReads: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A short pause, only before asserting that something did not happen; a positive assertion waits with `until`. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
/** The Changes panel's poll interval while a session runs (DevChatPage.tsx). */
const POLL_MS = 1000;
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
      if (init?.method === 'POST' && url === '/api/sessions') {
        // Read as the start is sent, so a test can give a later start another gate and reply.
        const gate = startGate;
        const reply = startReply;
        if (gate) await gate;
        return reply === START_REFUSED ? json({ error: 'internal error' }, 500) : json(reply, 202);
      }
      if (init?.method === 'POST' && url === '/api/sessions/s-7/turns') {
        if (turnGate) await turnGate;
        return turnRefused ? json({ error: 'session s-7 is starting a turn' }, 409) : json({ ...meta, status: 'running', turns: [{ n: 1 }, { n: 2 }] }, 202);
      }
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
  startGate = null;
  turnGate = null;
  turnRefused = false;
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
    await until(() => router.state.location.search.session === 's-7', 'the session in the URL');
    expect(router.state.location.search).toEqual({ session: 's-7' });
    await act(async () => router.navigate({ to: '/runs' }));
    await until(() => host.textContent?.includes('Runs page'), 'the Runs page');
    await act(async () => router.history.back());
    await until(() => host.querySelector('[aria-label="Reply to the session"]') && changesFetched.at(-1) === '/api/dev/changes/s-7' && host.textContent?.includes('modes/_custom.md'), 'the conversation and its Changes');
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).toBeNull();
    expect(host.querySelector('[aria-label="Reply to the session"]')).not.toBeNull();
    expect(changesFetched.at(-1)).toBe('/api/dev/changes/s-7');
    expect(host.textContent).toContain('modes/_custom.md');
  });

  it('given /dev?session=<id>, when the page opens, then it shows that session, and New conversation starts over', async () => {
    await open('/dev?session=s-7');
    await until(() => host.querySelector('[aria-label="Reply to the session"]') && changesFetched.includes('/api/dev/changes/s-7'), 'the session and its Changes');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation')!.click());
    await until(() => router.state.location.search.session === undefined && host.querySelector('textarea[aria-label="Prompt for devchat"]'), 'a new conversation');
    expect(router.state.location.search).toEqual({});
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).not.toBeNull();
  });

  it('given a running session, New conversation is not offered, so a second file-editing session cannot start beside it', async () => {
    streamStatus = 'running';
    await open('/dev?session=s-7');
    await until(() => host.querySelector('[aria-label="Reply to the session"]'), 'the running session');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'New conversation')).toBe(false);
  });

  it('given a session waiting for a reply, New conversation is offered, since its turn ended and it has no Cancel', async () => {
    streamStatus = 'awaiting_user';
    await open('/dev?session=s-7');
    await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation'), 'New conversation');
  });

  it('given a start in flight, when the user leaves for Runs before it answers, then they stay on Runs and /dev reopens the session later', async () => {
    let release!: () => void;
    startGate = new Promise((r) => (release = r));
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await act(async () => router.navigate({ to: '/runs' }));
    await until(() => host.textContent?.includes('Runs page'), 'the Runs page');
    await act(async () => release());
    await settle();
    expect(router.state.location.pathname).toBe('/runs');
    await act(async () => router.navigate({ to: '/dev' }));
    await until(() => router.state.location.search.session === 's-7' && host.querySelector('[aria-label="Reply to the session"]'), 'the started session reopened');
  });

  it('given a start in flight, when the user leaves and comes back before it answers, then no second start is offered and the session attaches once it answers', async () => {
    let release!: () => void;
    startGate = new Promise((r) => (release = r));
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await act(async () => router.navigate({ to: '/runs' }));
    await until(() => host.textContent?.includes('Runs page'), 'the Runs page');
    await act(async () => router.navigate({ to: '/dev' }));
    await settle();
    expect(host.querySelector('textarea[aria-label="Prompt for devchat"]')).toBeNull();
    expect(host.textContent).toContain('Starting the conversation');
    const posts = () => (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([u, i]) => u === '/api/sessions' && i?.method === 'POST').length;
    expect(posts()).toBe(1);
    await act(async () => release());
    await until(() => router.state.location.search.session === 's-7' && host.querySelector('[aria-label="Reply to the session"]'), 'the started session attached');
    expect(posts()).toBe(1);
  });

  it.each([
    ['with its session', meta],
    ['with a session that failed to start', { ...meta, id: 's-9', status: 'error', error: 'claude is not logged in' }],
    ['with a refusal', START_REFUSED],
  ])('given a start that outlived the report window, when a newer start is sent and the old one answers late %s, then the newer start keeps its mark and the page stays off the old session', async (_what, lateReply) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let releaseA!: () => void;
      startGate = new Promise((r) => (releaseA = r));
      startReply = lateReply;
      await open('/dev');
      const send = async (text: string) => {
        const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, text);
          prompt.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
      };
      await send('Add a house rule');
      await act(async () => router.navigate({ to: '/runs' }));
      await until(() => host.textContent?.includes('Runs page'), 'the Runs page');
      await act(async () => router.navigate({ to: '/dev' }));
      await until(() => host.textContent?.includes('Starting the conversation'), 'the wait for the first start');
      await act(async () => vi.advanceTimersByTime(START_REPORT_WINDOW_MS + 1));
      await until(() => host.querySelector('textarea[aria-label="Prompt for devchat"]'), 'the form once the mark expired');
      let releaseB!: () => void;
      startGate = new Promise((r) => (releaseB = r));
      startReply = { ...meta, id: 's-8' };
      await send('Add another rule');
      const posts = () => (fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls.filter(([u, i]) => u === '/api/sessions' && i?.method === 'POST').length;
      await until(() => posts() === 2, 'the second start sent');
      await act(async () => releaseA());
      await settle();
      expect(router.state.location.search.session).toBeUndefined();
      expect(lastSession('cc.devchat.session').starting()).toBe(true);
      await act(async () => releaseB());
      await until(() => router.state.location.search.session === 's-8', 'the newer start attached');
      await settle();
      expect(router.state.location.search.session).toBe('s-8');
      expect(lastSession('cc.devchat.session').read()).toBe('s-8');
      expect(lastSession('cc.devchat.session').starting()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('given a started session, when the nav link opens /dev with no session, then the same session comes back with its Changes and New conversation', async () => {
    await open('/dev');
    const prompt = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for devchat"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Add a house rule');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    await until(() => router.state.location.search.session === 's-7', 'the session in the URL');
    await act(async () => router.navigate({ to: '/dev', search: {} }));
    await until(() => router.state.location.search.session === 's-7' && host.querySelector('[aria-label="Reply to the session"]') && host.querySelector('[aria-label="Changes"]')?.textContent?.includes('modes/_custom.md'), 'the same session with its Changes');
    expect(router.state.location.search).toEqual({ session: 's-7' });
    expect(host.querySelector('[aria-label="Reply to the session"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Changes"]')?.textContent).toContain('modes/_custom.md');
    // New conversation forgets it: the next plain /dev starts empty.
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation')!.click());
    await until(() => router.state.location.search.session === undefined, 'the conversation to be forgotten');
    await act(async () => router.navigate({ to: '/runs' }));
    await act(async () => router.navigate({ to: '/dev', search: {} }));
    // Settled on purpose: the check is that the URL does not gain the forgotten session.
    await until(() => host.querySelector('textarea[aria-label="Prompt for devchat"]'), 'the empty Dev Chat');
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
    // Past one Changes poll interval (1 s), so a panel still polling the gone session would have asked again.
    await act(async () => new Promise((r) => setTimeout(r, POLL_MS + 200)));
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
    await until(() => router.state.location.search.session === 's-9' && host.querySelector('[role="alert"]')?.textContent?.includes('claude is not logged in'), 'the start error');
    expect(router.state.location.search).toEqual({ session: 's-9' });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('claude is not logged in');
  });

  // A reply starts a turn that edits files, but the conversation reads as finished until its stream shows the turn:
  // New conversation, here or on a page mounted meanwhile, would start a second file-editing session beside it.
  describe('given a reply to the finished conversation in flight', () => {
    const newConversation = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation');
    async function sendReply() {
      await until(newConversation, 'New conversation on the finished conversation');
      const reply = host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reply, 'Now add a test');
        reply.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
    }

    it('then New conversation is not offered until the server answers, nor while the turn runs', async () => {
      let release!: () => void;
      turnGate = new Promise<void>((r) => (release = r));
      await open('/dev?session=s-7');
      await sendReply();
      expect(newConversation()).toBeUndefined();
      // The server has begun the turn by the time it answers: a read of the session from here on shows it running.
      streamStatus = 'running';
      await act(async () => release());
      await settle();
      expect(newConversation()).toBeUndefined();
    });

    it('when the user leaves for Runs and comes back, then New conversation is not offered until the reply reports', async () => {
      let release!: () => void;
      turnGate = new Promise<void>((r) => (release = r));
      turnRefused = true;
      await open('/dev?session=s-7');
      await sendReply();
      await act(async () => router.navigate({ to: '/runs' }));
      await until(() => host.textContent?.includes('Runs page'), 'the Runs page');
      await act(async () => router.navigate({ to: '/dev' }));
      await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the conversation again');
      await settle();
      expect(newConversation()).toBeUndefined();
      // A second reply from here would be refused beside the first, and the refusal would let go of its start mark.
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!.closest('fieldset')?.disabled).toBe(true);
      // The server refuses the reply: nothing started, and New conversation comes back.
      await act(async () => release());
      await until(newConversation, 'New conversation once the reply was refused');
    });
  });

  it('given a reply mark left by a page that reloaded mid-reply, then New conversation comes back once the report window has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sessionStorage.setItem('cc.devchat.session', 's-7');
      sessionStorage.setItem('cc.devchat.session:starting', String(Date.now()));
      await open('/dev');
      await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the conversation');
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'New conversation')).toBe(false);
      await act(async () => vi.advanceTimersByTime(START_REPORT_WINDOW_MS + 1));
      await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation'), 'New conversation once the mark expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('given a reply this page sent that the server refused, when a page that reloaded mid-reply leaves its mark, then New conversation comes back once the report window has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open('/dev?session=s-7');
      await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation'), 'New conversation');
      const reply = host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(reply, 'Now add a test');
        reply.dispatchEvent(new Event('input', { bubbles: true }));
      });
      // Refused, so the session is still done and nothing is in flight from this page.
      turnRefused = true;
      await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send')!.click());
      await until(() => host.querySelector('[role="alert"]'), 'the refusal');
      await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation'), 'New conversation after the refusal');
      // Another page of this tab marks a reply and reloads before it reports.
      await act(async () => lastSession('cc.devchat.session').setStarting(true));
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'New conversation')).toBe(false);
      await act(async () => vi.advanceTimersByTime(START_REPORT_WINDOW_MS + 1));
      await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'New conversation'), 'New conversation once the mark expired');
    } finally {
      vi.useRealTimers();
    }
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
    await until(() => router.state.location.search.session === 's-8' && host.querySelector('.session')?.getAttribute('data-session-id') === 's-8', 'the fork');
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
