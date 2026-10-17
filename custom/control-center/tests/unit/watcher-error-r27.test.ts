import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcher } from 'chokidar';
import type { EventBus } from '../../server/watch/bus.js';
import { startWatcher } from '../../server/watch/watcher.js';
import { tempDir } from '../helpers/tmp.js';

describe('startWatcher error handling (R27-srv-core-L1-01)', () => {
  let watcher: FSWatcher | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await watcher?.close();
    watcher = null;
  });

  it('given a watch error such as EMFILE, when chokidar emits it, then it is logged and the process does not throw', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    watcher = startWatcher(tempDir('cc-watch-err-'), { publish: () => {} } as unknown as EventBus, 20);
    const err = Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
    expect(() => watcher!.emit('error', err)).not.toThrow();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[watch]'), err);
  });
});
