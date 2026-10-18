// Pipeline > Inbox: a saved-JD Evaluate JD start that fails after its row was filtered away still shows its failure
// when the row is shown again (R31-feat-b-L1-01), and Add URLs keeps its box locked while the add is on its way, so
// a URL typed meanwhile is not cleared unsent (R31-feat-b-L1-02).
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

const row = (url: string, company: string, line: number) => ({ url, company, role: 'Engineer', location: null, compensation: null, done: false, needsJd: false, section: 'pending' as const, postedAt: null, rank: null, rankReason: null, note: null, firstSeen: null, source: 'other', seniority: null, line });
const READ: PipelineRead = { kind: 'ok', path: 'data/pipeline.md', etag: 'e', rows: [row('https://jobs.example.com/open', 'Open Co', 3), row('local:jds/2026-10-06_acme_pm.pdf', 'Acme', 4)] };

let host: HTMLElement;
let root: Root;
let answerStart: ((r: Response) => void) | null;
let answerAdd: ((r: Response) => void) | null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  answerStart = null;
  answerAdd = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/pipeline') return json(READ);
      if (url === '/api/sessions' && init?.method === 'POST') return new Promise<Response>((resolve) => (answerStart = resolve));
      if (url === '/api/pipeline/urls') return new Promise<Response>((resolve) => (answerAdd = resolve));
      return json([]);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const rootRoute = createRootRoute();
  const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: (s: Record<string, unknown>) => ({ tab: 'inbox' as const, q: typeof s.q === 'string' ? s.q : undefined }) });
  const router = createRouter({ routeTree: rootRoute.addChildren([pipeline]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(RouterProvider, { router })))));
  await until(() => host.querySelector('tbody tr'), 'the inbox rows');
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const rowOf = (company: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(company));
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text))!;

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('an Evaluate JD start whose row is filtered away before it answers', () => {
  it('shows the failure on the row once the row is shown again', async () => {
    await act(async () => rowOf('Acme')!.querySelector<HTMLButtonElement>('button[aria-label="Evaluate JD for Acme"]')!.click());
    await until(() => answerStart, 'the session start');
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter inbox"]')!;
    await type(filter, 'Open');
    await until(() => !rowOf('Acme'), 'the row filtered away');

    await act(async () => answerStart!(json({ error: 'already evaluating this posting' }, 409)));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Filter inbox"]')!, '');
    await until(() => rowOf('Acme'), 'the row shown again');

    expect(rowOf('Acme')!.querySelector('[role="alert"]')?.textContent).toContain('Could not start the evaluation');
  });
});

describe('Add URLs while the add is on its way', () => {
  it('locks the box, so a URL typed meanwhile is not cleared unsent', async () => {
    await act(async () => button('Add URLs').click());
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Posting URLs"]')!;
    await type(box, 'https://jobs.example.com/a');
    await act(async () => button('Add to pipeline').click());
    await until(() => answerAdd, 'the add request');

    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Posting URLs"]')!.disabled).toBe(true);
    await act(async () => answerAdd!(json({ added: 1 })));
    await until(() => host.textContent?.includes('Added 1 URL'), 'the added note');
  });
});
