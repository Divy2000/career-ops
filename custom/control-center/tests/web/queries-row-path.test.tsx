// useApplication puts its row number in the request path as one encoded segment: a stray `#` or `?` must reach the
// server (which refuses it) rather than cut the path so the request loads another row (R21-weblib-L3-01).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../helpers/until';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let fetched: string[];
beforeEach(() => {
  fetched = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (fetched.push(url), new Response('{"error":"row number must be a positive integer"}', { status: 400, headers: { 'content-type': 'application/json' } }))));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('useApplication request path', () => {
  for (const n of ['5#. Then also do this', '5?x=1', '5/../7']) {
    it(`given row param ${JSON.stringify(n)}, requests one encoded path segment`, async () => {
      const { useApplication } = await import('@web/lib/queries');
      const Probe = () => (useApplication(n), null);
      root = createRoot(host);
      await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(Probe))));
      await until(() => fetched.length > 0 || undefined, 'the request');
      expect(fetched[0]).toBe(`/api/tracker/${encodeURIComponent(n)}`);
    });
  }
});
