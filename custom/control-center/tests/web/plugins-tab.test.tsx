// Settings > Plugins (R8-12): plugins.mjs run refuses a plugin whose only hook is `provider` (provider hooks ride the
// portal scan), so the tab offers Run only for the hooks the CLI runs, and says how a provider plugin runs instead.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { until } from '../helpers/until';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginsTab } from '@web/features/settings/PluginsTab';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const plugin = (id: string, hooks: string[]) => ({ id, name: id, description: '', version: '1.0.0', hooks, requiredEnv: [], optionalEnv: [], humanInTheLoop: false, hasSkill: false, source: 'bundled', enabled: true, configured: true });
const RUN_META = { id: 'plugins.run', label: 'Run plugin hook', cost: 'network', confirm: null, resources: [], claude: false, sync: false, params: {} };

async function mount() {
  const plugins = { plugins: [plugin('apify', ['provider']), plugin('notion', ['provider', 'export', 'search'])], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: 'e' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/actions' ? [RUN_META] : plugins), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
  // Both rows rendered, and the actions list loaded (notion's Run button needs it).
  await until(() => host.querySelectorAll('tbody tr').length === 2 && [...host.querySelectorAll('button')].some((b) => b.textContent?.trim().startsWith('Run ')), 'the plugin rows and their Run buttons');
}

const rowOf = (id: string) => [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(id))!;
const buttons = (el: Element) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

describe('Run on the Plugins tab', () => {
  it('plugins.mjs run refuses a provider-only plugin (the bundled apify)', () => {
    const r = spawnSync(process.execPath, [path.join(CODE_ROOT, 'plugins.mjs'), 'run', 'apify'], { cwd: CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'root'), NO_COLOR: '1' }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only exposes a provider hook/);
  });

  it('offers no Run button for a provider-only plugin and says it runs during the portal scan', async () => {
    await mount();
    const apify = rowOf('apify');
    expect(buttons(apify).some((b) => b.startsWith('Run'))).toBe(false);
    expect(apify.textContent).toMatch(/Runs during the portal scan/);
  });

  it('runs the first hook the CLI runs, skipping provider', async () => {
    await mount();
    expect(buttons(rowOf('notion')).some((b) => b.startsWith('Run export'))).toBe(true);
    expect(buttons(rowOf('notion')).some((b) => b.startsWith('Run provider'))).toBe(false);
  });
});
