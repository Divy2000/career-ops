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
    vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/actions' ? [RUN_META] : url === '/api/runs' ? [] : plugins), { status: 200, headers: { 'content-type': 'application/json' } })),
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

describe('Enable on the Plugins tab after config/plugins.yml changed on disk', () => {
  it('given the file was edited outside the app, when a toggle gets a 409, then the config reloads and the retry carries the new ETag and succeeds', async () => {
    // The file's current ETag: the server refuses a PUT whose If-Match is any other.
    let etag = 'e1';
    const puts: Array<string | undefined> = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/actions') return json([RUN_META]);
        if (url === '/api/runs') return json([]);
        if (init?.method === 'PUT') {
          const ifMatch = new Headers(init.headers).get('If-Match') ?? undefined;
          puts.push(ifMatch);
          if (ifMatch !== etag) return json({ error: 'If-Match does not match the current version' }, 409);
          etag = 'e3';
          return json({ ok: true });
        }
        return json({ plugins: [{ ...plugin('notion', ['export']), enabled: false }], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag } });
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Enable notion"]');
    await until(() => box(), 'the Enable notion checkbox');
    etag = 'e2';
    await act(async () => box()!.click());
    await until(() => (puts.length === 1 && !box()!.disabled) || undefined, 'the first toggle settled');
    expect(host.textContent).toMatch(/config\/plugins\.yml changed on disk; the current settings were reloaded/);
    await act(async () => box()!.click());
    await until(() => (puts.length === 2 && !box()!.disabled) || undefined, 'the retry settled');
    expect(puts).toEqual(['e1', 'e2']);
  });
});

describe('Enable on the Plugins tab when the reload after a 409 fails', () => {
  it('given a toggle got a 409 and the config then cannot be read, then the page does not claim it was reloaded', async () => {
    let down = false;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/actions') return json([RUN_META]);
        if (url === '/api/runs') return json([]);
        if (init?.method === 'PUT') {
          down = true;
          return json({ error: 'If-Match does not match the current version' }, 409);
        }
        if (down) return json({ error: 'config/plugins.yml could not be read' }, 500);
        return json({ plugins: [{ ...plugin('notion', ['export']), enabled: false }], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: 'e1' } });
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    const box = await until(() => host.querySelector<HTMLInputElement>('input[aria-label="Enable notion"]'), 'the Enable notion checkbox');
    await act(async () => box.click());
    await until(() => host.textContent?.includes('Could not update notion') || undefined, 'the toggle error');
    expect(host.textContent).not.toMatch(/were reloaded/);
    expect(host.textContent).toMatch(/config\/plugins\.yml changed on disk and could not be reloaded/);
  });
});

describe('Audit plugins on the Plugins tab (R27-comp-plugins-01)', () => {
  it('given an audit in flight, then a second click starts no second audit and the button shows it is busy', async () => {
    const AUDIT_META = { id: 'plugins.audit', label: 'Audit plugins', cost: 'free', confirm: null, resources: [], claude: false, sync: true, params: {} };
    const plugins = { plugins: [plugin('notion', ['export'])], config: { kind: 'ok', path: 'config/plugins.yml', raw: '', etag: 'e' } };
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(url);
          return new Promise<Response>(() => undefined);
        }
        return new Response(JSON.stringify(url === '/api/actions' ? [RUN_META, AUDIT_META] : url === '/api/runs' ? [] : plugins), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(PluginsTab)))));
    const audit = await until(() => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Audit plugins')), 'the Audit plugins button');
    await act(async () => audit.click());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(audit.disabled).toBe(true);
    await act(async () => audit.click());
    expect(posts).toEqual(['/api/actions/plugins.audit']);
  });
});
