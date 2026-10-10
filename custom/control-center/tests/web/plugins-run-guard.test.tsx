// Settings > Plugins > Run: a double click on a plugin hook's Run button sends one plugins.run request, so a concurrent
// second export does not duplicate pages (R17-feat-c-L3-02, the in-flight half).
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

const plugin = (id: string, hooks: string[]) => ({ id, name: id, description: '', version: '1.0.0', hooks, requiredEnv: [], optionalEnv: [], humanInTheLoop: false, hasSkill: false, source: 'bundled', enabled: true, configured: true });
const RUN_META = { id: 'plugins.run', label: 'Run plugin hook', cost: 'network', confirm: null, resources: [], claude: false, sync: false, params: {} };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  posts = [];
  hold = false;
  const plugins = { plugins: [plugin('notion', ['export'])], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: 'e' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        if (hold) await new Promise<Response>(() => undefined);
        return json(200, { result: 'ok' });
      }
      if (url === '/api/actions') return json(200, [RUN_META]);
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
});
