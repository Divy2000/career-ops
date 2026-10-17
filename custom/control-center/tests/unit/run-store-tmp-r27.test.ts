import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { RunStore } from '../../server/runner/store.js';
import { tempDir } from '../helpers/tmp.js';

const base = { actionId: 'a', label: 'a', cost: 'free' as const, resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} };

describe('RunStore temp names (R27-srv-core-L2-02)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given another writer writes the same run meta between this write and its rename, when both finish, then neither throws', () => {
    const store = new RunStore(tempDir('cc-runstore-race-'), 5);
    const run = store.create(base);
    const realRename = fs.renameSync.bind(fs);
    let raced = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!raced && String(to).endsWith('meta.json')) {
        raced = true;
        store.write({ ...run, status: 'cancelled' });
      }
      realRename(from, to);
    });
    expect(() => store.write({ ...run, status: 'running', childPid: 42 })).not.toThrow();
    expect(store.read(run.id)?.status).toBe('running');
    expect(fs.readdirSync(store.dirOf(run.id)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('given the rename fails, when writing the run meta, then it throws and leaves no temp file', () => {
    const store = new RunStore(tempDir('cc-runstore-fail-'), 5);
    const run = store.create(base);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => store.write({ ...run, status: 'done' })).toThrow(/EIO/);
    expect(fs.readdirSync(store.dirOf(run.id)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('given the rename fails, when writing the start request, then it throws and leaves no temp file', () => {
    const store = new RunStore(tempDir('cc-runstore-req-'), 5);
    const run = store.create(base);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => store.writeRequest(run.id, { env: {}, secrets: [] })).toThrow(/EIO/);
    expect(fs.readdirSync(store.dirOf(run.id)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});
