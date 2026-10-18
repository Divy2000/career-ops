// App-settings writes carry no ETag, so the server applies them in arrival order. Two changes made before the first
// answers must still persist the latest one, even when the network delivers them out of order (R32-feat-c-X-01).
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
let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  settings = { logos: false, retention: 200, claudeConcurrency: 1, modelDefault: '', usageBudgets: { fiveHourTokens: null, sevenDayTokens: null }, problem: null };
  pending = [];
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
        settings = { ...settings, ...patch };
        return json(200, settings);
      }
      if (url === '/api/usage') return json(200, {});
      return json(404, { error: 'not stubbed' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('app settings: changes made while an earlier write is on its way', () => {
  it('persist and show the latest choice even when the network delivers the writes newest first', async () => {
    const { EngineSettings } = await import('@web/features/settings/AppTab');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(EngineSettings))));
    const select = await until(() => document.querySelector<HTMLSelectElement>('#setting-concurrency'), 'the concurrency select');
    await choose(select, '2');
    await choose(document.querySelector<HTMLSelectElement>('#setting-concurrency')!, '3');
    await until(() => pending.length > 0, 'a write on its way');
    // Whatever is on its way reaches the server newest first, until nothing is left.
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
    expect(settings.claudeConcurrency).toBe(3);
    await until(() => document.querySelector<HTMLSelectElement>('#setting-concurrency')?.value === '3', 'the select showing the latest choice');
  });
});
