// R18-shared-comp-L1-01: the palette's mode launch dialog cannot be closed while its paid start is in flight. A close
// mid-start let the late answer close a newly opened launch dialog, navigate away from the page the user moved to, or drop
// the start's error on an unmounted dialog.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
}));

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/sessions') return new Promise<Response>(() => undefined);
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
});
