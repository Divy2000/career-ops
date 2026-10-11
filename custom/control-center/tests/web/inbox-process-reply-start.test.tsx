// A reply to or fork of a finished Process inbox run carries the run on over the pending rows, as a new start does: while
// it is in flight, the server still lists the run as done, so the start has to be marked here or Evaluate visible (and
// any page mounted meanwhile) would start evaluations of the same rows beside it.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineRead, SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
  useNavigate: () => async () => undefined,
  useRouter: () => ({ state: { location: { pathname: '/pipeline', search: { tab: 'inbox' } } }, subscribe: () => () => undefined }),
}));

class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const URL_A = 'https://jobs.example.com/a';
const READ: PipelineRead = {
  kind: 'ok', path: 'data/pipeline.md', etag: 'e',
  rows: [{ url: URL_A, company: 'A Co', role: 'Engineer', location: null, compensation: null, done: false, needsJd: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line: 3 }],
};
const meta = (id: string, status: string): SessionMeta =>
  ({
    id, claudeSessionId: '44444444-4444-4444-8444-444444444444', mode: 'pipeline', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null, status,
    createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: null, lastReason: null, policyVersion: 2,
  }) as SessionMeta;
const DONE = meta('pipe-1', 'done');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let host: HTMLElement;
let root: Root;
let answer: ((r: Response) => void) | null;
let posts: string[];

beforeEach(async () => {
  answer = null;
  posts = [];
  sessionStorage.clear();
  sessionStorage.setItem('cc.pipeline.process', DONE.id);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return new Promise<Response>((resolve) => (answer = resolve));
      }
      if (url === '/api/pipeline') return Promise.resolve(json(200, READ));
      if (url === '/api/sessions') return Promise.resolve(json(200, [DONE]));
      if (url === `/api/sessions/${DONE.id}`) return Promise.resolve(json(200, { meta: DONE, events: [{ seq: 1, ts: DONE.createdAt, event: { type: 'status', status: 'done' } }] }));
      return Promise.resolve(json(200, []));
    }),
  );
  const { InboxAi } = await import('@web/features/pipeline/InboxAi');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(InboxAi, { urls: [URL_A] })))));
  await until(() => !!replyBox() && !replyBox().disabled && !evaluate().disabled, 'the finished run with its reply box, and Evaluate visible on');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const evaluate = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Evaluate visible'))!;
const replyBox = () => host.querySelector<HTMLInputElement>('input[aria-label="Reply to the session"]')!;
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const startMarked = () => sessionStorage.getItem('cc.pipeline.process:starting') !== null;
async function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(replyBox(), text);
    replyBox().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a reply or fork of a finished Process inbox run', () => {
  for (const [label, path] of [['Send', `/api/sessions/${DONE.id}/turns`], ['Fork', `/api/sessions/${DONE.id}/fork`]] as const) {
    it(`given ${label} in flight, the start is marked and Evaluate visible is off until the server answers`, async () => {
      await type('carry on');
      await act(async () => button(label).click());
      expect(posts).toEqual([path]);
      expect(startMarked()).toBe(true);
      expect(evaluate().disabled).toBe(true);
      await act(async () => answer!(json(202, label === 'Fork' ? meta('pipe-2', 'queued') : { ...DONE, status: 'queued' })));
      await until(() => !startMarked(), 'the start mark to clear once the server answered');
      if (label === 'Fork') expect(sessionStorage.getItem('cc.pipeline.process')).toBe('pipe-2');
    });

    it(`given ${label} refused, the start mark is cleared and Evaluate visible comes back`, async () => {
      await type('carry on');
      await act(async () => button(label).click());
      expect(startMarked()).toBe(true);
      await act(async () => answer!(json(409, { error: 'Not continued: session s-9 is evaluating the pending Inbox row' })));
      await until(() => host.querySelector('[role="alert"]')?.textContent?.includes('is evaluating the pending Inbox row'), 'the refusal');
      expect(startMarked()).toBe(false);
      await until(() => !evaluate().disabled, 'Evaluate visible on again');
      expect(sessionStorage.getItem('cc.pipeline.process')).toBe(DONE.id);
    });
  }
});
