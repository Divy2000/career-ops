// Runs & Schedule quick-run buttons: a double click before the first start answers starts one run (R13-feat-b-r-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let starts: number;
let release: Array<() => void>;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  starts = 0;
  release = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions') return json([{ id: 'tracker.verify', label: 'Verify tracker', cost: 'free', confirm: null, resources: [], claude: false, sync: false, params: {} }]);
      if (url === '/api/actions/tracker.verify' && init?.method === 'POST') {
        starts += 1;
        await new Promise<void>((r) => release.push(r));
        return json({ runId: `r${starts}` });
      }
      if (url === '/api/runs') return json([]);
      return new Response(JSON.stringify({ error: 'not stubbed' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { RunsPage } = await import('@web/features/runs/RunsPage');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RunsPage))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('quick-run buttons', () => {
  it('a second click while the start is in flight starts nothing more', async () => {
    const run = await until(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith('Run Verify tracker')), 'the quick-run button');
    await act(async () => run.click());
    await until(() => starts === 1 || undefined, 'the first start');
    expect(run.disabled).toBe(true);
    await act(async () => run.click());
    await act(async () => release.forEach((r) => r()));
    await until(() => !run.disabled, 'the button back');
    expect(starts).toBe(1);
  });
});
