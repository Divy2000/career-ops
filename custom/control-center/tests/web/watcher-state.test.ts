import { describe, expect, it } from 'vitest';
import { summarizeWatcher } from '../../web/lib/watcherState';

describe('watcher state summary', () => {
  it('reads the last run, per-source last success and the seen count from the current seen.json shape', () => {
    const s = summarizeWatcher({ ids: ['a', 'b', 'c'], last_run: '2026-10-03', last_success: { uscis: '2026-10-03', 'federal-register': '2026-10-02' } }, 4);
    expect(s).toEqual({ lastRun: '2026-10-03', sources: [{ name: 'federal-register', lastSuccess: '2026-10-02' }, { name: 'uscis', lastSuccess: '2026-10-03' }], seenCount: 3, pendingCount: 4 });
  });

  it('accepts the older single-date last_success string', () => {
    expect(summarizeWatcher({ ids: [], last_run: '2026-10-02', last_success: '2026-10-02' }, null)).toEqual({ lastRun: '2026-10-02', sources: [], seenCount: 0, pendingCount: null, lastSuccess: '2026-10-02' });
  });

  it('returns null when the file is absent and flags an unreadable one', () => {
    expect(summarizeWatcher(null, null)).toBeNull();
    expect(summarizeWatcher({ error: 'malformed JSON', path: '/x/seen.json' }, null)).toEqual({ error: 'malformed JSON' });
  });

  it('tolerates missing fields', () => {
    expect(summarizeWatcher({}, null)).toEqual({ lastRun: null, sources: [], seenCount: 0, pendingCount: null });
  });
});
