// Dev Chat > Server reload reads the supervisor's blue/green state: { state: 'reloading', startedAt } while a reload
// runs and { state: 'ok', at } after it (supervisor/bluegreen.ts). Times show in the viewer's local time like every
// other timestamp in the app, and a running reload is not "no reload yet" (SW-web-b-10). vitest runs in Los Angeles.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReloadStatusCard } from '@web/features/dev/DevChatPage';
import { ReloadBanner } from '@web/components/Shell';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(status: unknown, component: () => ReturnType<typeof createElement> | null): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } })));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(component))));
}

async function card(status: unknown): Promise<string> {
  await render(status, ReloadStatusCard);
  return await until(() => /reload/.test(host.querySelector('p')?.textContent ?? '') && host.querySelector('p')!.textContent!, 'the reload status line');
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

  it('given a server that stopped after it started (no active child), then it says the server stopped and points to /__recovery, not that a previous one still serves (SW5-claude-04)', async () => {
    const stopped = { state: 'failed', at: '2026-10-06T09:00:00.000Z', error: 'server child exited (code 1, signal null) after it started', stderrTail: 'TypeError: runner.reconcil is not a function', crashed: true, activePid: null, activePort: null };
    await render(stopped, ReloadStatusCard);
    await until(() => /stopped/.test(host.textContent ?? ''), 'the stopped state');
    expect(host.textContent).toContain('server stopped');
    expect(host.textContent).toContain('No server is running');
    expect(host.textContent).not.toMatch(/previous server/i);
    expect(host.querySelector('a[href="/__recovery"]')).not.toBeNull();
    await act(async () => root.unmount());
    host.remove();
    await render(stopped, ReloadBanner);
    await until(() => /stopped/.test(host.textContent ?? ''), 'the stopped state');
    expect(host.textContent).toContain('The server stopped: server child exited (code 1, signal null) after it started.');
    expect(host.textContent).not.toMatch(/previous server/i);
    expect(host.querySelector('a[href="/__recovery"]')).not.toBeNull();
  });

  it('given a reload that failed with no server child running (no crashed flag), then it says the server stopped', async () => {
    // What supervisor/index.ts reports when a reload fails and there is no active child to keep serving.
    await render({ state: 'failed', at: '2026-10-06T09:00:00.000Z', error: 'healthz did not return 200 in time', stderrTail: '', activePid: null, activePort: null }, ReloadStatusCard);
    await until(() => /stopped/.test(host.textContent ?? ''), 'the stopped state');
    expect(host.textContent).toContain('No server is running');
    expect(host.textContent).not.toMatch(/previous server/i);
  });

  it('given a failed reload while the old server still runs, then the card keeps saying so', async () => {
    await render({ state: 'failed', at: '2026-10-06T09:00:00.000Z', error: 'healthz did not return 200 in time', stderrTail: '', activePid: 4242, activePort: 50123 }, ReloadStatusCard);
    await until(() => /failed/.test(host.textContent ?? ''), 'the failed state');
    expect(host.textContent).toContain('reload failed');
    expect(host.textContent).toContain('The previous server is still serving.');
    expect(host.textContent).not.toContain('server stopped');
  });
});
