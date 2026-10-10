// Pipeline page: rows already being evaluated are not started again, the Process inbox session survives closing its
// panel and leaving the page, and shortlist links to a saved JD open the file (R13-feat-b-L1-01, -L1-02, -p-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineRead, SessionMeta, ShortlistRead } from '@shared/api';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type PanelProps = { mode: string; sessionId?: string | null; onSessionId?: (id: string) => void; onStatus?: (s: string, r: string | null) => void };
let panels: PanelProps[];
vi.mock('@web/components/SessionPanel', () => ({
  SessionPanel: (props: PanelProps) => {
    panels.push(props);
    return null;
  },
}));

const row = (url: string, company: string, line: number) => ({ url, company, role: 'Engineer', location: null, compensation: null, done: false, needsJd: false, section: 'pending' as const, postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line });
const READ: PipelineRead = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/busy', 'Busy Co', 3), row('https://jobs.example.com/free', 'Free Co', 4), row('local:jds/acme.md', 'Acme', 5)] };
const session = (id: string, status: string, target: SessionMeta['target']): SessionMeta => ({
  id, claudeSessionId: '33333333-3333-4333-8333-333333333333', mode: 'oferta', policyClass: 'oferta', target, model: null, status, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
  turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error: null, reportNum: 150, lastReason: null, policyVersion: 2,
} as SessionMeta);
const SHORTLIST: ShortlistRead = {
  kind: 'ok', path: 'data/shortlist.md', date: '2026-10-10', summary: null, etag: 'e',
  rows: [{ rank: 1, score: 4.5, relevance: 4, sponsor: 'strong', sponsorTier: 'strong', sponsorNote: null, company: 'Acme', role: 'PM', url: 'local:jds/acme.md', location: null, posted: null, why: null }],
  excluded: [{ company: 'Initech', role: 'SRE', url: 'local:jds/initech.md', alert: 'layoffs', date: null, headline: 'Layoffs' }],
};

let host: HTMLElement;
let root: Root;
let sessions: SessionMeta[];
let fanouts: unknown[];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  panels = [];
  fanouts = [];
  sessions = [];
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline') return json(READ);
      if (url === '/api/shortlist') return json(SHORTLIST);
      if (url === '/api/sessions' && !init?.method) return json(sessions);
      if (url === '/api/sessions/fanout') {
        fanouts.push(JSON.parse(String(init!.body)));
        return json({ sessions: [], reserved: [] });
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

async function mount(tab: 'inbox' | 'shortlist' = 'inbox') {
  const { PipelinePage } = await import('@web/features/pipeline/PipelinePage');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: () => ({ tab }) });
  const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/sessions', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([pipeline, sessionsRoute]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
}
const button = (start: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(start));
const pipelinePanel = () => panels.filter((p) => p.mode === 'pipeline').pop();

describe('Pipeline evaluations already running', () => {
  it('Evaluate visible leaves out a row whose evaluation is still running and says so (R13-feat-b-L1-01)', async () => {
    sessions = [session('s-busy', 'running', { type: 'url', value: 'https://jobs.example.com/busy' }), session('s-old', 'done', { type: 'url', value: 'https://jobs.example.com/free' })];
    await mount();
    await until(() => button('Evaluate visible (1)'), 'Evaluate visible without the running row');
    expect(host.textContent).toContain('1 row is already being evaluated');
    await act(async () => button('Evaluate visible (1)')!.click());
    await until(() => fanouts.length === 1 || undefined, 'the fan-out');
    expect(fanouts).toEqual([{ mode: 'oferta', urls: ['https://jobs.example.com/free'] }]);
  });

  it('Evaluate JD stays off while that saved JD is being evaluated (R13-feat-b-L1-01)', async () => {
    sessions = [session('s-jd', 'queued', { type: 'text', value: 'local:jds/acme.md' })];
    await mount();
    const jd = await until(() => host.querySelector<HTMLButtonElement>('button[aria-label="Evaluate JD for Acme"]'), 'Evaluate JD');
    await until(() => jd.disabled, 'Evaluate JD disabled');
    expect(jd.closest('tr')!.textContent).toContain('evaluating');
  });
});

describe('Process inbox', () => {
  it('a running session stays when the button is pressed again, and comes back after leaving the page (R13-feat-b-L1-02)', async () => {
    await mount();
    await act(async () => (await until(() => button('Process inbox'), 'Process inbox')).click());
    await act(async () => pipelinePanel()!.onSessionId!('s-pipe'));
    await act(async () => pipelinePanel()!.onStatus!('running', null));
    await act(async () => button('Process inbox')!.click());
    expect(button('Process inbox')!.getAttribute('aria-expanded')).toBe('true');
    expect(pipelinePanel()).toMatchObject({ sessionId: 's-pipe' });

    await act(async () => root.unmount());
    panels = [];
    await mount();
    await until(() => pipelinePanel(), 'the Process inbox panel');
    expect(pipelinePanel()).toMatchObject({ sessionId: 's-pipe' });
  });
});

describe('Shortlist saved-JD links', () => {
  it('a local:jds/ row and an excluded one link to the saved file, not the literal reference (R13-feat-b-p-01)', async () => {
    await mount('shortlist');
    const link = await until(() => [...host.querySelectorAll('a')].find((a) => a.textContent === 'PM'), 'the shortlist row');
    expect(link.getAttribute('href')).toBe(`/api/files/serve?path=${encodeURIComponent('jds/acme.md')}`);
    const excluded = [...host.querySelectorAll('a')].find((a) => a.textContent === 'SRE')!;
    expect(excluded.getAttribute('href')).toBe(`/api/files/serve?path=${encodeURIComponent('jds/initech.md')}`);
  });
});
