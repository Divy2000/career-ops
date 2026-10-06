// Pipeline > Inbox: a checked row is not always one the user skipped. Evaluators (openrouter-runner, batch-evaluate-
// gemini) check rows off in place, and rows under Processed are finished. Only a Pending row can be put back in the
// queue, and doing so says it will be evaluated again (SW4-web-a-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePage } from '@web/features/pipeline/PipelinePage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (url: string, company: string, done: boolean, section: 'pending' | 'done', line: number) => ({ url, company, role: 'Engineer', location: null, compensation: null, done, section, postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line });
const ROWS = [row('https://jobs.example.com/open', 'Open Co', false, 'pending', 3), row('https://jobs.example.com/checked', 'Checked Co', true, 'pending', 4), row('https://jobs.example.com/old', 'Old Co', true, 'done', 8)];

let host: HTMLElement;
let root: Root;
let skips: unknown[];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  skips = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline/skip') {
        skips.push(JSON.parse(String(init!.body)));
        return json({ matched: 1, changed: 1, done: false });
      }
      if (url === '/api/pipeline') return json({ kind: 'ok', path: 'data/pipeline.md', rows: ROWS, etag: 'e' });
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
  const show = await until(() => [...host.querySelectorAll('label')].find((l) => /^Show (done|skipped)$/.test(l.textContent?.trim() ?? ''))?.querySelector('input'), 'the show toggle');
  await act(async () => show.click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const rowOf = (company: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(company))!;
const dialogButton = (name: string) => [...document.body.querySelectorAll('.dialog button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

describe('Inbox rows that are checked off', () => {
  it('labels a checked Pending row done, and a Processed row processed with nothing to undo', () => {
    expect([...host.querySelectorAll('label')].some((l) => l.textContent?.trim() === 'Show done')).toBe(true);
    expect(rowOf('Checked Co').textContent).toContain('done');
    expect(rowOf('Checked Co').textContent).not.toContain('skipped');
    expect(rowOf('Old Co').textContent).toContain('processed');
    expect(rowOf('Old Co').querySelector('button')).toBeNull();
  });

  it('putting a checked Pending row back in the queue says it will be evaluated again, and asks first', async () => {
    await act(async () => rowOf('Checked Co').querySelector('button')!.click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('Put Checked Co back in the queue?');
    expect(document.body.querySelector('#confirm-body')?.textContent).toContain('evaluated again');
    expect(skips).toEqual([]);
    await act(async () => dialogButton('Back to queue')!.click());
    await until(() => skips.length > 0, 'the restore request');
    expect(skips).toEqual([{ url: 'https://jobs.example.com/checked', done: false }]);
  });
});
