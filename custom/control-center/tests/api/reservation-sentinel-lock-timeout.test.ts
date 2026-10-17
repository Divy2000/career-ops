import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers/tmp.js';
import { acquireTrackerLock, resolveTrackerPath, trackerLockDirFor } from '../../../../tracker-utils.mjs';

const SCRIPT = fileURLToPath(new URL('../../server/claude/reservation-sentinel.mjs', import.meta.url));

describe('the sentinel settler under a busy tracker lock (R27-mgr-rev-03 review follow-up)', () => {
  it('given a lock timeout set above its own bound, when the lock stays busy, then it gives up within the bound the server waits for', async () => {
    const root = tempDir('cc-r28-sentinel-');
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const lock = await acquireTrackerLock(trackerLockDirFor(resolveTrackerPath(root)), { timeoutMs: 5000 });
    try {
      const started = Date.now();
      const code = await new Promise<number | null>((resolve) => {
        const child = execFile(process.execPath, [SCRIPT, '--refresh', '7', '--since', String(Date.now())], { env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: '60000' }, timeout: 30_000 }, () => resolve(child.exitCode));
      });
      expect(code).toBe(1);
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      lock.release();
    }
  }, 40_000);
});
