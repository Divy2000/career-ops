import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let qc: QueryClient;
let started: number;
// The fan-out answer is held until release() so the tab can be left and shown again while it runs.
let release: ((body: unknown) => void) | null;
// While set, the next sessions read is held until answerSessions() so the tab can be left before it answers.
let holdSessions: boolean;
let answerSessions: ((res: Response) => void) | null;
// Sessions reads made after the fan-out answered: the start re-reads the list once it is done with the answer.
let readsAfterFanOut: number;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const session = (id: string, url: string, status: 'queued' | 'error', reportNum: number | null) => ({ id, status, target: { type: 'url', value: url }, reportNum, error: status === 'error' ? 'the Claude CLI is not approved' : null });

async function render(show: boolean) {
  const { BatchTab } = await import('@web/features/pipeline/BatchTab');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const inner = show ? createElement(BatchTab, { onStarted: () => void (started += 1) }) : createElement('p', null, 'Inbox');
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, inner))));
}

async function until<T>(fn: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = fn();
    if (v) return v;
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(name));
const textarea = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Batch URLs"]')!;
const click = (el: HTMLElement) => act(async () => el.click());
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

async function startHeldFanOut() {
  await render(true);
  await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
  await click(button('Batch evaluate')!);
  await click(button('Start them')!);
  await until(() => release, 'the fan-out request');
}

const partlyFailed = { sessions: [session('s1', 'https://jobs.example.com/1', 'queued', 12), session('s2', 'https://jobs.example.com/2', 'error', null)], reserved: [12, 13] };

beforeEach(() => {
  document.body.innerHTML = '';
  started = 0;
  release = null;
  holdSessions = false;
  answerSessions = null;
  readsAfterFanOut = 0;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/sessions/fanout' && method === 'POST')
        return new Promise<Response>(
          (resolve) =>
            (release = (body) => {
              readsAfterFanOut = 0;
              resolve(json(202, body));
            }),
        );
      if (url === '/api/sessions' && method === 'GET' && holdSessions) {
        holdSessions = false;
        return new Promise<Response>((resolve) => (answerSessions = resolve));
      }
      if (url === '/api/sessions' && method === 'GET') {
        readsAfterFanOut += 1;
        return json(200, []);
      }
      if (url === '/api/actions') return json(200, []);
      return json(404, { error: 'not stubbed' });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Pipeline > Batch left while a fan-out runs (R27-feat-b-L1-02)', () => {
  it('shown again before the fan-out answers: the URLs that did not start and the message land in the shown tab', async () => {
    await startHeldFanOut();
    await render(false);
    await render(true);
    await act(async () => release!(partlyFailed));
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Started 1 of 2 evaluations with report number 12\. 1 could not start: the Claude CLI is not approved/);
    expect(textarea().value).toBe('https://jobs.example.com/2');
    expect(started).toBe(0);
  });

  it('shown again after the fan-out answered: the outcome is kept for it', async () => {
    await startHeldFanOut();
    await render(false);
    await act(async () => release!(partlyFailed));
    await until(() => (readsAfterFanOut > 0 ? true : null), 'the sessions read that ends the start');
    await render(true);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/1 could not start: the Claude CLI is not approved/);
    expect(textarea().value).toBe('https://jobs.example.com/2');
    // Shown once: a later visit starts clean.
    await render(false);
    await render(true);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(textarea().value).toBe('');
  });

  it('left while the sessions list is read again and that read fails: the URLs and why none started land in the next tab', async () => {
    await render(true);
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    await click(button('Batch evaluate')!);
    holdSessions = true;
    await click(button('Start them')!);
    await until(() => answerSessions, 'the sessions read');
    await render(false);
    await act(async () => answerSessions!(json(500, { error: 'boom' })));
    await render(true);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/no evaluation was started/);
    expect(textarea().value).toBe('https://jobs.example.com/1\nhttps://jobs.example.com/2');
    expect(release).toBeNull();
  });

  it('left before a stopped start: the box comes back as typed, second spellings of one posting included', async () => {
    await render(true);
    const typed = 'https://jobs.example.com/2\nhttps://jobs.example.com/1\nhttps://jobs.example.com/1/';
    await type(textarea(), typed);
    await click(button('Batch evaluate')!);
    holdSessions = true;
    await click(button('Start them')!);
    await until(() => answerSessions, 'the sessions read');
    await render(false);
    await act(async () => answerSessions!(json(500, { error: 'boom' })));
    await render(true);
    await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(textarea().value).toBe(typed);
  });
});
