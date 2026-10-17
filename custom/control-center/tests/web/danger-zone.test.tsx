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
// Where the user is: the application page of row 4 unless a test moves them.
const location = vi.hoisted(() => ({ pathname: '/tracker/4' }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigations.push(to),
  useRouter: () => ({ state: { location } }),
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
  location.pathname = '/tracker/4';
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

  describe('when the page holds the row it shows (R28-feat-c-L1-01)', () => {
    const initech = { num: 4, company: 'Initech Cloud', role: 'Backend Engineer II', report: 4 };
    let qc: QueryClient;
    beforeEach(async () => {
      qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      qc.setQueryData(['tracker', 'row', '4'], { row: initech });
      await act(async () => root.unmount());
      root = createRoot(host);
      const { DangerZone } = await import('@web/features/tracker/DangerZone');
      await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(DangerZone, { n: 4 }))));
    });

    it('the confirmed delete names the previewed row, so the server can refuse a different one', async () => {
      await click('Preview delete (dry run)');
      await click('Confirm delete #4');
      expect(posts).toEqual([
        { n: 4, dryRun: true },
        { n: 4, dryRun: false, expectCompany: 'Initech Cloud', expectRole: 'Backend Engineer II', expectReport: 4 },
      ]);
    });

    it('drops the preview and its confirm once a different application is under that number', async () => {
      await click('Preview delete (dry run)');
      expect(button('Confirm delete #4')).toBeDefined();
      await act(async () => qc.setQueryData(['tracker', 'row', '4'], { row: { num: 4, company: 'Hooli', role: 'SRE', report: 9 } }));
      expect(button('Confirm delete #4')).toBeUndefined();
      expect(host.querySelector('[aria-label="Delete preview"]')).toBeNull();
    });

    it('a previewed row without a report says so, so a re-added row that has one is not taken for it', async () => {
      await act(async () => qc.setQueryData(['tracker', 'row', '4'], { row: { ...initech, report: null } }));
      await click('Preview delete (dry run)');
      await click('Confirm delete #4');
      expect(posts[1]).toEqual({ n: 4, dryRun: false, expectCompany: 'Initech Cloud', expectRole: 'Backend Engineer II', expectReport: null });
    });

    it('keeps the preview when the same row is refetched', async () => {
      await click('Preview delete (dry run)');
      await act(async () => qc.setQueryData(['tracker', 'row', '4'], { row: { ...initech } }));
      expect(button('Confirm delete #4')).toBeDefined();
    });

    it('given the page was opened as /tracker/04, when the delete is confirmed, then it still names the row the page shows', async () => {
      qc.removeQueries({ queryKey: ['tracker', 'row', '4'] });
      await act(async () => qc.setQueryData(['tracker', 'row', '04'], { row: initech }));
      await click('Preview delete (dry run)');
      await click('Confirm delete #4');
      expect(posts[1]).toEqual({ n: 4, dryRun: false, expectCompany: 'Initech Cloud', expectRole: 'Backend Engineer II', expectReport: 4 });
      // The page's own row query is dropped too, so it does not refetch into a 404.
      expect(qc.getQueryState(['tracker', 'row', '04'])).toBeUndefined();
    });
  });

  it('a failed delete stays on the page and says why', async () => {
    // A tracker lock that stays busy: tracker.mjs exits 1 with "Fatal: ...", and the action has no exit map, so a 500.
    realDelete = () => json(500, { error: 'tracker.delete exited 1', exit: 1, result: '', stderr: 'Fatal: Timed out waiting for tracker lock at /data/applications.md.lock\n' });
    await click('Preview delete (dry run)');
    await click('Confirm delete #4');
    expect(navigations).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('tracker.delete exited 1 (Fatal: Timed out waiting for tracker lock at /data/applications.md.lock)');
  });

  /** Confirms a delete that a held tracker lock keeps from answering, and returns the release of that lock. */
  async function confirmHeldDelete(qc: QueryClient) {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const fetchStub = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = fetchStub.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      const res = await inner(url, init);
      if (!(JSON.parse(String(init?.body)) as { params: { dryRun: boolean } }).params.dryRun) await held;
      return res;
    });
    const { DangerZone } = await import('@web/features/tracker/DangerZone');
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(DangerZone, { n: 4 }))));
    await click('Preview delete (dry run)');
    await act(async () => void button('Confirm delete #4')!.click());
    await until(() => posts.length === 2, 'the real delete to be sent');
    return async () =>
      act(async () => {
        answer();
        await new Promise((r) => setTimeout(r, 20));
      });
  }

  it('a delete that answers after the user left the page does not pull them back to the tracker (R19-feat-c-L3-01)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['tracker', 'row', '4'], { ok: true });
    const release = await confirmHeldDelete(qc);
    // Meanwhile the user goes to Pipeline.
    location.pathname = '/pipeline';
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement('p', null, 'Pipeline'))));
    await release();
    expect(navigations).toEqual([]);
    // The row is still gone from the cache, whichever page the user is on.
    expect(qc.getQueryState(['tracker', 'row', '4'])).toBeUndefined();
  });

  it('a delete that answers after the user switched to another tab of the same application still leaves the deleted row', async () => {
    const qc = new QueryClient();
    const release = await confirmHeldDelete(qc);
    // The Report tab: the danger zone unmounts, but the user is still on /tracker/4, whose row is gone.
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement('p', null, 'Report'))));
    await release();
    expect(navigations).toEqual([{ to: '/tracker' }]);
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
      const row = useQuery({ queryKey: ['tracker', 'row', '4'], queryFn: read('row') });
      const documents = useQuery({ queryKey: ['tracker', 'documents', 4], queryFn: read('documents') });
      return createElement('div', { 'data-loaded': String(row.isSuccess && documents.isSuccess) }, createElement(DangerZone, { n: 4 }));
    }
    // Real retry timing (main.tsx): a refetch of the deleted row that fails would wait a second before giving up.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Page))));
    // A user deletes from a page that has finished loading. React Query delivers a finished fetch to the page on a
    // later tick; waiting only for the fetches to start let that late render land after the delete, where it rebuilt
    // the removed queries and fetched them again.
    await until(() => host.querySelector('[data-loaded="true"]'), 'the page to finish loading');
    expect(reads).toEqual(['row', 'documents']);
    await click('Preview delete (dry run)');
    reads.length = 0;
    await click('Confirm delete #4');
    expect(navigations).toEqual([{ to: '/tracker' }]);
    expect(reads).toEqual([]);
    expect(qc.getQueryState(['tracker', 'row', '4'])).toBeUndefined();
  });
});

