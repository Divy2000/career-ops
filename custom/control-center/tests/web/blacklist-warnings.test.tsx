// Settings > Blacklist shows what GET /api/blacklist says about the file before anything is written: a legacy header
// the scanner reads by position (columnWarning: saving rewrites it), and cells the editor has no column for (unkept:
// the server refuses the save with 422) (R13-feat-c-06, SEED-web-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let read: Record<string, unknown>;
let writes: number;
const COLUMN_WARNING = 'The table\'s header is "Company | Reason | Since", but the scanner reads every row by position as Company, Since, Scope, Reason. The rows are shown as it reads them; saving rewrites the header in that order.';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  writes = 0;
  read = { kind: 'ok', path: 'data/blacklist.md', raw: '', etag: 'b1', rows: [{ company: 'Initech', since: '2026-01-01', scope: 'company', reason: '' }], preamble: null, postamble: '', extraColumns: [], columnWarning: null, unkept: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return json(200, read);
      writes += 1;
      return json(200, { ok: true, etag: 'b2' });
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

async function mount() {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const { BlacklistEditor } = await import('@web/features/settings/BlacklistEditor');
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(BlacklistEditor, {})))));
  await until(() => document.body.textContent?.includes('Initech'), 'the rows');
}
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
async function addRow(company: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Blacklist company or domain"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, company);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Add row')!.click());
}

describe('blacklist file warnings', () => {
  it('a header the scanner reads by position is shown on the page and in the confirm dialog', async () => {
    read = { ...read, columnWarning: COLUMN_WARNING };
    await mount();
    expect(document.body.textContent).toContain(COLUMN_WARNING);
    await addRow('Globex');
    await act(async () => button('Save blacklist')!.click());
    const dialog = await until(() => document.querySelector('[role="dialog"]'), 'the confirm dialog');
    expect(dialog.textContent).toContain(COLUMN_WARNING);
  });

  it('cells the editor has no column for are listed, and Save is off because the server would refuse it', async () => {
    read = { ...read, unkept: ['Initech (old note)'] };
    await mount();
    const alert = [...document.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes('Initech (old note)'));
    expect(alert?.textContent).toMatch(/no column for/);
    await addRow('Globex');
    expect(button('Save blacklist')!.disabled).toBe(true);
    expect(writes).toBe(0);
  });

  it('a file without either shows neither', async () => {
    await mount();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    await addRow('Globex');
    expect(button('Save blacklist')!.disabled).toBe(false);
  });
});
