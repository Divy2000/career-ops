// Dev Chat: a git diff or changes read that fails (the server child is down or reloading) says so, instead of reading
// as a clean tree or a session with no turns, exactly when the user is deciding whether to revert (R13-feat-a-L1-07).
import { createElement, type ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('server is restarting', { status: 503, headers: { 'content-type': 'text/plain' } })));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(el: ReactElement) {
  const { ConfirmProvider } = await import('@web/components/ConfirmDialog');
  root = createRoot(host);
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ConfirmProvider, null, el))));
}

describe('Dev Chat read failures', () => {
  it('a failed git diff read says it could not load, not clean', async () => {
    const { GitDiff } = await import('@web/features/dev/DevChatPage');
    await render(createElement(GitDiff));
    await until(() => host.textContent?.includes('Could not load the git diff'), 'the load error');
    expect(host.querySelector('pre')?.textContent ?? '').not.toBe('clean');
  });

  it('a failed changes read says it could not load, not No turns yet', async () => {
    const { ChangesPanel } = await import('@web/features/dev/DevChatPage');
    await render(createElement(ChangesPanel, { sessionId: 's-dev-1', live: false }));
    await until(() => host.textContent?.includes('Could not load the changes'), 'the load error');
    expect(host.textContent).not.toContain('No turns yet.');
  });
});
