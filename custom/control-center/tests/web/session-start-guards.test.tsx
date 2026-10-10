// Buttons that start a paid Claude session send one request per click: a double click must not start a second
// session (SW3-web-a-05, the same class as SW-web-a-10). Each request is held open so the second click lands mid-flight.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@web/components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => async () => undefined,
}));

let host: HTMLElement;
let root: Root;
let starts: number;

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  starts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/sessions') {
        starts++;
        return new Promise<Response>(() => undefined);
      }
      if (url.startsWith('/api/apply/documents')) return Promise.resolve(json({ pdfs: [], covers: [], suggestedPdf: null, suggestedCover: null }));
      if (url === '/api/sessions/engine') return Promise.resolve(json({ playwrightAvailable: false, modes: [] }));
      return Promise.resolve(json([]));
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
const render = (el: ReturnType<typeof createElement>) => act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, el))));

describe('one paid session per click', () => {
  it('the command palette mode launch', async () => {
    const { ModeLaunchDialog } = await import('@web/components/CommandPalette');
    await render(createElement(ModeLaunchDialog, { mode: 'research', onClose: () => undefined }));
    const prompt = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Session prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Research Acme');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Start (uses tokens)')!.click());
    await act(async () => button('Start (uses tokens)')!.click());
    expect(starts).toBe(1);
    expect(button('Start (uses tokens)')!.disabled).toBe(true);
  });

  it('Apply > Generate CV PDF', async () => {
    const { ApplyBody } = await import('@web/features/apply/ApplyPage');
    await render(createElement(ApplyBody, { n: '1', company: 'Acme', postingUrl: 'https://boards.greenhouse.io/acme/jobs/1' }));
    await until(() => button('Generate CV PDF'), 'the Generate CV PDF button');
    await act(async () => button('Generate CV PDF')!.click());
    await act(async () => button('Generate CV PDF')!.click());
    expect(starts).toBe(1);
    expect(button('Generate CV PDF')!.disabled).toBe(true);
  });
});
