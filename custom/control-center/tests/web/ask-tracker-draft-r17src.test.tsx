// Ask about tracker: a question typed but not sent survives closing the panel or leaving the Tracker, and is cleared
// once it is sent (R16-merge-04).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';
import { ConfirmProvider } from '@web/components/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: (props: { children?: unknown }) => createElement('a', null, props.children as string),
}));

class FakeEventSource {
  constructor(public url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let host: HTMLElement;
let root: Root;
let starts: Array<{ prompt: string }>;

beforeEach(() => {
  sessionStorage.clear();
  starts = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/sessions' && init?.method === 'POST') {
        starts.push(JSON.parse(String(init.body)));
        return json(202, { id: 'ask-1', mode: 'tracker', status: 'queued' });
      }
      if (url === '/api/sessions/ask-1') return json(200, { id: 'ask-1', mode: 'tracker', status: 'queued' });
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

async function mount() {
  const { AskTrackerPanel } = await import('@web/features/tracker/AskTrackerPanel');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(AskTrackerPanel)))));
}
const toggle = () => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Ask about tracker'))!.click());
const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt for tracker"]');
async function type(text: string) {
  const el = box()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Ask about tracker: the unsent question', () => {
  it('is still there after the panel is closed and opened again', async () => {
    await mount();
    await toggle();
    await type('Which applications went cold?');
    await toggle();
    expect(box()).toBeNull();
    await toggle();
    expect(box()!.value).toBe('Which applications went cold?');
  });

  it('is still there after leaving the Tracker and coming back', async () => {
    await mount();
    await toggle();
    await type('What should I follow up on?');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    await toggle();
    expect(box()!.value).toBe('What should I follow up on?');
  });

  it('is cleared once it is sent', async () => {
    await mount();
    await toggle();
    await type('Which applications went cold?');
    await act(async () => box()!.form!.requestSubmit());
    await until(() => starts.length > 0, 'the start');
    expect(starts[0]!.prompt).toBe('Which applications went cold?');
    await act(async () => root.unmount());
    sessionStorage.removeItem('cc.tracker.ask');
    root = createRoot(host);
    await mount();
    await toggle();
    expect(box()!.value).toBe('');
  });
});
