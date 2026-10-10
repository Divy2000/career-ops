// Dev Chat's "Allow data/blacklist.md this turn" unlocks one turn: once that turn is sent, the box clears, so a later
// turn does not carry the unlock (blacklistAllowed plus X-CC-Explicit: blacklist) without the user ticking it again
// (SW-web-b-06).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { until } from '../helpers/until';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevChatPage } from '@web/features/dev/DevChatPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Whether the session panel has subscribed: an event emitted before that goes nowhere. */
  get listening() {
    return (this.listeners.get('session.event') ?? []).length > 0;
  }
  /** One stored event of session s-1, as the server sends it: a session.event frame on the app event stream. */
  emit(seq: number, event: { type: string; [k: string]: unknown }) {
    const data = JSON.stringify({ sessionId: 's-1', stored: { seq, ts: '2026-10-05T12:00:00.000Z', event }, ts: '2026-10-05T12:00:00.000Z' });
    for (const fn of this.listeners.get('session.event') ?? []) fn(new MessageEvent('session.event', { data }));
  }
  close() {}
}

interface Sent {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
let sent: Sent[];
let host: HTMLElement;
let root: Root;

const meta = { id: 's-1', mode: 'devchat', status: 'queued', turns: [], target: { type: 'none', value: null } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function flush() {
  await act(async () => new Promise((r) => setTimeout(r, 20)));
}
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const button = (name: string, which: 'first' | 'last' = 'first') => {
  const all = [...host.querySelectorAll('button')].filter((b) => b.textContent === name);
  return which === 'first' ? all[0]! : all.at(-1)!;
};
/** React tracks a controlled field's value; set it through the native setter so onChange fires. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

beforeEach(async () => {
  sent = [];
  // A stream left from the previous test would satisfy the stream waits at once.
  FakeEventSource.last = null;
  // Dev Chat reopens the tab's last session from sessionStorage; each test starts a new conversation.
  sessionStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && (url === '/api/sessions' || url.endsWith('/turns') || url.endsWith('/fork'))) {
        sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
        return json(meta, 202);
      }
      if (url === '/api/sessions/s-1') return json({ meta, events: [] });
      if (url === '/api/actions') return json([]);
      if (url === '/api/dev/git-diff') return json({ ok: true, stat: '', diff: '', error: null });
      if (url.startsWith('/api/dev/changes/')) return json({ sessionId: 's-1', turns: [] });
      return json({ state: 'unavailable' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const dev = createRoute({ getParentRoute: () => rootRoute, path: '/dev', component: DevChatPage });
  const session = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([dev, session]), history: createMemoryHistory({ initialEntries: ['/dev'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  await until(() => host.querySelector('textarea[aria-label="Prompt for devchat"]'), 'the Dev Chat prompt');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Dev Chat blacklist unlock', () => {
  it('given the box is ticked, when the first turn is sent, then that turn carries the unlock and the box clears', async () => {
    await click(checkbox());
    expect(checkbox().checked).toBe(true);
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'Block Initech');
    await click(button('Send'));
    await until(() => sent.length === 1, 'the first turn');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.blacklistAllowed).toBe(true);
    expect(sent[0]!.headers['X-CC-Explicit']).toBe('blacklist');
    expect(checkbox().checked).toBe(false);
  });

  it('given the first turn was unlocked, when a later turn is sent without ticking again, then it carries no unlock', async () => {
    await click(checkbox());
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'Block Initech');
    await click(button('Send'));
    await until(() => FakeEventSource.last?.listening, 'the session event stream');
    await act(async () => FakeEventSource.last!.emit(1, { type: 'status', status: 'done', turn: 1 }));
    await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the reply field');
    await type(host.querySelector('input[aria-label="Reply to the session"]')!, 'Now tidy the notes');
    await click(button('Send', 'last'));
    await until(() => sent.length === 2, 'the second turn');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toBe('/api/sessions/s-1/turns');
    expect(sent[1]!.body.blacklistAllowed).toBeUndefined();
    expect(sent[1]!.headers['X-CC-Explicit']).toBeUndefined();
  });

  it('given the box is ticked after a turn, when the reply is forked, then the fork carries the unlock and the box clears (SW-web-b-12)', async () => {
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'A plain turn');
    await click(button('Send'));
    await until(() => FakeEventSource.last?.listening, 'the session event stream');
    await act(async () => FakeEventSource.last!.emit(1, { type: 'status', status: 'done', turn: 1 }));
    await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the reply field');
    await click(checkbox());
    await type(host.querySelector('input[aria-label="Reply to the session"]')!, 'Block Initech in a fork');
    await click(button('Fork'));
    await until(() => sent.at(-1)?.url.endsWith('/fork'), 'the fork');
    expect(sent.at(-1)!.url).toBe('/api/sessions/s-1/fork');
    expect(sent.at(-1)!.body.blacklistAllowed).toBe(true);
    expect(sent.at(-1)!.headers['X-CC-Explicit']).toBe('blacklist');
    expect(checkbox().checked).toBe(false);
  });

  it('given the server refuses the turn, when it fails, then the box stays ticked for the retry', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => (url === '/api/sessions' ? json({ error: 'only a Dev Chat turn can unlock data/blacklist.md' }, 403) : json([])));
    await click(checkbox());
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'Block Initech');
    await click(button('Send'));
    await until(() => host.textContent?.includes('only a Dev Chat turn can unlock'), 'the refusal');
    expect(host.textContent).toContain('only a Dev Chat turn can unlock data/blacklist.md');
    expect(checkbox().checked).toBe(true);
  });

  it('given the session answers 202 with status error (no approved CLI, no token), when it fails to start, then the box stays ticked for the retry (SW5-tests-06)', async () => {
    const failed = { ...meta, status: 'error', error: 'the Claude CLI is not approved' };
    vi.mocked(fetch).mockImplementation(async (url) => (url === '/api/sessions' ? json(failed, 202) : url === '/api/sessions/s-1' ? json({ meta: failed, events: [] }) : json([])));
    await click(checkbox());
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'Block Initech');
    await click(button('Send'));
    await until(() => host.textContent?.includes('the Claude CLI is not approved'), 'the start failure');
    expect(checkbox().checked).toBe(true);
  });

  it('given a later turn answers 202 with status error, when it fails to start, then the box stays ticked for the retry (SW5-tests-06)', async () => {
    await type(host.querySelector('textarea[aria-label="Prompt for devchat"]')!, 'A plain turn');
    await click(button('Send'));
    await until(() => FakeEventSource.last?.listening, 'the session event stream');
    await act(async () => FakeEventSource.last!.emit(1, { type: 'status', status: 'done', turn: 1 }));
    await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the reply field');
    const failed = { ...meta, status: 'error', error: 'the Claude CLI is not approved' };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST' && (String(url).endsWith('/turns') || String(url).endsWith('/fork'))) {
        sent.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
        return json(failed, 202);
      }
      return String(url) === '/api/sessions/s-1' ? json({ meta: failed, events: [] }) : json([]);
    });
    for (const action of ['Send', 'Fork'] as const) {
      await click(checkbox());
      expect(checkbox().checked, action).toBe(true);
      await type(host.querySelector('input[aria-label="Reply to the session"]')!, 'Block Initech');
      const before = sent.length;
      await click(button(action, 'last'));
      await until(() => sent.length === before + 1, `the ${action} turn`);
      await flush();
      expect(checkbox().checked, action).toBe(true);
      await click(checkbox());
    }
  });
});
