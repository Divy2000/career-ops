// A panel opened on a session the server no longer has (deleted, or a stale remembered id) says so once, instead of
// showing an empty queued transcript and asking for it forever.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import type { SessionMeta } from '@shared/api';

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

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

  it('tells its host the session is gone, so a host waiting on it stops waiting (SW5-web-b-01)', async () => {
    const statuses: string[] = [];
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'immigration-policy', sessionId: 'gone-1', onStatus: (s: string) => void statuses.push(s) }))));
    await until(() => statuses.includes('gone'), 'the gone status');
  });

  // What POST /api/sessions answers when the turn cannot start (an unapproved CLI, no token): 202 with the session's meta,
  // status error (manager.failBeforeSpawn). Typed as the server's SessionMeta so the stub cannot drift from it.
  const MESSAGE = 'Claude Code 9.9.9 is not approved for Control Center sessions (approved: 2.1.288); run `npm run probe:reads` and add it';
  const FAILED: SessionMeta = {
    id: 's-failed', claudeSessionId: '11111111-1111-4111-8111-111111111111', mode: 'immigration-policy', policyClass: 'immigration-policy', target: { type: 'none', value: null }, model: null,
    status: 'error', createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null,
    error: MESSAGE, reportNum: null, lastReason: null, policyVersion: 2,
  };

  it('tells its host when the session failed to start, and says why (SW4-tests-03)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/sessions' && init?.method === 'POST') return json(202, FAILED);
        if (url === `/api/sessions/${FAILED.id}`) return json(200, { meta: FAILED, events: [{ seq: 1, ts: FAILED.createdAt, event: { type: 'error', message: MESSAGE } }] });
        return json(200, []);
      }),
    );
    let failed = 0;
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'immigration-policy', autoStart: true, initialPrompt: 'Run the pass.', onStartFailed: () => void failed++ }))));
    await until(() => failed === 1, 'the start failure');
    await until(() => host.querySelector('[role="alert"]')?.textContent?.includes('is not approved for Control Center sessions'), 'the reason');
  });

  it('tells its host when the server refuses the start outright (a mode it will not run)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/sessions' && init?.method === 'POST' ? json(422, { error: 'mode batch never runs as a session' }) : json(200, []))));
    let failed = 0;
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'immigration-policy', autoStart: true, initialPrompt: 'Run the pass.', onStartFailed: () => void failed++ }))));
    await until(() => failed === 1, 'the start failure');
    expect(host.textContent).toContain('mode batch never runs as a session');
  });

  // The Ask drawer's panel stays mounted for the life of the app and starts its own sessions: once that session is
  // deleted it must offer a fresh start, not leave the advisor unusable until a reload (R13-shared-comp-L1-01).
  const OK: SessionMeta = { ...FAILED, id: 's-own', status: 'done', error: null };
  const render = async (props: Record<string, unknown>) => {
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'advisor', initialPrompt: 'Ask.', ...props }))));
  };
  const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

  it('a panel whose own session was deleted offers a new start', async () => {
    let deleted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/sessions' && init?.method === 'POST') return json(202, OK);
        if (url === `/api/sessions/${OK.id}`) return deleted ? json(404, { error: 'no such session' }) : json(200, { meta: OK, events: [] });
        if (url === `/api/sessions/${OK.id}/turns`) return json(404, { error: 'no such session' });
        return json(200, []);
      }),
    );
    await render({ autoStart: true });
    await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the started session');
    deleted = true;
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'And then?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await until(() => host.textContent?.includes('This session no longer exists'), 'the gone message after the 404');
    await act(async () => button('Start a new session')!.click());
    expect(host.querySelector('textarea[aria-label="Prompt for advisor"]')).not.toBeNull();
    expect(host.textContent).not.toContain('This session no longer exists');
  });

  it('a panel whose host clears its id falls back to the start form, not a stale remembered id (R17-shared-comp-L1-03)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/sessions' && init?.method === 'POST') return json(202, OK);
        if (url === `/api/sessions/${OK.id}`) return json(200, { meta: OK, events: [] });
        return json(200, []);
      }),
    );
    // The panel starts its own session (autoStart, no host): it holds that id in its own state.
    await render({ autoStart: true });
    await until(() => host.querySelector('input[aria-label="Reply to the session"]'), 'the started session');
    // The host clears the id to null: the panel must show the start form, not its dead local id.
    await render({ sessionId: null, onSessionId: () => undefined });
    expect(host.querySelector('textarea[aria-label="Prompt for advisor"]')).not.toBeNull();
    expect(host.textContent).not.toContain('This session no longer exists');
  });

  it('tells its host a 404 on a reply means the session is gone', async () => {
    const statuses: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `/api/sessions/${OK.id}`) return json(200, { meta: OK, events: [] });
        if (url === `/api/sessions/${OK.id}/turns`) return json(404, { error: 'no such session' });
        return json(200, []);
      }),
    );
    await render({ sessionId: OK.id, onStatus: (s: string) => void statuses.push(s) });
    const input = await until(() => host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]'), 'the reply box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Again');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await until(() => statuses.includes('gone'), 'the gone status');
    // The host owns this id: it decides what comes next, so the panel offers no start of its own.
    expect(button('Start a new session')).toBeUndefined();
  });
});

