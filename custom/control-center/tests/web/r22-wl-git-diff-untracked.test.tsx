// A Dev Chat turn that only added files under custom/ must show them in the git diff card instead of "clean"
// (R22-feat-a-L2-01).
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const stubDiff = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })));

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(el: ReactElement) {
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, el)));
}

describe('Dev Chat git diff card', () => {
  it('lists untracked new files instead of saying clean', async () => {
    stubDiff({ ok: true, stat: '', diff: '', untracked: ['custom/web/insights/NewTab.tsx'], error: null });
    const { GitDiff } = await import('@web/features/dev/DevChatPage');
    await render(createElement(GitDiff));
    await until(() => host.textContent?.includes('NewTab.tsx'), 'the untracked file');
    expect(host.textContent).toContain('custom/web/insights/NewTab.tsx');
    expect(host.textContent).toContain('1 untracked');
    expect([...host.querySelectorAll('pre')].map((p) => p.textContent)).not.toContain('clean');
  });

  it('says how many untracked files were left out of a capped list', async () => {
    stubDiff({ ok: true, stat: '', diff: '', untracked: ['custom/build/a.js', 'custom/build/b.js'], untrackedTotal: 1200, error: null });
    const { GitDiff } = await import('@web/features/dev/DevChatPage');
    await render(createElement(GitDiff));
    await until(() => host.textContent?.includes('a.js'), 'the untracked files');
    expect(host.textContent).toContain('1200 untracked');
    expect(host.textContent).toContain('and 1198 more');
  });

  it('does not say clean when the read failed', async () => {
    stubDiff({ ok: false, stat: '', diff: '', untracked: [], untrackedTotal: 0, error: 'fatal: boom' });
    const { GitDiff } = await import('@web/features/dev/DevChatPage');
    await render(createElement(GitDiff));
    await until(() => host.textContent?.includes('fatal: boom'), 'the error');
    expect([...host.querySelectorAll('pre')].map((p) => p.textContent)).not.toContain('clean');
  });

  it('says clean when there is neither a diff nor an untracked file', async () => {
    stubDiff({ ok: true, stat: '', diff: '', untracked: [], error: null });
    const { GitDiff } = await import('@web/features/dev/DevChatPage');
    await render(createElement(GitDiff));
    await until(() => host.querySelector('pre')?.textContent === 'clean', 'clean');
  });
});
