// Buttons that start a run send one request per click: a double click must not start a second run (SW4-web-a-01).
// Rank (50) is paid and its second run would rank the next 50 postings; the scans hit the network twice. Each POST is
// held open so the second click lands while the first is in flight.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelinePage } from '@web/features/pipeline/PipelinePage';
import { NetworkScan, ScriptTab } from '@web/features/discover/DiscoverPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta = (id: string, label: string, cost: string) => ({ id, label, cost, confirm: null, resources: [], claude: cost === 'tokens', sync: false, params: { type: 'object', properties: {} } });
const ACTIONS = [meta('pipeline.prioritize', 'Prioritize pipeline', 'free'), meta('pipeline.shortlist', 'Rebuild shortlist', 'free'), meta('pipeline.rank', 'Rank pipeline', 'tokens'), meta('scan.portals', 'Scan portals', 'network'), meta('scan.network', 'Network scan', 'network')];

let host: HTMLElement;
let root: Root;
let posts: string[];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  posts = [];
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return new Promise<Response>(() => undefined);
      }
      if (url === '/api/actions') return Promise.resolve(json(ACTIONS));
      if (url === '/api/pipeline') return Promise.resolve(json({ kind: 'ok', path: 'data/pipeline.md', rows: [], etag: 'e' }));
      return Promise.resolve(json([]));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: RegExp) => [...host.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
const render = (el: ReturnType<typeof createElement>) => act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, el))));

async function doubleClick(name: RegExp) {
  const b = await until(() => { const found = button(name); return found && !found.disabled ? found : null; }, `${String(name)} to be ready`);
  await act(async () => b.click());
  await act(async () => button(name)!.click());
}

describe('one run per click', () => {
  it('Pipeline > Inbox > Rank (50)', async () => {
    const rootRoute = createRootRoute();
    const pipeline = createRoute({ getParentRoute: () => rootRoute, path: '/pipeline', component: PipelinePage, validateSearch: () => ({ tab: 'inbox' as const }) });
    const router = createRouter({ routeTree: rootRoute.addChildren([pipeline]), history: createMemoryHistory({ initialEntries: ['/pipeline'] }) });
    await render(createElement(RouterProvider, { router }));
    await doubleClick(/^Rank \(50\)/);
    expect(posts).toEqual(['/api/actions/pipeline.rank']);
    expect(button(/^Rank \(50\)/)!.disabled).toBe(true);
  });

  it('Discover > Portal scan (the script tabs)', async () => {
    await render(createElement(ScriptTab, { id: 'scan.portals', intro: 'Scans every enabled portal.', params: {} }));
    await doubleClick(/^Scan portals/);
    expect(posts).toEqual(['/api/actions/scan.portals']);
  });

  it('Discover > Run network scan', async () => {
    await render(createElement(NetworkScan));
    await doubleClick(/^Run network scan/);
    expect(posts).toEqual(['/api/actions/scan.network']);
    expect(button(/^Run network scan/)!.disabled).toBe(true);
  });
});
