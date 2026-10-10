// Evaluate on Today: a saved-JD shortlist row (`local:jds/<file>`) opens the saved file and evaluates it as a saved
// JD, never as a URL to fetch (R13-feat-c-01); and a posting whose evaluation is still queued, running or waiting on
// the user links to that session instead of starting a second paid one, from the shortlist and from Quick evaluate
// (R13-feat-c-L3-03).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShortlistRead, ShortlistRow } from '@shared/api';
import { TodayPage } from '@web/features/today/TodayPage';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let router: AnyRouter;
let sessions: Array<{ id: string; mode: string; status: string; target: { type: string; value: string | null } }>;
let posts: Array<{ mode: string; target: { type: string; value: string } }>;
/** While set, POST /api/sessions waits for release before answering. */
let held: Array<() => void> | null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const row = (rank: number, company: string, url: string | null): ShortlistRow => ({ rank, score: 4, relevance: null, sponsor: 'strong', sponsorTier: 'strong', sponsorNote: null, company, role: `${company} engineer`, url, location: null, posted: null, why: null }) as ShortlistRow;
let shortlist: ShortlistRead;

beforeEach(() => {
  sessions = [];
  posts = [];
  held = null;
  shortlist = { kind: 'ok', path: 'data/shortlist.md', date: '2026-10-10', summary: null, etag: 's1', excluded: [], rows: [row(1, 'Acme', 'local:jds/acme.md'), row(2, 'Globex', 'https://jobs.example.com/globex/1')] };
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { mode: string; target: { type: string; value: string } };
        posts.push(body);
        if (held) await new Promise<void>((r) => held!.push(r));
        const meta = { id: `s${posts.length}`, mode: body.mode, status: 'queued', target: body.target };
        sessions.push(meta);
        return json(202, meta);
      }
      if (url === '/api/sessions') return json(200, sessions);
      if (url === '/api/shortlist') return json(200, shortlist);
      return json(502, { error: 'not stubbed' });
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function today() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: TodayPage });
  const session = createRoute({ getParentRoute: () => rootRoute, path: '/sessions/$id', component: () => createElement('p', null, 'Session page') });
  router = createRouter({ routeTree: rootRoute.addChildren([index, session]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(RouterProvider, { router }))));
  await until(() => rowOf('Globex'), 'the shortlist rows');
}
const rowOf = (company: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(`${company} engineer`));
const evaluateIn = (company: string) => [...(rowOf(company)?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim().startsWith('Evaluate'));
const click = (el: HTMLElement) => act(async () => el.click());

describe('a saved-JD shortlist row', () => {
  it('links to the saved file, not the literal local: reference', async () => {
    await today();
    const link = rowOf('Acme')!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/api/files/serve?path=jds%2Facme.md');
  });

  it('evaluates as a saved JD, with no URL to check or fetch', async () => {
    await today();
    await click(evaluateIn('Acme')!);
    await until(() => posts.length === 1, 'the session start');
    expect(posts[0]).toMatchObject({ mode: 'oferta', target: { type: 'text', value: 'local:jds/acme.md' } });
    await until(() => router.state.location.pathname === '/sessions/s1', 'the session page');
  });
});

describe('a posting whose evaluation is still active', () => {
  it('links to that session from its shortlist row instead of offering a second Evaluate', async () => {
    sessions = [{ id: 'run-1', mode: 'oferta', status: 'running', target: { type: 'url', value: 'https://jobs.example.com/globex/1' } }];
    await today();
    await until(() => !evaluateIn('Globex'), 'the Evaluate button to give way');
    const link = [...rowOf('Globex')!.querySelectorAll('a')].find((a) => a.textContent?.includes('Evaluation running'));
    expect(link?.getAttribute('href')).toBe('/sessions/run-1');
    expect(evaluateIn('Acme')).toBeDefined();
  });

  it('shows the running evaluation on coming back to Today right after starting it', async () => {
    await today();
    await click(evaluateIn('Globex')!);
    await until(() => router.state.location.pathname === '/sessions/s1', 'the session page');
    await act(async () => router.history.back());
    await until(() => rowOf('Globex'), 'Today again');
    expect(evaluateIn('Globex')).toBeUndefined();
    expect([...rowOf('Globex')!.querySelectorAll('a')].some((a) => a.textContent?.includes('Evaluation running'))).toBe(true);
  });

  it('a finished evaluation offers Evaluate again', async () => {
    sessions = [{ id: 'old', mode: 'oferta', status: 'done', target: { type: 'url', value: 'https://jobs.example.com/globex/1' } }];
    await today();
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(evaluateIn('Globex')).toBeDefined();
  });

  it('Quick evaluate opens the active session for that URL instead of starting another', async () => {
    sessions = [{ id: 'run-1', mode: 'oferta', status: 'awaiting_user', target: { type: 'url', value: 'https://jobs.example.com/globex/1' } }];
    await today();
    const input = host.querySelector<HTMLInputElement>('[aria-label="Posting URL to evaluate"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' https://jobs.example.com/globex/1 ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Evaluate URL')!);
    await until(() => router.state.location.pathname === '/sessions/run-1', 'the active session');
    expect(posts).toHaveLength(0);
  });

  it('a second start for the same posting while the first is still on its way joins it instead of starting another', async () => {
    await today();
    held = [];
    await click(evaluateIn('Globex')!);
    await until(() => held?.length === 1, 'the first start on its way');
    const input = host.querySelector<HTMLInputElement>('[aria-label="Posting URL to evaluate"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://jobs.example.com/globex/1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Evaluate URL')!);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const waiting = held!;
    held = null;
    await act(async () => waiting.forEach((r) => r()));
    await until(() => router.state.location.pathname === '/sessions/s1', 'the session page');
    expect(posts).toHaveLength(1);
  });
});
