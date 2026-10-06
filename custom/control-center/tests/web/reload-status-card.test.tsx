// Dev Chat > Server reload reads the supervisor's blue/green state: { state: 'reloading', startedAt } while a reload
// runs and { state: 'ok', at } after it (supervisor/bluegreen.ts). Times show in the viewer's local time like every
// other timestamp in the app, and a running reload is not "no reload yet" (SW-web-b-10). vitest runs in Los Angeles.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReloadStatusCard } from '@web/features/dev/DevChatPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function card(status: unknown): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ReloadStatusCard))));
  for (let i = 0; i < 20 && !/reload/.test(host.querySelector('p')?.textContent ?? ''); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
  return host.querySelector('p')?.textContent ?? '';
}

describe('the Server reload card', () => {
  it('given a finished reload, then it says when in local time', async () => {
    // 21:03 UTC on 2026-10-05 is 14:03 in Los Angeles.
    expect(await card({ state: 'ok', at: '2026-10-05T21:03:22.512Z', pid: 42 })).toBe('ok last reload 2026-10-05 14:03');
  });

  it('given a reload in progress, then it says since when, not "no reload yet"', async () => {
    expect(await card({ state: 'reloading', startedAt: '2026-10-06T02:00:05.000Z' })).toBe('reloading since 2026-10-05 19:00');
  });

  it('given no reload yet, then it says so', async () => {
    expect(await card({ state: 'idle' })).toBe('idle no reload yet; server edits trigger a blue/green restart');
  });
});
