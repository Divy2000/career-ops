// Pipeline > Batch: URLs typed into the box while a fan-out runs must not be silently thrown away when it answers
// (R22-feat-b-L1-01). The box is locked for the run, so what the answer leaves in it is all the user has typed.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let release: ((r: Response) => void) | null;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const meta = (id: string, url: string, status: string, reportNum: number | null) => ({ id, mode: 'oferta', status, target: { type: 'url', value: url }, reportNum, error: status === 'error' ? 'spawn failed' : null });

beforeEach(async () => {
  release = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/sessions/fanout' && init?.method === 'POST') return new Promise<Response>((r) => (release = r));
      if (url === '/api/sessions') return json(200, []);
      return json(200, []);
    }),
  );
  const { BatchTab } = await import('@web/features/pipeline/BatchTab');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(BatchTab, {})))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name));
const textarea = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Batch URLs"]')!;
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Pipeline > Batch while a fan-out runs (R22-feat-b-L1-01)', () => {
  it('given a running fan-out, the URL box cannot be edited, so the answer cannot overwrite URLs typed meanwhile', async () => {
    await type(textarea(), 'https://jobs.example.com/a\nhttps://jobs.example.com/b');
    await until(() => button('Batch evaluate') && !button('Batch evaluate')!.disabled, 'Batch evaluate enabled');
    await act(async () => button('Batch evaluate')!.click());
    await act(async () => button('Start them')!.click());
    await until(() => release, 'the fan-out request');
    expect(textarea().disabled).toBe(true);
    await act(async () => release!(json(202, { sessions: [meta('s1', 'https://jobs.example.com/a', 'queued', 12), meta('s2', 'https://jobs.example.com/b', 'error', null)], reserved: [12, 13] })));
    await until(() => (textarea().disabled ? null : true), 'the box unlocked');
    expect(textarea().value).toBe('https://jobs.example.com/b');
  });
});
