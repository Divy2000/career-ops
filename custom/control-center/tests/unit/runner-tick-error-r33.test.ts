// A run's tracking tick reads its record from disk. A read that fails for a moment (EIO, a torn file) must not escape
// the timer: an uncaught exception there takes the whole server down (R33-flake-resv28).
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { Runner } from '../../server/runner/runner.js';
import { EventBus } from '../../server/watch/bus.js';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { runsEnded } from '../helpers/runs.js';

const NOISY = path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(20);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('a run whose record cannot be read for a moment', () => {
  it('Given a tracked run, When its tick cannot read the run record, Then nothing escapes the timer and the run still ends done once the read works again', async () => {
    const root = tempDir('cc-runner-tick-');
    const runner = new Runner(root, new EventBus(), { pollMs: 20, claudeSlots: 1 });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    cleanups.push(() => {
      process.off('uncaughtException', onUncaught);
      runner.close();
    });
    const run = runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [NOISY, '0', '1500'], cwd: PACKAGE_ROOT } });
    await until(() => runner.store.read(run.id)?.status === 'running');

    const read = runner.store.read.bind(runner.store);
    let failed = 0;
    const spy = vi.spyOn(runner.store, 'read').mockImplementation((id: string) => {
      if (id !== run.id) return read(id);
      failed++;
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    });
    // Several ticks hit the failing read.
    await until(() => failed >= 3);
    spy.mockRestore();

    await until(() => runner.store.read(run.id)?.status === 'done');
    await runsEnded(root);
    expect(uncaught).toEqual([]);
  });

  it('Given a run that has exited, When recording its end fails for a moment, Then it stays tracked and ends done once the write works again', async () => {
    const root = tempDir('cc-runner-tick-');
    const runner = new Runner(root, new EventBus(), { pollMs: 20, claudeSlots: 1 });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => {
      process.off('uncaughtException', onUncaught);
      error.mockRestore();
      runner.close();
    });
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    const spy = vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.status !== 'done') return write(meta);
      failed++;
      throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    });
    const run = runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [NOISY, '0', '0'], cwd: PACKAGE_ROOT } });
    await until(() => failed >= 3);
    spy.mockRestore();

    await until(() => runner.store.read(run.id)?.status === 'done');
    await runsEnded(root);
    expect(uncaught).toEqual([]);
    // Logged once for the failing stretch, not on every tick.
    expect(error.mock.calls.filter((c) => String(c[0]).includes(run.id))).toHaveLength(1);
  });
});
