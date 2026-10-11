// A fork the server accepts (202) can carry a session that failed before its turn ran (no approved CLI, no token):
// nothing runs in it. The panel must stay on the session it forked from and say why the fork failed, and a launcher
// must keep remembering that session, or leaving the page loses the live conversation for a dead fork.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

const meta = (id: string, status: string, error: string | null = null): SessionMeta =>
  ({
    id, claudeSessionId: '44444444-4444-4444-8444-444444444444', mode: 'cover', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null, status,
    createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error, reportNum: null, lastReason: null, policyVersion: 2,
  }) as SessionMeta;
const ORIGINAL = meta('orig-1', 'awaiting_user');
const FAILED_FORK = meta('fork-1', 'error', 'The installed Claude CLI version is not approved.');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const STORE_KEY = 'cc.test.fork';

let host: HTMLElement;
let root: Root | null;
let posts: string[];

beforeEach(() => {
  posts = [];
  sessionStorage.clear();
  vi.resetModules();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        if (url === `/api/sessions/${ORIGINAL.id}/fork`) return json(202, FAILED_FORK);
        if (url === '/api/sessions') return json(202, ORIGINAL);
        return json(404, { error: 'not stubbed' });
      }
      if (url === `/api/sessions/${ORIGINAL.id}`) return json(200, { meta: ORIGINAL, events: [{ seq: 1, ts: ORIGINAL.createdAt, event: { type: 'status', status: 'awaiting_user' } }] });
      if (url === `/api/sessions/${FAILED_FORK.id}`) return json(200, { meta: FAILED_FORK, events: [{ seq: 1, ts: FAILED_FORK.createdAt, event: { type: 'status', status: 'error' } }] });
      return json(404, { error: 'not stubbed' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, element)));
}
const panelSession = () => host.querySelector<HTMLElement>('.session')?.dataset.sessionId;
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

async function forkWithReply(text: string) {
  const input = await until(() => host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]'), 'the reply input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => button('Fork') && !button('Fork')!.disabled, 'the Fork button');
  await act(async () => button('Fork')!.click());
  await until(() => posts.some((u) => u.endsWith('/fork')), 'the fork request');
}

describe('a fork the server accepted but that failed to start', () => {
  it('given a launcher session, keeps the original in the panel and in the remembered launches, and shows why the fork failed', async () => {
    const { rememberedLaunches } = await import('@web/lib/lastSession');
    rememberedLaunches(STORE_KEY).add({ mode: 'cover', id: ORIGINAL.id });
    const { ModeLauncher } = await import('@web/components/ModeLauncher');
    const launcher = () => createElement(ModeLauncher, { heading: 'Outreach', rememberAs: STORE_KEY, modes: [{ id: 'cover', label: 'Cover letter', prompt: 'Write it.' }] });
    await render(launcher());
    await until(() => panelSession() === ORIGINAL.id, 'the original session');

    await forkWithReply('try another angle');

    await until(() => host.querySelector('[role="alert"]'), 'the fork failure');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(FAILED_FORK.error);
    expect(panelSession()).toBe(ORIGINAL.id);
    expect(rememberedLaunches(STORE_KEY).read().map((l) => l.id)).toEqual([ORIGINAL.id]);

    // Leaving the page and coming back shows the original session, still open for a reply.
    await act(async () => root!.unmount());
    await render(launcher());
    await until(() => panelSession() === ORIGINAL.id, 'the original session after coming back');
    expect(host.querySelectorAll('.session')).toHaveLength(1);
  });

  it('given a session the panel started itself, stays on it and shows why the fork failed', async () => {
    const { SessionPanel } = await import('@web/components/SessionPanel');
    await render(createElement(SessionPanel, { mode: 'cover', initialPrompt: 'Write it.' }));
    await act(async () => button('Start session')!.click());
    await until(() => panelSession() === ORIGINAL.id, 'the started session');

    await forkWithReply('try another angle');

    await until(() => host.querySelector('[role="alert"]'), 'the fork failure');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(FAILED_FORK.error);
    expect(panelSession()).toBe(ORIGINAL.id);
    // Still open for another try once the setup is fixed.
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!.value).toBe('try another angle');
  });

  it('given a host that marks turns as starts, reports the failure without handing it the dead fork', async () => {
    const { SessionPanel } = await import('@web/components/SessionPanel');
    const reported: string[] = [];
    const failed = vi.fn();
    await render(createElement(SessionPanel, { mode: 'cover', sessionId: ORIGINAL.id, marksTurnStarts: true, onStarting: () => undefined, onSessionId: (id: string) => reported.push(id), onStartFailed: failed }));
    await until(() => panelSession() === ORIGINAL.id, 'the original session');

    await forkWithReply('try another angle');

    await until(() => failed.mock.calls.length > 0, 'the start failure report');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(reported).not.toContain(FAILED_FORK.id);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain(FAILED_FORK.error);
  });
});
