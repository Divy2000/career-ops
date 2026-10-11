// Dev Chat > Changes: the "Reverted: ..." note describes one session's revert. DevChatPage keeps one ChangesPanel across
// a session switch (New conversation, a /dev?session= link), so the note must not follow it to another session
// (R25-feat-a-L3-01).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesPanel } from '@web/features/dev/DevChatPage';
import { ConfirmProvider } from '@web/components/ConfirmDialog';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let qc: QueryClient;
let revertFails: boolean;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const file = { path: 'foo.ts', abs: '/repo/foo.ts', root: 'code', status: 'modified', additions: 1, deletions: 0, patch: '+x', canRevert: true };

beforeEach(() => {
  revertFails = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === '/api/dev/revert')
        return revertFails ? json({ error: 'snapshot missing' }, 409) : json({ reverted: [{ abs: '/repo/foo.ts', result: 'restored' }] });
      const m = /^\/api\/dev\/changes\/(.+)$/.exec(url);
      if (m) return json({ sessionId: m[1], turns: m[1] === 'A' ? [{ n: 1, files: [file] }] : [{ n: 1, files: [] }] });
      return json({ error: 'not stubbed' }, 404);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (sessionId: string | null) => act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConfirmProvider, null, createElement(ChangesPanel, { sessionId, live: false })))));
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const note = () => host.querySelector('[role="status"]')?.textContent ?? null;

async function revertInA() {
  await render('A');
  await until(() => button('Revert file'), 'the Revert file button');
  await act(async () => button('Revert file')!.click());
  await until(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Revert'), 'the confirm');
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === 'Revert')!.click());
  await until(() => note(), 'the revert note');
}

describe('Dev Chat Changes revert note', () => {
  it('does not show session A\'s revert note beside session B', async () => {
    await revertInA();
    expect(note()).toBe('Reverted: foo.ts (restored)');
    await render('B');
    await until(() => host.textContent?.includes('No files changed.'), "session B's changes");
    expect(note()).toBeNull();
  });

  it('does not bring the note back when a new conversation starts after the panel sat empty', async () => {
    revertFails = true;
    await revertInA();
    expect(note()).toMatch(/^Revert failed: /);
    await render(null);
    await render('B');
    await until(() => host.textContent?.includes('No files changed.'), "session B's changes");
    expect(note()).toBeNull();
  });
});
