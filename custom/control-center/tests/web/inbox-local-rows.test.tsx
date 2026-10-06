// Pipeline > Inbox: a pending row whose posting is a saved JD (local:jds/..., written by archive-posting and the Apify
// provider) is listed with a link to that file and can be skipped. Evaluate visible and Process inbox take posting URLs
// only (pipeline mode's liveness sweep hands every row to check-liveness, whose guard refuses a non-http line), so both
// leave such rows out, and the row's own Evaluate JD runs an evaluation of the saved file (SW8-web-a-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineRead } from '@shared/api';
import { PipelinePage } from '@web/features/pipeline/PipelinePage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (url: string, company: string, role: string, source: string, line: number) => ({ url, company, role, location: null, compensation: null, done: false, section: 'pending' as const, postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source, seniority: null, line });
const READ: PipelineRead = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/open', 'Open Co', 'Engineer', 'other', 3), row('local:jds/2026-10-06_acme_pm.pdf', 'Acme', 'PM', 'local', 4)] };

let host: HTMLElement;
let root: Root;
let skips: unknown[];
let starts: unknown[];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  skips = [];
  starts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline/skip') {
        skips.push(JSON.parse(String(init!.body)));
        return json({ matched: 1, changed: 1, done: true });
      }
      if (url === '/api/pipeline') return json(READ);
      if (url === '/api/sessions' && init?.method === 'POST') {
        starts.push(JSON.parse(String(init.body)));
        return json({ id: 's-jd-1', status: 'queued' });
      }
      return json([]);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: () => ({ tab: 'inbox' as const }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([pipeline]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  await until(() => host.querySelector('tbody tr'), 'the inbox rows');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const rowOf = (company: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(company))!;

describe('Inbox rows that point at a saved JD', () => {
  it('lists the row with a link that opens the saved JD', () => {
    expect(host.textContent).toContain('2 rows');
    expect(rowOf('Acme').querySelector('a')!.getAttribute('href')).toBe('/api/files/serve?path=jds%2F2026-10-06_acme_pm.pdf');
  });

  it('skips the row by its reference', async () => {
    await act(async () => rowOf('Acme').querySelector<HTMLButtonElement>('button[aria-label="Skip Acme"]')!.click());
    await until(() => skips.length > 0, 'the skip request');
    expect(skips).toEqual([{ url: 'local:jds/2026-10-06_acme_pm.pdf', done: true }]);
  });

  it('leaves it out of Evaluate visible, which needs a posting URL, and points at the row\'s Evaluate JD', () => {
    const evaluate = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Evaluate visible'))!;
    expect(evaluate.textContent).toContain('Evaluate visible (1)');
    expect(host.textContent).toContain('1 row with a saved JD is left out of Evaluate visible and Process inbox: use Evaluate JD on its row.');
  });

  it('keeps it out of Process inbox, whose liveness sweep would hand it to check-liveness', async () => {
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Process inbox'))!.click());
    const prompt = await until(() => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for pipeline"]'), 'the Process inbox prompt');
    expect(prompt.value).toContain('Leave every local:jds/ row out of this run');
    expect(prompt.value).toContain('not in the liveness sweep');
  });

  it('evaluates the saved JD from its row as an oferta session on that file, and only on such rows', async () => {
    expect(rowOf('Open Co').querySelector('button[aria-label^="Evaluate JD"]')).toBeNull();
    await act(async () => rowOf('Acme').querySelector<HTMLButtonElement>('button[aria-label="Evaluate JD for Acme"]')!.click());
    await until(() => starts.length > 0, 'the session start');
    expect(starts).toEqual([
      expect.objectContaining({ mode: 'oferta', target: { type: 'text', value: 'local:jds/2026-10-06_acme_pm.pdf' }, prompt: expect.stringContaining('jds/2026-10-06_acme_pm.pdf') }),
    ]);
    expect((starts[0] as { prompt: string }).prompt).toMatch(/not a posting URL/);
  });
});
