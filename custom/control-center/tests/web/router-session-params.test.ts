// The session detail route hands its page a session id or nothing: a param such as `engine` names another route under
// /api/sessions/ (its answer has no meta, and the page threw on it), and `a%2F..%2Ffanout` decodes into a sibling API
// path (R29-weblib-X-01).
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

async function matchFor(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  return router.state.matches.find((m) => m.routeId === '/sessions/$id');
}

describe('session detail route params', () => {
  for (const raw of ['engine', 'fanout', 'a%2F..%2Ffanout', 'a.b', '%20s1', 'x'.repeat(81)]) {
    it(`given /sessions/${raw.slice(0, 20)}, the route is not found and its page gets no id`, async () => {
      const match = await matchFor(`/sessions/${raw}`);
      expect(match?.status).toBe('notFound');
    });
  }

  it('given a session id, the page gets it unchanged', async () => {
    const match = await matchFor('/sessions/2026-10-17T12-00-00-abc_1');
    expect(match?.status).not.toBe('notFound');
    expect(match?.params).toMatchObject({ id: '2026-10-17T12-00-00-abc_1' });
  });
});
