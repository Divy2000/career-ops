import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { markQueuedRunsLost, recordTurnAfter } from '../../supervisor/recovery.js';
import { RunStore } from '../../server/runner/store.js';
import { tempDir } from '../helpers/tmp.js';

function queuedRun(dataRoot: string, sessionId: string): string {
  const dir = path.join(dataRoot, 'data', 'control-center', 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: 'r1', status: 'queued', params: { sessionId } }));
  fs.writeFileSync(path.join(dir, 'request.json'), '{}');
  return dir;
}

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => n.includes('.tmp'));

describe('markQueuedRunsLost temp names (R27-srv-core review)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given another writer has its temp for the run meta in flight, when marking a queued run lost, then that temp is left untouched', () => {
    const dataRoot = tempDir('cc-lost-race-');
    const dir = queuedRun(dataRoot, 's1');
    fs.writeFileSync(path.join(dir, 'meta.json.tmp'), 'in flight');
    markQueuedRunsLost(dataRoot, 's1');
    expect(new RunStore(dataRoot, 5).read('r1')?.status).toBe('lost');
    expect(fs.readFileSync(path.join(dir, 'meta.json.tmp'), 'utf8')).toBe('in flight');
    expect(temps(dir)).toEqual(['meta.json.tmp']);
  });

  it('given the rename fails, when marking a queued run lost, then it does not throw and leaves no temp file', () => {
    const dataRoot = tempDir('cc-lost-fail-');
    const dir = queuedRun(dataRoot, 's1');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => markQueuedRunsLost(dataRoot, 's1')).not.toThrow();
    expect(temps(dir)).toEqual([]);
  });
});

describe('recordTurnAfter temp names (R27-srv-core review)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('given another writer has its temp for after.json in flight, when finalizing a turn, then that temp is left untouched', () => {
    const sessionDir = tempDir('cc-after-race-');
    const turnDir = path.join(sessionDir, 'turns', '1');
    fs.mkdirSync(turnDir, { recursive: true });
    fs.writeFileSync(path.join(turnDir, 'after.json.tmp'), 'in flight');
    recordTurnAfter(sessionDir, 1, 0);
    expect(JSON.parse(fs.readFileSync(path.join(turnDir, 'after.json'), 'utf8')).files).toEqual({});
    expect(fs.readFileSync(path.join(turnDir, 'after.json.tmp'), 'utf8')).toBe('in flight');
  });

  it('given the rename fails, when finalizing a turn, then it throws and leaves no temp file', () => {
    const sessionDir = tempDir('cc-after-fail-');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => recordTurnAfter(sessionDir, 1, 0)).toThrow(/EIO/);
    expect(temps(path.join(sessionDir, 'turns', '1'))).toEqual([]);
  });
});
