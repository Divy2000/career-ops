// Settings > Plugins > Run: a double click on a plugin hook's Run button sends one plugins.run request, so a concurrent
// second export does not duplicate pages (R17-feat-c-L3-02, the in-flight half), and Run stays off while the run it
// started is still live (R18-feat-c-L3-02).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let posts: string[];
let hold: boolean;
/** The runs list the server answers: the runs from here that have not ended show up as queued or running. */
let runs: Array<{ id: string; actionId: string; status: string; params: Record<string, unknown> }>;

const plugin = (id: string, hooks: string[]) => ({ id, name: id, description: '', version: '1.0.0', hooks, requiredEnv: [], optionalEnv: [], humanInTheLoop: false, hasSkill: false, source: 'bundled', enabled: true, configured: true });
const RUN_META = { id: 'plugins.run', label: 'Run plugin hook', cost: 'network', confirm: null, resources: [], claude: false, sync: false, params: {} };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  posts = [];
  hold = false;
  runs = [];
  const plugins = { plugins: [plugin('notion', ['export'])], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: 'e' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        if (hold) await new Promise<Response>(() => undefined);
        runs = [{ id: 'r1', actionId: 'plugins.run', status: 'running', params: { id: 'notion', hook: 'export', args: [] } }];
        return json(202, { runId: 'r1' });
      }
      if (url === '/api/actions') return json(200, [RUN_META]);
      if (url === '/api/runs') return json(200, runs);
      return json(200, plugins);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name));

describe('Run on the Plugins tab', () => {
  it('a double click while the export is in flight sends one plugins.run request', async () => {
    const { PluginsTab } = await import('@web/features/settings/PluginsTab');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    const runButton = await until(() => button('Run export'), 'the Run export button');

    hold = true;
    await act(async () => runButton!.click());
    await act(async () => runButton!.click());
    expect(posts).toEqual(['/api/actions/plugins.run']);
    expect(runButton!.disabled).toBe(true);
  });

  it('Run stays off while the run it started is live, and comes back once the run ends', async () => {
    const { PluginsTab } = await import('@web/features/settings/PluginsTab');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    const runButton = await until(() => button('Run export'), 'the Run export button');
    await until(() => !runButton!.disabled, 'Run enabled');
    await act(async () => runButton!.click());
    await until(() => /Started run r1/.test(document.body.textContent ?? ''), 'the started note');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(button('Run export')!.disabled).toBe(true);
    await act(async () => runButton!.click());
    expect(posts).toEqual(['/api/actions/plugins.run']);
    runs = [{ ...runs[0]!, status: 'done' }];
    await act(async () => qc.invalidateQueries({ queryKey: ['runs'] }));
    await until(() => !button('Run export')!.disabled, 'Run back once the run ended');
  });

  it('Run is off on load while a run of a plugin hook from here is queued or running', async () => {
    runs = [{ id: 'r0', actionId: 'plugins.run', status: 'queued', params: { id: 'notion', hook: 'export', args: [] } }];
    const { PluginsTab } = await import('@web/features/settings/PluginsTab');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    await until(() => button('Run export'), 'the Run export button');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(button('Run export')!.disabled).toBe(true);
  });
});
