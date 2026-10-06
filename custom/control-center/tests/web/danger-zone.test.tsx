// Application > Documents > Danger zone: a tracker row is deleted in two steps. The real delete is offered only after a
// dry run has shown what it would do, and a failed delete stays on the page with the reason (SW-tests-15).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigations = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigations.push(to),
}));

let host: HTMLElement;
let root: Root;
let confirmations: unknown[];
let posts: Array<{ n: number; dryRun: boolean }>;
let realDelete: () => Response;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  navigations.length = 0;
  posts = [];
  confirmations = [];
  // What POST /api/actions/tracker.delete answers: tracker.mjs delete prints only to stderr, so result is '' and the
  // run's words are in stderr (server/routes/actions.ts, tracker.mjs deleteApp).
  realDelete = () => json(200, { result: '', stderr: 'Removed application 4 (1 row) from /data/applications.md and reindexed.\n' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/actions/tracker.delete' || init?.method !== 'POST') return json(404, { error: 'not stubbed' });
      const { params, confirmed } = JSON.parse(String(init.body)) as { params: { n: number; dryRun: boolean }; confirmed?: unknown };
      posts.push(params);
      confirmations.push(confirmed);
      return params.dryRun ? json(200, { result: '', stderr: 'Would remove application 4 (1 row) from /data/applications.md.\n(report file would be orphaned: reports/004-initech-cloud.md)\n' }) : realDelete();
    }),
  );
  const { DangerZone } = await import('@web/features/tracker/DangerZone');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(DangerZone, { n: 4 }))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const click = async (name: string) => act(async () => button(name)!.click());

describe('Danger zone delete', () => {
  it('offers the real delete only after a dry run, which deletes nothing and shows what would happen', async () => {
    expect(button('Confirm delete #4')).toBeUndefined();
    await click('Preview delete (dry run)');
    expect(posts).toEqual([{ n: 4, dryRun: true }]);
    expect(host.querySelector('[aria-label="Delete preview"]')!.textContent).toBe('Would remove application 4 (1 row) from /data/applications.md.\n(report file would be orphaned: reports/004-initech-cloud.md)');
    expect(button('Confirm delete #4')).toBeDefined();
    expect(navigations).toEqual([]);
  });

  it('confirming sends the real delete and returns to the tracker', async () => {
    await click('Preview delete (dry run)');
    await click('Confirm delete #4');
    expect(posts).toEqual([
      { n: 4, dryRun: true },
      { n: 4, dryRun: false },
    ]);
    // The preview needs no confirmation; "Confirm delete" is the user's confirmation, which the server requires.
    expect(confirmations).toEqual([undefined, true]);
    expect(navigations).toEqual([{ to: '/tracker' }]);
  });

  it('a failed delete stays on the page and says why', async () => {
    // A tracker lock that stays busy: tracker.mjs exits 1 with "Fatal: ...", and the action has no exit map, so a 500.
    realDelete = () => json(500, { error: 'tracker.delete exited 1', exit: 1, result: '', stderr: 'Fatal: Timed out waiting for tracker lock at /data/applications.md.lock\n' });
    await click('Preview delete (dry run)');
    await click('Confirm delete #4');
    expect(navigations).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('tracker.delete exited 1 (Fatal: Timed out waiting for tracker lock at /data/applications.md.lock)');
  });

  it('leaves for the tracker at once and never refetches the deleted row, which would 404 and stall on retries (SW5-web-a-04)', async () => {
    const { DangerZone } = await import('@web/features/tracker/DangerZone');
    const { useQuery } = await import('@tanstack/react-query');
    // The application page around the danger zone: the row's detail and its documents, as the real page holds them.
    const reads: string[] = [];
    const read = (key: string) => async () => {
      reads.push(key);
      return { ok: true };
    };
    function Page() {
      useQuery({ queryKey: ['tracker', 'row', '4'], queryFn: read('row') });
      useQuery({ queryKey: ['tracker', 'documents', 4], queryFn: read('documents') });
      return createElement(DangerZone, { n: 4 });
    }
    // Real retry timing (main.tsx): a refetch of the deleted row that fails would wait a second before giving up.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Page))));
    await until(() => reads.length === 2, 'the page queries');
    await click('Preview delete (dry run)');
    reads.length = 0;
    await click('Confirm delete #4');
    expect(navigations).toEqual([{ to: '/tracker' }]);
    expect(reads).toEqual([]);
    expect(qc.getQueryState(['tracker', 'row', '4'])).toBeUndefined();
  });
});

