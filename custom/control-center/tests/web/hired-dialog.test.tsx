// Setting a row to Hired opens the Hired Wall dialog. hired-share.mjs finds the row by its Report label as written
// ("012"), so the dialog must send that text, and it needs a way out when the script refuses (R7-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRow } from '@shared/api';
import { StatusControl } from '@web/features/tracker/StatusControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let posts: Array<{ url: string; body: { params: Record<string, unknown> } }>;
let markStatus: number;

const ROW: TrackerRow = {
  num: 6, date: '2026-09-30', company: 'Vandelay Systems', role: 'Senior Python Engineer', score: 4.1, scoreRaw: '4.1/5', status: 'Offer',
  pdf: false, pdfRaw: '-', report: 12, reportLabel: '012', notes: '', location: null, url: null, posted: null, lastContact: null, summary: null, reportState: 'ok',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  posts = [];
  markStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/api/actions/tracker.hiredMark') return markStatus === 200 ? json(200, { result: 'marked' }) : json(markStatus, { error: 'No tracker row with state Hired' });
      return json(200, { result: 'ok' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(StatusControl, { row: ROW }))));
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Change status"]')!;
  await act(async () => {
    select.value = 'Hired';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => new Promise((r) => setTimeout(r, 10)));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const dialog = () => host.querySelector('[role="dialog"][aria-label="Hired celebration"]');
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

describe('Hired Wall dialog', () => {
  it('sends the Report label as written, zero padding included', async () => {
    expect(dialog()).not.toBeNull();
    await act(async () => button('Not now').click());
    const mark = posts.find((p) => p.url === '/api/actions/tracker.hiredMark')!;
    expect(mark.body.params).toEqual({ report: '012', mark: 'later' });
  });

  it('can be closed when the script refuses the answer', async () => {
    markStatus = 500;
    await act(async () => button('No, never ask again').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/No tracker row/);
    await act(async () => button('Close').click());
    expect(dialog()).toBeNull();
  });
});
