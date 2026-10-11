// R22-shared-comp-L3-01: a palette action that finishes while another action's params dialog is open must not close that
// dialog (and lose what was typed) or show its own failure as that dialog's error.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { toast } from 'sonner';
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
let answerParams: ((r: Response) => void) | null;

beforeEach(() => {
  answerSlow = null;
  answerParams = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions') return json(200, [SLOW, WITH_PARAMS]);
      if (url === `/api/actions/${SLOW.id}` && init?.method === 'POST') return new Promise<Response>((r) => (answerSlow = r));
      if (url === `/api/actions/${WITH_PARAMS.id}` && init?.method === 'POST') return new Promise<Response>((r) => (answerParams = r));
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
  vi.restoreAllMocks();
});

const item = (label: string) => until(() => [...document.body.querySelectorAll('[cmdk-item]')].find((i) => i.textContent?.includes(label)) as HTMLElement | undefined, label);
const nInput = () => document.body.querySelector<HTMLInputElement>('input[aria-label="n"]');

const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name));
const type = async (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

async function renderPalette() {
  const { CommandPalette } = await import('@web/components/CommandPalette');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, createElement(CommandPalette, { open: true, onOpenChange: () => undefined })))),
  );
}

async function openParamsDialogAndType(value: string) {
  await act(async () => (await item('Set status')).click());
  await type(await until(nInput, 'the params dialog'), value);
}

async function slowRunThenOpenParamsDialog() {
  await renderPalette();
  const slow = await item('Verify portals');
  await act(async () => slow.click());
  await until(() => answerSlow, 'the slow run in flight');
  await openParamsDialogAndType('42');
}

/** A Set status run from its dialog left in flight, the dialog closed, then the same action's dialog opened afresh. */
async function staleRunThenReopenedDialog() {
  await renderPalette();
  await openParamsDialogAndType('7');
  await type(document.body.querySelector<HTMLInputElement>('input[aria-label="state"]')!, 'Applied');
  await act(async () => button('Run')!.click());
  await until(() => answerParams, 'the first Set status run in flight');
  await act(async () => button('Cancel')!.click());
  expect(nInput()).toBeNull();
  await openParamsDialogAndType('42');
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
    const errors = vi.spyOn(toast, 'error');
    await act(async () => answerSlow!(json(500, { error: 'portals boom' })));
    await until(() => errors.mock.calls.some(([m]) => String(m).includes('portals boom')), 'the first action to fail');
    expect(nInput()?.value).toBe('42');
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('portals boom');
  });
});

describe('an earlier run of the same action finishing after its params dialog was closed and reopened', () => {
  it('given the earlier run succeeds, then the reopened dialog stays open with what was typed', async () => {
    await staleRunThenReopenedDialog();
    const ok = vi.spyOn(toast, 'success');
    await act(async () => answerParams!(json(200, { result: 'row 7 set to Applied' })));
    await until(() => ok.mock.calls.length > 0, 'the earlier run to finish');
    expect(nInput()?.value).toBe('42');
  });

  it('given the earlier run fails, then its error is not shown on the reopened dialog', async () => {
    await staleRunThenReopenedDialog();
    const errors = vi.spyOn(toast, 'error');
    await act(async () => answerParams!(json(400, { error: 'no tracker row #7' })));
    await until(() => errors.mock.calls.some(([m]) => String(m).includes('no tracker row #7')), 'the earlier run to fail');
    expect(nInput()?.value).toBe('42');
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('no tracker row #7');
  });
});
