// The server refuses an app-settings write over a settings.json it could not read (R33-feat-c-L2-01) and one based on
// a read another device has since changed (R33-feat-c-X-01). The settings tabs say so, keep the user's draft, and only
// replace an unreadable file when the user asks for it.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The server's settings, the version it reports, and whether settings.json could be read. */
let settings: Record<string, unknown>;
let version: number;
let problem: string | null;
let puts: Array<{ url: string; ifMatch: string | null; patch: Record<string, unknown> }>;
let roots: Root[];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const read = () => ({ ...settings, problem, etag: `v${version}` });

beforeEach(() => {
  settings = { logos: false, retention: 200, claudeConcurrency: 1, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null } };
  version = 1;
  problem = null;
  puts = [];
  roots = [];
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings/app' && method === 'GET') return json(200, read());
      if (url.startsWith('/api/settings/app') && method === 'PUT') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1] ?? null;
        const patch = JSON.parse(String(init!.body)) as Record<string, unknown>;
        puts.push({ url, ifMatch, patch });
        if (problem && !url.endsWith('?reset=1')) return json(409, { code: 'settings-problem', problem, error: `data/control-center/settings.json could not be read (${problem}), so saving would replace it with defaults.` });
        if (ifMatch !== null && ifMatch !== `v${version}`) return json(409, { code: 'settings-changed', error: 'settings.json changed since you loaded it', current: read() });
        settings = { ...settings, ...patch };
        problem = null;
        version += 1;
        return json(200, { ...settings, etag: `v${version}` });
      }
      if (url === '/api/usage') return json(200, {});
      return json(404, { error: 'not stubbed' });
    }),
  );
});
afterEach(async () => {
  for (const r of roots) await act(async () => r.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  delete (navigator as { locks?: unknown }).locks;
});

async function mount(which: 'AppTab' | 'EngineSettings', fresh = false) {
  if (fresh) vi.resetModules();
  const mod = await import('@web/features/settings/AppTab');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(mod[which]))));
  return host;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const alerts = (host: HTMLElement) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').join('\n');

describe('app settings: a write the server refuses', () => {
  it('Given settings.json could not be read, when the model is saved, then the refusal is shown, the draft kept and nothing written', async () => {
    problem = 'settings.json is not valid JSON: Unexpected end';
    const host = await mount('EngineSettings');
    await type(await until(() => host.querySelector<HTMLInputElement>('#setting-model'), 'the model field'), 'opus');
    await act(async () => button(host, 'Save')!.click());
    await until(() => /could not be read/.test(alerts(host)) && button(host, 'Replace settings.json'), 'the refusal and the replace button');
    expect(settings.modelDefault).toBe('');
    expect(host.querySelector<HTMLInputElement>('#setting-model')!.value).toBe('opus');
  });

  it('Given the refusal is shown, when the user asks to replace settings.json, then the same patch is sent with the reset opt-in', async () => {
    problem = 'settings.json is not valid JSON: Unexpected end';
    const host = await mount('EngineSettings');
    await type(await until(() => host.querySelector<HTMLInputElement>('#setting-model'), 'the model field'), 'opus');
    await act(async () => button(host, 'Save')!.click());
    const replace = await until(() => button(host, 'Replace settings.json'), 'the replace button');
    await act(async () => replace.click());
    await until(() => settings.modelDefault === 'opus', 'the reset write');
    expect(puts.at(-1)).toMatchObject({ url: '/api/settings/app?reset=1', patch: { modelDefault: 'opus' } });
    await until(() => !alerts(host), 'the alerts cleared');
  });
});
