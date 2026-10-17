import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { SessionStore } from '../../server/claude/sessions.js';
import { tempDir } from '../helpers/tmp.js';

// R29-claude-X-01: a session id is a UTC second plus 24 random bits; two sessions that draw the same id must stay two
// sessions, not the second one's meta.json written over the first's folder.
describe('session ids that collide (R29-claude-X-01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('given two sessions created in one second drawing the same random suffix, when both are created, then each gets its own folder and the first is untouched', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T12:00:00.000Z') });
    const store = new SessionStore(tempDir('cc-r29-ids-'), tempDir('cc-r29-ids-guard-'));
    const a = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://x.example/1' }, model: null });
    // The next id draw repeats the first session's suffix; any later one (a retry) is random again.
    vi.spyOn(crypto, 'randomBytes').mockImplementationOnce((() => Buffer.from(a.id.slice(-6), 'hex')) as unknown as typeof crypto.randomBytes);
    const b = store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
    expect(a.id.startsWith('s20261017120000-')).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(store.read(a.id)).toMatchObject({ mode: 'oferta', target: { value: 'https://x.example/1' } });
    expect(store.read(b.id)).toMatchObject({ mode: 'advisor' });
    expect(store.list().map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });
});
