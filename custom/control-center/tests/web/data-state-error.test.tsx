// A page that cannot load says why in the server's words ("no tracker row #9999", "tracker unavailable" and its
// detail), not just the HTTP status line (SW5-web-a-03).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@web/lib/api';
import { DataState } from '@web/components/ui';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

function Probe({ error }: { error: unknown }) {
  const q = useQuery({ queryKey: ['probe'], queryFn: async () => Promise.reject(error), retry: false });
  return createElement(DataState, { query: q }, 'loaded');
}

async function show(error: unknown) {
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe, { error }))));
  return until(() => host.querySelector('[role="alert"]')?.textContent, 'the error card');
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('DataState load errors', () => {
  it('shows the reason the server sent', async () => {
    expect(await show(new ApiError(404, '404 Not Found', { error: 'no tracker row #9999' }))).toContain('Could not load. no tracker row #9999');
  });

  it('adds the detail the server sent with it', async () => {
    const text = await show(new ApiError(502, '502 Bad Gateway', { error: 'followup-cadence failed', detail: 'it reported no applications but the tracker has rows' }));
    expect(text).toContain('followup-cadence failed');
    expect(text).toContain('it reported no applications but the tracker has rows');
  });

  it('falls back to the status line when the body says nothing, and to the message of a plain error', async () => {
    expect(await show(new ApiError(502, '502 Bad Gateway', null))).toContain('Could not load. 502 Bad Gateway');
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(await show(new Error('Failed to fetch'))).toContain('Could not load. Failed to fetch');
  });
});
