// Settings > Blacklist: the write confirm reports added and removed companies separately, not a net count, so a swap
// (remove one, add another) does not read as "0 added" (R17-feat-c-L3-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const row = (company: string) => ({ company, since: '2026-01-01', scope: 'company' as const, reason: '' });

beforeEach(() => {
  const read = { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [row('Initech'), row('Globex')], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return json(200, read);
      return json(200, { ok: true, etag: 'b2' });
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

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('the blacklist write confirm', () => {
  it('reports a removed and an added company as one added, one removed, not a net 0 added', async () => {
    const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(BlacklistEditor, {})))));
    await until(() => document.body.textContent?.includes('Initech'), 'the rows');

    // Swap: remove Initech, add Umbrella. Net count is unchanged.
    await act(async () => button('Remove Initech from the blacklist draft')!.click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="Blacklist company or domain"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Umbrella');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Add row')!.click());
    await act(async () => button('Save blacklist')!.click());
    await until(() => dialog(), 'the confirm dialog');

    expect(dialog()!.textContent).toContain('1 added');
    expect(dialog()!.textContent).toContain('1 removed');
    expect(dialog()!.textContent).not.toContain('0 added');
  });
});
