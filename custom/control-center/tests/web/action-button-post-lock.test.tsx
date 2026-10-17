// An action button whose caller has no `disabled` prop of its own (Settings > Updates, Plugins > audit) stays locked
// while its POST is unanswered, however long the server takes, so a second click cannot send a second request; once
// the POST is answered, a runs refetch that stalls does not keep it locked (R27-comp-rev-02).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunAction } from '@web/lib/actions';
import { ActionButton } from '@web/components/ActionBar';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import type { ActionMeta } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta: ActionMeta = { id: 'plugins.audit', label: 'Audit plugins', cost: 'free', confirm: null, resources: [], claude: false, sync: true, params: {} };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The Plugins tab's composition: a runs list on the page, and a button whose onRun returns run's promise. */
function Page() {
  const { run } = useRunAction();
  useQuery({ queryKey: ['runs'], queryFn: () => fetch('/api/runs').then((r) => r.json()) });
  return createElement(ActionButton, { meta, onRun: () => run('plugins.audit', {}) });
}

let host: HTMLElement;
let root: Root;
let posts: Array<(r: Response) => void>;
let runsFetches: number;
let stallRuns: boolean;
beforeEach(async () => {
  posts = [];
  runsFetches = 0;
  stallRuns = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/api/actions/')) return new Promise<Response>((resolve) => posts.push(resolve));
      runsFetches += 1;
      return stallRuns ? new Promise<Response>(() => undefined) : Promise.resolve(json([]));
    }),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(Page)))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const button = () => host.querySelector('button')!;
const press = async () => {
  await act(async () => button().click());
  await settle();
};

describe('ActionButton running a registry action through useRunAction (R27-comp-rev-02)', () => {
  it('given the POST is still unanswered after the 35 s lock limit, then the button stays locked and a second click sends nothing', async () => {
    await press();
    expect(posts).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    await settle();
    expect(button().disabled).toBe(true);
    await press();
    expect(posts).toHaveLength(1);
    await act(async () => posts[0]!(json({ result: 'ok' })));
    await settle();
    expect(button().disabled).toBe(false);
    await press();
    expect(posts).toHaveLength(2);
  });

  it('given the POST was answered but the runs refetch stalls, then the button unlocks soon after the answer', async () => {
    await settle();
    stallRuns = true;
    await press();
    await act(async () => posts[0]!(json({ result: 'ok' })));
    await settle();
    expect(runsFetches).toBeGreaterThan(1);
    await act(async () => vi.advanceTimersByTime(10_000));
    await settle();
    expect(button().disabled).toBe(false);
  });
});
