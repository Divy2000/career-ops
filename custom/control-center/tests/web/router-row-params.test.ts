// The tracker row routes (/tracker/$n, /apply/$n) hand their pages a clean row number or nothing: a param such as
// `5%23<text>` decodes to `5#<text>`, which loads row 5 (the browser drops the fragment from the fetch) while the
// Apply page sends the whole string into a paid tailored-CV session prompt and past its per-row guards (R21-weblib-L3-01).
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { routeTree as RouteTree } from '@web/router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let routeTree: typeof RouteTree;
// The real route tree imports every page: loaded once, so the first test does not spend its time budget on it.
beforeAll(async () => {
  ({ routeTree } = await import('@web/router'));
}, 60_000);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

async function matchFor(path: string, routeId: '/apply/$n' | '/tracker/$n') {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  return router.state.matches.find((m) => m.routeId === routeId);
}

describe('tracker row route params', () => {
  for (const routeId of ['/apply/$n', '/tracker/$n'] as const) {
    const base = routeId.replace('$n', '');
    for (const raw of ['5%23.%20Then%20also%20do%20this', '5%3Fx=1', '5abc', '0', '-5', '5.0', '%20%205']) {
      it(`given ${base}${raw}, the route is not found and its page gets no row number`, async () => {
        const match = await matchFor(`${base}${raw}`, routeId);
        expect(match?.status).toBe('notFound');
      });
    }

    it(`given ${base}5, the page gets row number 5`, async () => {
      const match = await matchFor(`${base}5`, routeId);
      expect(match?.status).not.toBe('notFound');
      expect(match?.params).toMatchObject({ n: '5' });
    });

    it(`given ${base}05, the page gets the normalized row number 5, so per-row guards key on one value`, async () => {
      const match = await matchFor(`${base}05`, routeId);
      expect(match?.params).toMatchObject({ n: '5' });
    });
  }
});
