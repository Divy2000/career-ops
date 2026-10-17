import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { SessionStore } from '../../server/claude/sessions.js';
import { tempDir } from '../helpers/tmp.js';

const input = { mode: 'oferta', policyClass: 'evaluate' as const, target: { type: 'none' as const, value: null }, model: null };

describe('SessionStore temp names (R27-srv-core review)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given another writer writes the same session meta between this write and its rename, when both finish, then neither throws', () => {
    const store = new SessionStore(tempDir('cc-session-race-'), tempDir('cc-session-race-guard-'));
    const meta = store.create(input);
    const realRename = fs.renameSync.bind(fs);
    let raced = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!raced && String(to).endsWith('meta.json')) {
        raced = true;
        store.write({ ...meta, reportNum: 7 });
      }
      realRename(from, to);
    });
    expect(() => store.write({ ...meta, reportNum: 9 })).not.toThrow();
    expect(store.read(meta.id)?.reportNum).toBe(9);
    expect(fs.readdirSync(store.dirOf(meta.id)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('given the rename fails, when writing the session meta, then it throws and leaves no temp file', () => {
    const store = new SessionStore(tempDir('cc-session-fail-'), tempDir('cc-session-fail-guard-'));
    const meta = store.create(input);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => store.write({ ...meta, reportNum: 3 })).toThrow(/EIO/);
    expect(fs.readdirSync(store.dirOf(meta.id)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});
