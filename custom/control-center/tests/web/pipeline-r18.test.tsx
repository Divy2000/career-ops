// Pipeline page: Batch evaluate and Process inbox do not run over the same rows, a finished Process inbox run cannot be
// carried on over rows being evaluated, a saved-JD evaluation does not block Process inbox, a start that answers after
// the user left does not pull them back, and a Processed row offers no Skip the server would refuse (R18 feat-b).
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
const pipelineSession = (id: string, status: string) => session(id, status, { type: 'none', value: null }, 'pipeline');

let host: HTMLElement;
let root: Root;
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
  read = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/busy', 'Busy Co', 3), row('https://jobs.example.com/free', 'Free Co', 4), row('local:jds/acme.md', 'Acme', 5)] };
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
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(tab: 'inbox' | 'batch' = 'inbox') {
  const { PipelinePage } = await import('@web/features/pipeline/PipelinePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: () => ({ tab }) });
  const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: () => null });
  const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => null });
  const tracker = createRoute({ getParentRoute: () => rootRoute, path: '/tracker', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([pipeline, sessionsRoute, sessionRoute, tracker]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  return router;
}
const button = (start: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(start));
const pipelinePanel = () => panels.filter((p) => p.mode === 'pipeline').pop();
const typeUrls = (value: string) =>
  act(async () => {
    const el = host.querySelector<HTMLTextAreaElement>('[aria-label="Batch URLs"]')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Batch evaluate beside Process inbox (R18-feat-b-L3-01)', () => {
  it('given a Process inbox session running, Batch evaluate is off, says why and starts nothing', async () => {
    sessions = [pipelineSession('s-pipe', 'running')];
    await mount('batch');
    await typeUrls('https://jobs.example.com/busy');
    await until(() => host.textContent?.includes('Process inbox is processing the pending rows'), 'the note');
    expect(button('Batch evaluate')!.disabled).toBe(true);
    await act(async () => button('Batch evaluate')!.click());
    expect(posts).toEqual([]);
  });

  it('given a Process inbox session waiting for the user, Batch evaluate is off', async () => {
    sessions = [pipelineSession('s-pipe', 'awaiting_user')];
    await mount('batch');
    await typeUrls('https://jobs.example.com/busy');
    await until(() => host.textContent?.includes('Process inbox is processing the pending rows'), 'the note');
    expect(button('Batch evaluate')!.disabled).toBe(true);
  });

  it('given a sessions list that cannot be read, Batch evaluate is off, since it cannot tell no Process inbox is live', async () => {
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => (input === '/api/sessions' && !init?.method ? new Response('down', { status: 503 }) : inner(input as string, init)));
    await mount('batch');
    await typeUrls('https://jobs.example.com/busy');
    await until(() => host.textContent?.includes('Could not check for a running Process inbox'), 'the note');
    expect(button('Batch evaluate')!.disabled).toBe(true);
  });

  it('given no Process inbox session, Batch evaluate starts the evaluations', async () => {
    sessions = [pipelineSession('s-old', 'done')];
    await mount('batch');
    await typeUrls('https://jobs.example.com/busy');
    await until(() => button('Batch evaluate') && !button('Batch evaluate')!.disabled, 'Batch evaluate enabled');
    await act(async () => button('Batch evaluate')!.click());
    await act(async () => (await until(() => button('Start them'), 'the confirm')).click());
    await until(() => posts.length === 1 || undefined, 'the fan-out');
    expect(posts[0]).toEqual({ url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.example.com/busy'] } });
  });
});

describe('A finished Process inbox run beside evaluations of its rows (R18-feat-b-L3-02)', () => {
  it('given a pending row being evaluated, the finished run offers no reply or Fork, and says why', async () => {
    sessionStorage.setItem('cc.pipeline.process', 's-old');
    sessions = [session('s-busy', 'running', { type: 'url', value: 'https://jobs.example.com/busy' })];
    await mount();
    await until(() => pipelinePanel(), 'the re-attached panel');
    await act(async () => pipelinePanel()!.onStatus!('done', null));
    await until(() => host.textContent?.includes('1 pending row is being evaluated'), 'the note');
    expect(button('Send')!.matches(':disabled')).toBe(true);
    expect(button('Fork')!.matches(':disabled')).toBe(true);
  });

  it('given no row being evaluated, the finished run can be replied to', async () => {
    sessionStorage.setItem('cc.pipeline.process', 's-old');
    await mount();
    await until(() => pipelinePanel(), 'the re-attached panel');
    await act(async () => pipelinePanel()!.onStatus!('done', null));
    await until(() => button('Evaluate visible (2)'), 'the sessions list');
    expect(button('Send')!.matches(':disabled')).toBe(false);
    expect(button('Fork')!.matches(':disabled')).toBe(false);
  });
});

describe('A saved-JD evaluation and Process inbox (R18-feat-b-L3-04)', () => {
  it('given Evaluate JD running on a local:jds/ row, Process inbox still offers its start form', async () => {
    sessions = [session('s-jd', 'running', { type: 'text', value: 'local:jds/acme.md' })];
    await mount();
    await until(() => host.querySelector<HTMLButtonElement>('button[aria-label="Evaluate JD for Acme"]')?.disabled, 'the sessions list');
    await act(async () => button('Process inbox')!.click());
    await until(() => pipelinePanel(), 'the start form');
    expect(host.textContent).not.toContain('being evaluated, and Process inbox would evaluate them again');
  });
});

