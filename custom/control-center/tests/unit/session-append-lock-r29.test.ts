import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore, sessionsDir } from '../../server/claude/sessions.js';
import { tempDir } from '../helpers/tmp.js';

// R29-claude-X-02: a holder of a session's events lock that stalls past the stale timeout has its lock broken by a peer
// server, which appends the next seq; the stalled holder must not then append that same seq again.
describe('a session events lock broken while its holder stalls (R29-claude-X-02)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given a holder that read the tail and stalled while a peer broke its lock and appended, when it resumes, then it appends under the next free seq', () => {
    const root = tempDir('cc-r29-append-');
    const store = new SessionStore(root, tempDir('cc-r29-append-guard-'));
    const s = store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
    expect(store.appendEvent(s.id, { type: 'text.delta', text: 'one' })).toBe(1);
    const file = path.join(sessionsDir(root), s.id, 'events.ndjson');
    const lock = `${file}.lock`;
    const realIso = Date.prototype.toISOString;
    let stalled = false;
    // The holder stamps its line after reading the tail: that is where it stalls, and where the peer steps in.
    vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) {
      if (!stalled && fs.existsSync(lock)) {
        stalled = true;
        // The peer judges the lock stale, moves it aside, takes its own, appends seq 2 and lets go.
        fs.renameSync(lock, `${lock}.peer.stale`);
        fs.rmSync(`${lock}.peer.stale`);
        fs.writeFileSync(lock, `${process.pid} peer-token`);
        fs.appendFileSync(file, JSON.stringify({ seq: 2, ts: realIso.call(new Date()), event: { type: 'text.delta', text: 'peer' } }) + '\n');
        fs.rmSync(lock);
      }
      return realIso.call(this);
    });
    const seq = store.appendEvent(s.id, { type: 'text.delta', text: 'holder' });
    expect(stalled).toBe(true);
    const seqs = store.readEvents(s.id).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(seq).toBe(3);
    expect(store.readEvents(s.id).map((e) => (e.event as { text: string }).text)).toEqual(['one', 'peer', 'holder']);
  });
});
