// R18-shared-comp-L1-01: the palette's mode launch dialog cannot be closed while its paid start is in flight. A close
// mid-start let the late answer close a newly opened launch dialog, navigate away from the page the user moved to, or drop
// the start's error on an unmounted dialog.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigated = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async (to: unknown) => void navigated.push(to),
}));

let host: HTMLElement;
let root: Root;

let answerStart: ((r: Response) => void) | null;

beforeEach(() => {
  navigated.length = 0;
  answerStart = null;
  // cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView ??= () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/sessions') return new Promise<Response>((r) => (answerStart = r));
      if (url === '/api/modes') return Promise.resolve(new Response(JSON.stringify([{ id: 'deep', policyClass: 'read' }, { id: 'research', policyClass: 'read' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
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

const button = (name: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(name));

async function startInFlight(onClose: () => void) {
  const { ModeLaunchDialog } = await import('@web/components/CommandPalette');
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ModeLaunchDialog, { mode: 'deep', onClose }))));
  const prompt = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session prompt"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Research Acme');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Start (uses tokens)')!.click());
}

describe('palette mode launch while its start is in flight', () => {
  it('given a start in flight, when Cancel is clicked, then the dialog stays open', async () => {
    const onClose = vi.fn();
    await startInFlight(onClose);
    expect(button('Cancel')!.disabled).toBe(true);
    await act(async () => button('Cancel')!.click());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('given a start in flight, when Escape is pressed, then the dialog stays open', async () => {
    const onClose = vi.fn();
    await startInFlight(onClose);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('given a start in flight, when the palette launches another mode, then the late answer leaves the new dialog in place', async () => {
    const { until } = await import('../helpers/until');
    const { CommandPalette } = await import('@web/components/CommandPalette');
    const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
    await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ConfirmProvider, null, createElement(CommandPalette, { open: true, onOpenChange: () => undefined })))));
    const modeItem = (id: string) => until(() => [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')].find((i) => i.textContent?.startsWith(id)), `the ${id} mode item`);
    await act(async () => (await modeItem('deep')).click());
    const prompt = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Research Acme');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Start (uses tokens)')!.click());
    expect(answerStart).not.toBeNull();
    await act(async () => (await modeItem('research')).click());
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('Start a research session');
    await act(async () => answerStart!(new Response(JSON.stringify({ id: 's-deep', mode: 'deep', status: 'queued', target: { type: 'none', value: '' } }), { status: 202, headers: { 'content-type': 'application/json' } })));
    expect(document.body.querySelector('.dialog__title')?.textContent).toBe('Start a research session');
    expect(navigated).toEqual([]);
  });

  it('given a start in flight, when the user moves to another page, then the late answer does not navigate away from it', async () => {
    const onClose = vi.fn();
    window.history.pushState(null, '', '/today');
    await startInFlight(onClose);
    window.history.pushState(null, '', '/tracker');
    await act(async () => answerStart!(new Response(JSON.stringify({ id: 's-deep', mode: 'deep', status: 'queued', target: { type: 'none', value: '' } }), { status: 202, headers: { 'content-type': 'application/json' } })));
    expect(navigated).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('given a start in flight on the same page, when it answers, then it opens the session', async () => {
    window.history.pushState(null, '', '/today');
    await startInFlight(() => undefined);
    await act(async () => answerStart!(new Response(JSON.stringify({ id: 's-deep', mode: 'deep', status: 'queued', target: { type: 'none', value: '' } }), { status: 202, headers: { 'content-type': 'application/json' } })));
    expect(navigated).toEqual([{ to: '/sessions/$id', params: { id: 's-deep' } }]);
  });
});
