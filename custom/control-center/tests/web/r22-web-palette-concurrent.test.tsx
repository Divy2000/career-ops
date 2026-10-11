// R22-shared-comp-L3-01: a palette action that finishes while another action's params dialog is open must not close that
// dialog (and lose what was typed) or show its own failure as that dialog's error.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import type { ActionMeta } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
}));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SLOW: ActionMeta = { id: 'portals.verify', label: 'Verify portals', cost: 'free', confirm: null, resources: [], claude: false, sync: true, params: { type: 'object', properties: {} } };
const WITH_PARAMS: ActionMeta = {
  id: 'tracker.status', label: 'Set status', cost: 'free', confirm: null, resources: [], claude: false, sync: true,
  params: { type: 'object', properties: { n: { type: 'integer' }, state: { type: 'string' } }, required: ['n', 'state'] },
};

let host: HTMLElement;
let root: Root;
let answerSlow: ((r: Response) => void) | null;

beforeEach(() => {
  answerSlow = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions') return json(200, [SLOW, WITH_PARAMS]);
      if (url === `/api/actions/${SLOW.id}` && init?.method === 'POST') return new Promise<Response>((r) => (answerSlow = r));
      return json(200, []);
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

const item = (label: string) => until(() => [...document.body.querySelectorAll('[cmdk-item]')].find((i) => i.textContent?.includes(label)) as HTMLElement | undefined, label);
const nInput = () => document.body.querySelector<HTMLInputElement>('input[aria-label="n"]');

async function slowRunThenOpenParamsDialog() {
  const { CommandPalette } = await import('@web/components/CommandPalette');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(CommandPalette, { open: true, onOpenChange: () => undefined })))),
  );
  const slow = await item('Verify portals');
  await act(async () => slow.click());
  await until(() => answerSlow, 'the slow run in flight');
  const other = await item('Set status');
  await act(async () => other.click());
  const n = await until(nInput, 'the params dialog');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(n, '42');
    n.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('a palette action finishing while another action has its params dialog open', () => {
  it('given the first action succeeds, then the params dialog stays open with what was typed', async () => {
    await slowRunThenOpenParamsDialog();
    await act(async () => answerSlow!(json(200, { result: 'all portals answer' })));
    await until(() => document.body.textContent?.includes('Verify portals: output'), 'the first action output');
    expect(nInput()?.value).toBe('42');
  });

  it('given the first action fails, then its error is not shown as the params dialog error', async () => {
    await slowRunThenOpenParamsDialog();
    await act(async () => answerSlow!(json(500, { error: 'portals boom' })));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(nInput()?.value).toBe('42');
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('portals boom');
  });
});
