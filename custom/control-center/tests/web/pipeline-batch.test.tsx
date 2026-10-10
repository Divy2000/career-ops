import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let sent: Array<{ method: string; url: string; body: unknown }>;
let fanoutResponse: { status: number; body: unknown };
let started: number;
// GET /api/sessions: what the server lists after a fan-out that failed part way.
let listed: unknown[] | null;
let fetchHook: ((url: string) => void) | null;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const navigated: unknown[] = [];
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<object>()), useNavigate: () => async (to: unknown) => void navigated.push(to) }));

async function mount(component: 'BatchTab' | { inboxUrls: string[] } = 'BatchTab') {
  sent = [];
  started = 0;
  navigated.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      sent.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
      fetchHook?.(url);
      if (url === '/api/sessions/fanout' && method === 'POST') return json(fanoutResponse.status, fanoutResponse.body);
      if (url === '/api/actions') return json(200, []);
      if (url === '/api/sessions' && method === 'GET' && listed) return json(200, listed);
      return json(404, { error: 'not stubbed' });
    }),
  );
  const { BatchTab } = await import('@web/features/pipeline/BatchTab');
  const { InboxAi } = await import('@web/features/pipeline/InboxAi');
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const inner = component === 'BatchTab' ? createElement(BatchTab, { onStarted: () => void (started += 1) }) : createElement(InboxAi, { urls: component.inboxUrls });
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

beforeEach(() => {
  document.body.innerHTML = '';
  listed = null;
  fetchHook = null;
  fanoutResponse = { status: 202, body: { sessions: [{ id: 's1' }, { id: 's2' }], reserved: [12, 13] } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe('Pipeline > Batch', () => {
  it('starts one confined oferta session per URL through the fan-out, never batch-runner.sh', async () => {
    await mount();
    expect(host.textContent).not.toMatch(/batch-runner/);
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2 https://jobs.example.com/1\n');
    await click(button('Batch evaluate')!);
    // A token-spending start is always confirmed, with the count of sessions it starts.
    expect(document.body.textContent).toMatch(/Start 2 evaluation sessions\?/);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    await click(button('Start them')!);
    await until(() => sent.find((s) => s.url === '/api/sessions/fanout'), 'the fan-out request');
    expect(sent.filter((s) => s.method === 'POST')).toEqual([{ method: 'POST', url: '/api/sessions/fanout', body: { mode: 'oferta', urls: ['https://jobs.example.com/1', 'https://jobs.example.com/2'] } }]);
    await until(() => (started === 1 ? true : null), 'the started callback');
    expect(host.textContent).toMatch(/Started 2 evaluations with report numbers 12, 13/);
  });

  it('cancelling the confirm starts nothing', async () => {
    await mount();
    await type(textarea(), 'https://jobs.example.com/1');
    await click(button('Batch evaluate')!);
    await click(button('Cancel')!);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(started).toBe(0);
  });

  it('shows why the fan-out was refused and keeps the URLs', async () => {
    fanoutResponse = { status: 502, body: { error: 'reserve-report-num failed (exit 1): locked' } };
    await mount();
    await type(textarea(), 'https://jobs.example.com/1');
    await click(button('Batch evaluate')!);
    await click(button('Start them')!);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Could not start the evaluations: .*reserve-report-num failed/);
    expect(textarea().value).toBe('https://jobs.example.com/1');
    expect(started).toBe(0);
  });

  it('a fan-out that fails after starting some sessions keeps only the URLs that did not start (R13-feat-b-p-02)', async () => {
    fanoutResponse = { status: 502, body: { error: 'spawn failed' } };
    await mount();
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    await click(button('Batch evaluate')!);
    // Before the start the server lists an older evaluation of the second URL; that one was not started by this batch.
    const older = { id: 's0', mode: 'oferta', status: 'done', target: { type: 'url', value: 'https://jobs.example.com/2' }, createdAt: '2030-01-01T00:00:00.000Z' };
    listed = [older];
    fetchHook = (url) => {
      // The server started the first one before the second start threw; its clock is not the page's.
      if (url === '/api/sessions/fanout') listed = [older, { id: 's1', mode: 'oferta', status: 'queued', target: { type: 'url', value: 'https://jobs.example.com/1' }, createdAt: '2001-01-01T00:00:00.000Z' }];
    };
    await click(button('Start them')!);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Could not start the evaluations: spawn failed/);
    expect(alert.textContent).toMatch(/1 started before the failure/);
    expect(textarea().value).toBe('https://jobs.example.com/2');
  });

  it('a pasted saved-JD reference or other non-posting entry is refused before anything starts (R13-feat-b-L3-02)', async () => {
    await mount();
    await type(textarea(), 'local:jds/acme.md\nhttps://jobs.example.com/1\nfile:///etc/hosts');
    expect(button('Batch evaluate')!.disabled).toBe(true);
    expect(host.textContent).toContain('Not posting URLs: local:jds/acme.md, file:///etc/hosts');
    expect(host.textContent).toContain('Evaluate JD');
  });

  it('counts the pasted URLs in words that fit the number', async () => {
    await mount();
    await type(textarea(), 'https://jobs.example.com/1');
    expect(host.textContent).toMatch(/1 URL(?!s)/);
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    expect(host.textContent).toMatch(/2 URLs/);
  });

  it('more URLs than one fan-out takes: the button stays disabled and says the limit', async () => {
    await mount();
    await type(textarea(), Array.from({ length: 51 }, (_, i) => `https://jobs.example.com/${i}`).join('\n'));
    expect(button('Batch evaluate')!.disabled).toBe(true);
    expect(host.textContent).toMatch(/at most 50 URLs/);
  });
});

describe('Pipeline > Inbox > Evaluate visible', () => {
  const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://jobs.example.com/${i}`);

  it('up to one fan-out of visible pending rows: confirmed with the count, then sent as one request', async () => {
    await mount({ inboxUrls: urls(50) });
    await click(button('Evaluate visible (50)')!);
    expect(document.body.textContent).toMatch(/Start 50 evaluation sessions\?/);
    await click(button('Start them')!);
    await until(() => sent.find((s) => s.url === '/api/sessions/fanout'), 'the fan-out request');
    expect(sent.filter((s) => s.method === 'POST')).toEqual([{ method: 'POST', url: '/api/sessions/fanout', body: { mode: 'oferta', urls: urls(50) } }]);
    await until(() => (navigated.length === 1 ? true : null), 'the move to Sessions');
  });

  it('more visible pending rows than one fan-out takes: the button is disabled and says the limit and how to get under it', async () => {
    await mount({ inboxUrls: urls(60) });
    const evaluate = button('Evaluate visible (60)')!;
    expect(evaluate.disabled).toBe(true);
    expect(host.textContent).toMatch(/At most 50 evaluations at a time/);
    expect(host.textContent).toMatch(/filter/i);
    await click(evaluate);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Start 60 evaluation sessions/);
  });

  it('counts and sends distinct URLs: two rows with the same posting are one evaluation', async () => {
    const withCopies = [...urls(50), ...urls(10)];
    await mount({ inboxUrls: withCopies });
    const evaluate = button('Evaluate visible (50)')!;
    expect(evaluate.disabled).toBe(false);
    expect(host.textContent).not.toMatch(/At most 50/);
    await click(evaluate);
    expect(document.body.textContent).toMatch(/Start 50 evaluation sessions\?/);
    await click(button('Start them')!);
    await until(() => sent.find((s) => s.url === '/api/sessions/fanout'), 'the fan-out request');
    expect(sent.filter((s) => s.method === 'POST')).toEqual([{ method: 'POST', url: '/api/sessions/fanout', body: { mode: 'oferta', urls: urls(50) } }]);
  });

  it('more distinct URLs than one fan-out takes stay disabled even when copies are left out', async () => {
    await mount({ inboxUrls: [...urls(51), ...urls(51)] });
    expect(button('Evaluate visible (51)')!.disabled).toBe(true);
  });
});

describe('a fan-out whose sessions fail to start (SW5-tests-07)', () => {
  // The fan-out answers 202 even when a session fails before its turn runs (no approved CLI, no token); its report
  // number goes back to the pool and the session carries status error.
  const session = (id: string, url: string, status: 'queued' | 'error', reportNum: number | null) => ({ id, status, target: { type: 'url', value: url }, reportNum, error: status === 'error' ? 'the Claude CLI is not approved' : null });

  it('Batch evaluate: every session errored, so the URLs stay for a retry and the error shows, with no "Started"', async () => {
    fanoutResponse = { status: 202, body: { sessions: [session('s1', 'https://jobs.example.com/1', 'error', null), session('s2', 'https://jobs.example.com/2', 'error', null)], reserved: [12, 13] } };
    await mount();
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    await click(button('Batch evaluate')!);
    await click(button('Start them')!);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Could not start the evaluations: the Claude CLI is not approved/);
    expect(host.textContent).not.toMatch(/Started/);
    expect(textarea().value).toBe('https://jobs.example.com/1\nhttps://jobs.example.com/2');
    expect(started).toBe(0);
  });

  it('Batch evaluate: some sessions errored, so only their URLs stay and the message says which started', async () => {
    fanoutResponse = { status: 202, body: { sessions: [session('s1', 'https://jobs.example.com/1', 'queued', 12), session('s2', 'https://jobs.example.com/2', 'error', null)], reserved: [12, 13] } };
    await mount();
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    await click(button('Batch evaluate')!);
    await click(button('Start them')!);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Started 1 of 2 evaluations with report number 12\. 1 could not start: the Claude CLI is not approved/);
    expect(textarea().value).toBe('https://jobs.example.com/2');
    // The Pipeline page moves to Sessions on onStarted, which would hide this message and the kept URL.
    expect(started).toBe(0);
  });

  it('Evaluate visible: every session errored, so it stays on the Inbox and shows the error', async () => {
    fanoutResponse = { status: 202, body: { sessions: [session('s1', 'https://jobs.example.com/1', 'error', null)], reserved: [12] } };
    await mount({ inboxUrls: ['https://jobs.example.com/1'] });
    await click(button('Evaluate visible (1)')!);
    const alert = await until(() => host.querySelector('[role="alert"]'), 'the error');
    expect(alert.textContent).toMatch(/Could not start the evaluations: the Claude CLI is not approved/);
    expect(host.textContent).not.toMatch(/Started/);
    expect(navigated).toEqual([]);
  });
});

describe('paid fan-out confirms open on Cancel (SW6-web-a-03)', () => {
  const focused = () => (document.activeElement as HTMLElement | null)?.textContent?.trim();

  it('Batch evaluate: a held or double-pressed Enter cannot start the sessions', async () => {
    await mount();
    await type(textarea(), 'https://jobs.example.com/1\nhttps://jobs.example.com/2');
    await click(button('Batch evaluate')!);
    expect(focused()).toBe('Cancel');
  });

  it('Evaluate visible above three rows', async () => {
    await mount({ inboxUrls: ['https://jobs.example.com/1', 'https://jobs.example.com/2', 'https://jobs.example.com/3', 'https://jobs.example.com/4'] });
    await click(button('Evaluate visible')!);
    expect(document.body.textContent).toMatch(/Start 4 evaluation sessions\?/);
    expect(focused()).toBe('Cancel');
  });
});

