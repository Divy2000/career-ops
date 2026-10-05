// Application > Documents > Danger zone: a tracker row is deleted in two steps. The real delete is offered only after a
// dry run has shown what it would do, and a failed delete stays on the page with the reason (SW-tests-15).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigations = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigations.push(to),
}));

let host: HTMLElement;
let root: Root;
let posts: Array<{ n: number; dryRun: boolean }>;
let realDelete: () => Response;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  navigations.length = 0;
  posts = [];
  realDelete = () => json(200, { result: { deleted: 4 } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/actions/tracker.delete' || init?.method !== 'POST') return json(404, { error: 'not stubbed' });
      const { params } = JSON.parse(String(init.body)) as { params: { n: number; dryRun: boolean } };
      posts.push(params);
      return params.dryRun ? json(200, { result: 'Would delete row #4 (Initech Cloud) and renumber 5 to 6', stderr: '' }) : realDelete();
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
    expect(host.querySelector('[aria-label="Delete preview"]')!.textContent).toBe('Would delete row #4 (Initech Cloud) and renumber 5 to 6');
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
    expect(navigations).toEqual([{ to: '/tracker' }]);
  });

  it('a failed delete stays on the page and says why', async () => {
    realDelete = () => json(409, { error: 'tracker is locked by another writer' });
    await click('Preview delete (dry run)');
    await click('Confirm delete #4');
    expect(navigations).toEqual([]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('tracker is locked by another writer');
  });
});
