// Command palette failure paths: a refused action keeps the params the user typed, and a mode start whose session
// failed before its turn ran says so instead of reporting a start (R13-shared-comp-L3-03, R13-shared-comp-05).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import type { ActionMeta, SessionMeta } from '@shared/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigated: unknown[] = [];
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigated.push(to),
}));

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ACTION: ActionMeta = {
  id: 'tracker.status', label: 'Set status', cost: 'free', confirm: null, resources: [], claude: false, sync: true,
  params: { type: 'object', properties: { n: { type: 'integer' }, state: { type: 'string' } }, required: ['n', 'state'] },
};
const FAILED: SessionMeta = {
  id: 's-failed', claudeSessionId: '11111111-1111-4111-8111-111111111111', mode: 'research', policyClass: 'analysis', target: { type: 'none', value: null }, model: null,
  status: 'error', createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null,
  error: 'no token in the Keychain', reportNum: null, lastReason: null, policyVersion: 2,
};

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  navigated.length = 0;
  // cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name));
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const render = (el: ReturnType<typeof createElement>) => act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, el)));

describe('the palette params dialog', () => {
  it('stays open with the typed params and the refusal when the run fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/actions') return json(200, [ACTION]);
        if (url === `/api/actions/${ACTION.id}` && init?.method === 'POST') return json(400, { error: 'no tracker row #99' });
        return json(200, []);
      }),
    );
    const { CommandPalette } = await import('@web/components/CommandPalette');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    await render(createElement(ConfirmProvider, null, createElement(CommandPalette, { open: true, onOpenChange: () => undefined })));
    const item = await until(() => [...document.body.querySelectorAll('[cmdk-item]')].find((i) => i.textContent?.includes('Set status')) as HTMLElement | undefined, 'the action item');
    await act(async () => item.click());
    const n = await until(() => document.body.querySelector<HTMLInputElement>('input[aria-label="n"]'), 'the params dialog');
    await type(n, '99');
    await type(document.body.querySelector<HTMLInputElement>('input[aria-label="state"]')!, 'Applied');
    await act(async () => button('Run')!.click());
    await until(() => document.body.querySelector('[role="alert"]')?.textContent?.includes('no tracker row #99'), 'the refusal in the dialog');
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="n"]')?.value).toBe('99');
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="state"]')?.value).toBe('Applied');
  });
});

describe('the palette mode launch', () => {
  it('keeps the dialog and says why when the started session failed before its turn ran', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (url === '/api/sessions' && init?.method === 'POST' ? json(202, FAILED) : json(200, []))));
    let closed = 0;
    const { ModeLaunchDialog } = await import('@web/components/CommandPalette');
    await render(createElement(ModeLaunchDialog, { mode: 'research', onClose: () => void closed++ }));
    await type(document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session prompt"]')!, 'Research Acme');
    await act(async () => button('Start (uses tokens)')!.click());
    await until(() => document.body.querySelector('[role="alert"]')?.textContent?.includes('no token in the Keychain'), 'the start failure');
    expect(closed).toBe(0);
    expect(navigated).toEqual([]);
    expect(button('Start (uses tokens)')!.disabled).toBe(false);
  });
});
