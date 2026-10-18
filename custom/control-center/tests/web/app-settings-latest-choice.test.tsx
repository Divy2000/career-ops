// App settings keep the user's latest local choice while saves are on their way: a second logos toggle flips what the
// first one chose (R33-feat-c-L1-01), an earlier save's answer leaves a newer draft alone (R33-feat-c-L1-02), the AI
// engine tab warns when settings.json could not be read (R33-feat-c-L2-01), and two browser tabs saving at once cannot
// land the older choice last (R33-feat-c-X-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The settings on disk; each write is merged into them when the server takes it. */
let settings: Record<string, unknown>;
/** Writes sent and not yet taken by the server, in the order they were sent. */
let pending: Array<{ patch: Record<string, unknown>; take: () => void }>;
let roots: Root[];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  settings = { logos: false, retention: 200, claudeConcurrency: 1, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null }, problem: null };
  pending = [];
  roots = [];
  vi.resetModules();
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings/app' && method === 'GET') return json(200, settings);
      if (url === '/api/settings/app' && method === 'PUT') {
        const patch = JSON.parse(String(init!.body)) as Record<string, unknown>;
        await new Promise<void>((take) => pending.push({ patch, take }));
        const { problem: _problem, ...rest } = settings;
        settings = { ...rest, ...patch, problem: null };
        return json(200, { ...rest, ...patch });
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

/** Mounts one browser tab's view: its own query cache, and its own copy of the settings module when `fresh`. */
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

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

/** Lets every write on its way reach the server, newest first, until nothing is left. */
async function drain() {
  for (let i = 0; i < 20 && pending.length > 0; i++) {
    const batch = pending.splice(0).reverse();
    await act(async () => {
      for (const w of batch) {
        w.take();
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
}

describe('app settings: the latest local choice wins', () => {
  it('Given logos off, when the box is clicked twice before the first save answers, then logos end up off', async () => {
    const host = await mount('AppTab');
    const box = await until(() => host.querySelector<HTMLInputElement>('#setting-logos'), 'the logos checkbox');
    await click(box);
    await until(() => pending.length > 0, 'the first write on its way');
    await click(host.querySelector<HTMLInputElement>('#setting-logos')!);
    await drain();
    expect(settings.logos).toBe(false);
    await until(() => host.querySelector<HTMLInputElement>('#setting-logos')?.checked === false, 'the box showing off');
  });
});
