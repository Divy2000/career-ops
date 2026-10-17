// A session id goes into /api/sessions/ paths encoded, so an id that is not one (`a/../fanout`) cannot reach a sibling
// API route (R29-weblib-X-01).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelSession, forkSession, sendTurn } from '@web/lib/sessions';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const path = () => fetchMock.mock.calls[0]![0] as string;

describe('session API paths', () => {
  it('given an id with a slash, a reply goes to that id\'s turns path, encoded', async () => {
    await sendTurn('a/../fanout', 'hi');
    expect(path()).toBe('/api/sessions/a%2F..%2Ffanout/turns');
  });

  it('given an id with a slash, a fork goes to that id\'s fork path, encoded', async () => {
    await forkSession('a/../fanout', 'hi');
    expect(path()).toBe('/api/sessions/a%2F..%2Ffanout/fork');
  });

  it('given an id with a slash, a cancel goes to that id\'s cancel path, encoded', async () => {
    await cancelSession('a/../fanout');
    expect(path()).toBe('/api/sessions/a%2F..%2Ffanout/cancel');
  });
});
