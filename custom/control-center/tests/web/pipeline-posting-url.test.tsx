// Pipeline > Inbox: Evaluate visible leaves out and reports a pending row whose URL is not a plain http(s) posting
// (credentials in it), by the rule Batch and the pipeline write routes use, instead of sending it into a paid oferta
// session's prompt (R21-feat-b-L3-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineRead, PipelineRow, SessionMeta } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; onStatus?: (s: string, r: string | null) => void };
let panels: PanelProps[];
// The panel's own reply and Fork controls, so a test can tell whether the host lets them be used.
vi.mock('@web/components/SessionPanel', async () => {
  const { createElement: h } = await import('react');
  return {
    SessionPanel: (props: PanelProps) => {
      panels.push(props);
      return h('form', null, h('button', { type: 'submit' }, 'Send'), h('button', { type: 'button' }, 'Fork'));
    },
  };
});

const row = (url: string, company: string, line: number, over: Partial<PipelineRow> = {}): PipelineRow => ({ url, company, role: 'Engineer', location: null, compensation: null, done: false, needsJd: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line, ...over }) as PipelineRow;
let read: PipelineRead;
const session = (id: string, status: string, target: SessionMeta['target'], mode = 'oferta'): SessionMeta =>
  ({
    id, claudeSessionId: '33333333-3333-4333-8333-333333333333', mode, policyClass: 'evaluate', target, model: null, status, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
    turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: 150, lastReason: null, policyVersion: 2,
  }) as SessionMeta;

let host: HTMLElement;
let root: Root;
let queryClient: QueryClient;
let sessions: SessionMeta[];
let posts: Array<{ url: string; body: unknown }>;
// A start the test answers itself, so it can leave the page before the server answers.
let hold: { url: string; release: () => void } | null;
let holdUrl: string | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  panels = [];
  posts = [];
  sessions = [];
  hold = null;
  holdUrl = null;
  read = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/free', 'Free Co', 3), row('https://user:token@jobs.example.com/123', 'Acme', 4)] };
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline') return json(read);
      if (url === '/api/sessions' && !init?.method) return json(sessions);
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url === holdUrl) await new Promise<void>((release) => (hold = { url, release }));
        if (url === '/api/sessions/fanout') return json({ sessions: [{ id: 's-new' }], reserved: [150] });
        if (url === '/api/sessions') return json(session('s-jd', 'queued', { type: 'text', value: 'local:jds/acme.md' }));
      }
      return json([]);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  // A start a failed test left held would count as in flight in the next test.
  await act(async () => (hold as { release: () => void } | null)?.release());
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(tab: 'inbox' | 'batch' = 'inbox') {
  const { PipelinePage } = await import('@web/features/pipeline/PipelinePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: (search: Record<string, unknown>) => ({ tab: (search.tab as typeof tab | undefined) ?? tab }) });
  const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: () => null });
  const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => null });
  const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([pipeline, sessionsRoute, sessionRoute, tracker]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  return router;
}
const button = (start: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(start));
// Lets a start's answer and the move it makes settle, the same way for a user who left and one who stayed.
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 20)));
};

describe('Evaluate visible and a pending URL with credentials (R21-feat-b-L3-01)', () => {
  it('given a pending row whose URL carries credentials, Evaluate visible leaves it out, says so and sends only the clean URL', async () => {
    await mount('inbox');
    await until(() => button('Evaluate visible (1)') && !button('Evaluate visible (1)')!.disabled, 'Evaluate visible enabled');
    expect(host.textContent).toContain('1 row has a URL that is not a plain http(s) posting address (credentials, spaces or another scheme) and is left out of Evaluate visible');
    await act(async () => button('Evaluate visible (1)')!.click());
    await settle();
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.example.com/free'] } }]);
  });
});

describe('Evaluate visible and a pending URL with a space in it (R22-feat-b-L2-01)', () => {
  it('given a hand-edited pending row whose URL cell runs into the role, Evaluate visible leaves it out, says so and sends only the clean URL', async () => {
    read = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/free', 'Free Co', 3), row('https://jobs.acme.com/123 Senior Engineer', '', 4)] };
    await mount('inbox');
    await until(() => button('Evaluate visible (1)') && !button('Evaluate visible (1)')!.disabled, 'Evaluate visible enabled');
    expect(host.textContent).toContain('1 row has a URL that is not a plain http(s) posting address (credentials, spaces or another scheme) and is left out of Evaluate visible');
    await act(async () => button('Evaluate visible (1)')!.click());
    await settle();
    expect(posts).toEqual([{ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.example.com/free'] } }]);
  });
});
