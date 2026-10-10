// Confirms queue (#72), so a double click on a button that asks first must ask once: the second click is ignored while
// the first is asking or writing. One test per confirm-opening button on the Apply, Follow-ups, Pipeline, Dev Chat and
// Profile pages.
import { createElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('sonner', () => ({ toast: { success: () => undefined, warning: () => undefined, error: () => undefined } }));
vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('@web/components/ModeLauncher', () => ({ ModeLauncher: () => null }));

let host: HTMLElement;
let root: Root;
let routes: Record<string, unknown>;
let calls: Array<{ method: string; url: string }>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  routes = {};
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const key = `${method} ${url}`;
      if (key in routes) return json(routes[key]);
      if (method !== 'GET') return json({ ok: true, etag: 'e2', reverted: [], sessions: [], reserved: [] });
      return json({ error: 'not stubbed' }, 404);
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

async function render(component: () => ReactNode, search: Record<string, unknown> = {}, path = '/') {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const rootRoute = createRootRoute({ component: () => createElement(ConfirmProvider, null, createElement(Outlet)) });
  const page = createRoute({ getParentRoute: () => rootRoute, path, component, validateSearch: () => search });
  const other = createRoute({ getParentRoute: () => rootRoute, path: '/$a/$b', component: () => null });
  const router = createRouter({ routeTree: rootRoute.addChildren([page, other]), history: createMemoryHistory({ initialEntries: [path] }) });
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RouterProvider, { router }))));
}
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const byLabel = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text));
async function doubleClickAsksOnce(target: () => HTMLButtonElement | null | undefined, confirmLabel: string) {
  const el = await until(target, 'the button');
  await act(async () => {
    el.click();
    el.click();
  });
  const inDialog = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === confirmLabel);
  await until(inDialog, 'the confirm dialog');
  await act(async () => inDialog()!.click());
  await act(async () => new Promise((r) => setTimeout(r, 30)));
  expect(dialogs()).toBe(0);
}

describe('a double click on a confirm-opening button asks once', () => {
  it('Batch evaluate', async () => {
    const { BatchTab } = await import('@web/features/pipeline/BatchTab');
    await render(() => createElement(BatchTab));
    const area = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Batch URLs"]'), 'the box');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'https://jobs.example.com/1');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await doubleClickAsksOnce(() => byText('Batch evaluate'), 'Start them');
    expect(calls.filter((c) => c.url === '/api/sessions/fanout')).toHaveLength(1);
  });

  it('Follow-ups Clear pin and Delete follow-up', async () => {
    const entry = { num: 3, company: 'Acme', role: 'SRE', status: 'applied', score: '4/5', appliedDate: '2026-09-01', daysSinceApplication: 30, daysSinceLastFollowup: 5, followupCount: 1, urgency: 'waiting', nextFollowupDate: '2026-10-20', daysUntilNext: 10, nextOverride: '2026-10-20', contacts: [], followups: [{ num: 7, date: '2026-10-01', channel: 'Email', contact: '', notes: '' }] };
    routes['GET /api/followups'] = { metadata: { analysisDate: '2026-10-10', totalTracked: 1, actionable: 0, overdue: 0, urgent: 0, cold: 0, waiting: 1, retired: 0 }, entries: [entry] };
    const { CadenceTab } = await import('@web/features/followups/FollowupsPage');
    await render(CadenceTab);
    await doubleClickAsksOnce(() => byLabel('Clear pinned date for Acme'), 'Clear pin');
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === '/api/followups/override')).toHaveLength(1);
    await act(async () => byLabel('Show history for Acme')!.click());
    await doubleClickAsksOnce(() => byLabel('Delete follow-up 7'), 'Delete');
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === '/api/followups/log')).toHaveLength(1);
  });

  it('Pipeline Back to queue', async () => {
    const row = { url: 'https://jobs.example.com/x', company: 'Acme', role: 'SRE', location: null, compensation: null, done: true, needsJd: false, section: 'pending', postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line: 3 };
    routes['GET /api/pipeline'] = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row] };
    routes['GET /api/sessions'] = [];
    const { PipelinePage } = await import('@web/features/pipeline/PipelinePage');
    await render(PipelinePage, { tab: 'inbox' }, '/pipeline');
    const show = await until(() => [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Show done'))?.querySelector('input'), 'Show done');
    await act(async () => show.click());
    await doubleClickAsksOnce(() => byLabel('Restore Acme'), 'Back to queue');
    expect(calls.filter((c) => c.url === '/api/pipeline/skip')).toHaveLength(1);
  });

  it('Dev Chat Revert turn', async () => {
    routes['GET /api/dev/changes/s-dev'] = { sessionId: 's-dev', turns: [{ n: 1, files: [{ path: 'custom/x.ts', abs: '/r/custom/x.ts', root: 'code', status: 'modified', additions: 1, deletions: 1, patch: '-a\n+b', canRevert: true }] }] };
    const { ChangesPanel } = await import('@web/features/dev/DevChatPage');
    await render(() => createElement(ChangesPanel, { sessionId: 's-dev', live: false }));
    await doubleClickAsksOnce(() => byText('Revert turn'), 'Revert');
    expect(calls.filter((c) => c.url === '/api/dev/revert')).toHaveLength(1);
  });

  it('Projects Delete', async () => {
    routes['GET /api/projects'] = { path: 'article-digest.md', kind: 'ok', etag: 'e1', validation: { ok: true, errors: [], warnings: [] }, entries: [{ id: 'router', title: 'Router', url: null, tagline: null, tags: [], kind: 'project', dates: null, source: null, bullets: ['One.'], line: 5, editProblem: null, inCv: false }] };
    const { ProjectsLibrary } = await import('@web/features/profile/ProjectsLibrary');
    await render(ProjectsLibrary);
    await doubleClickAsksOnce(() => byLabel('Delete Router'), 'Delete');
    expect(calls.filter((c) => c.method === 'DELETE' && c.url === '/api/projects/router')).toHaveLength(1);
  });

  it('Apply New draft over edited answers', async () => {
    sessionStorage.setItem('cc.apply.12', 's-apply-12');
    routes['GET /api/apply/documents?n=12'] = { pdfs: ['output/cv.pdf'], covers: [], suggestedPdf: 'output/cv.pdf', suggestedCover: null };
    const envelopes: Array<(k: string, p: unknown, t: number) => void> = [];
    const statuses: Array<(s: string, r: string | null) => void> = [];
    const panel = await import('@web/components/SessionPanel');
    vi.spyOn(panel, 'SessionPanel').mockImplementation(((props: { onEnvelope?: (k: string, p: unknown, t: number) => void; onStatus?: (s: string, r: string | null) => void }) => {
      if (props.onEnvelope) envelopes.push(props.onEnvelope);
      if (props.onStatus) statuses.push(props.onStatus);
      return null;
    }) as never);
    const { ApplyBody } = await import('@web/features/apply/ApplyPage');
    await render(() => createElement(ApplyBody, { n: '12', company: 'Acme', postingUrl: 'https://jobs.example.com/1' }));
    await until(() => envelopes.length > 0 || undefined, 'the panel');
    await act(async () => statuses.at(-1)!('done', null));
    await act(async () => envelopes.at(-1)!('answers', { fields: [{ id: 'n', label: 'Name', type: 'text', required: true, value: 'A', needsConfirmation: false }] }, 1));
    const input = await until(() => host.querySelector<HTMLInputElement>('[aria-label="Drafted answers"] input'), 'the answers');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await doubleClickAsksOnce(() => byText('New draft'), 'Discard changes');
  });
});
