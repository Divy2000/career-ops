// Two Evaluates of one posting while the first start is still in flight join it, whichever spelling of its URL each
// names (a tracking param, a trailing slash): the server refuses a second start of the posting, so it would fail.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@shared/api';
import { useStartEvaluation } from '@web/features/today/evaluate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let start: ((ref: string) => Promise<SessionMeta>) | null = null;
let posts: string[];
let answer: (() => void) | null = null;

function Harness() {
  start = useStartEvaluation();
  return null;
}

describe('starting an evaluation of another spelling of a posting being started (R25-shared-comp-L2-01 review)', () => {
  beforeEach(async () => {
    posts = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (init?.method === 'POST') {
          posts.push(url);
          await new Promise<void>((resolve) => { answer = resolve; });
          return json({ id: 's-new', mode: 'oferta', status: 'queued', target: { type: 'url', value: 'https://jobs.lever.co/acme/123' } }, 202);
        }
        return json([]);
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('given a start of a posting is in flight, when another spelling of it is started, then it joins the first instead of sending a second start', async () => {
    const first = start!('https://jobs.lever.co/acme/123');
    const second = start!('https://jobs.lever.co/acme/123/?utm_source=linkedin');
    await act(async () => { await Promise.resolve(); });
    expect(posts).toEqual(['/api/sessions']);
    answer!();
    const [a, b] = await act(async () => Promise.all([first, second]));
    expect(b).toBe(a);
  });
});
