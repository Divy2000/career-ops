// A reply the server accepts (202) can carry a turn that failed before it ran (no approved CLI, no token): the turn
// never started and the transcript does not record the text. The reply input must keep it for another try once the
// setup is fixed, as it already does for a fork that failed the same way (R25-shared-comp-L1-01).
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

const meta = (status: string, error: string | null = null): SessionMeta =>
  ({
    id: 'sess-1', claudeSessionId: '44444444-4444-4444-8444-444444444444', mode: 'cover', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null, status,
    createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error, reportNum: null, lastReason: null, policyVersion: 2,
  }) as SessionMeta;
const DONE = meta('done');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let host: HTMLElement;
let root: Root | null;
let posts: string[];
let turnReply: SessionMeta;

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
        if (url === `/api/sessions/${DONE.id}/turns`) return json(202, turnReply);
        return json(404, { error: 'not stubbed' });
      }
      if (url === `/api/sessions/${DONE.id}`) return json(200, { meta: DONE, events: [{ seq: 1, ts: DONE.createdAt, event: { type: 'status', status: 'done' } }] });
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

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const replyInput = () => host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]');

async function sendReply(text: string) {
  const { SessionPanel } = await import('@web/components/SessionPanel');
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionPanel, { mode: 'cover', sessionId: DONE.id }))));
  const input = await until(replyInput, 'the reply input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => button('Send') && !button('Send')!.disabled, 'the Send button');
  await act(async () => button('Send')!.click());
  await until(() => posts.some((u) => u.endsWith('/turns')), 'the reply request');
  await until(() => !button('Send')!.disabled || !replyInput()!.value, 'the reply to settle');
}

describe('a reply the server accepted', () => {
  it('given a turn that failed before it ran, keeps the reply text for another try', async () => {
    turnReply = meta('error', 'The installed Claude CLI version is not approved.');
    await sendReply('a long reply worth keeping');
    expect(replyInput()!.value).toBe('a long reply worth keeping');
  });

  it('given a turn that started, clears the reply input', async () => {
    turnReply = meta('running');
    await sendReply('next step please');
    await until(() => replyInput()!.value === '', 'the cleared reply');
  });
});
