// A run's tracking tick reads its record from disk. A read that fails for a moment (EIO, a torn file) must not escape
// the timer: an uncaught exception there takes the whole server down (R33-flake-resv28).
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
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

const noisy = (args: string[]) => ({ actionId: 'test.noisy', label: 'noisy', cost: 'free' as const, resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [NOISY, ...args], cwd: PACKAGE_ROOT } });
/** Private members the timer guards sit in, reached for the cases no public call can time. */
type Internals = { pump: () => void; retryLater: () => void; afterGrace: (fn: () => void) => void };
const internals = (r: Runner) => r as unknown as Internals;

const cleanups: Array<() => void> = [];
/** A runner whose uncaught exceptions are collected, and whose console.error is quiet. */
function watchedRunner(root: string, nodePath?: string): { runner: Runner; uncaught: unknown[]; error: MockInstance<typeof console.error> } {
  const runner = new Runner(root, new EventBus(), { pollMs: 20, claudeSlots: 1, ...(nodePath ? { nodePath } : {}) });
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  cleanups.push(() => {
    process.off('uncaughtException', onUncaught);
    error.mockRestore();
    runner.close();
  });
  return { runner, uncaught, error };
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('a run whose record cannot be read for a moment', () => {
  it('Given a tracked run, When its tick cannot read the run record, Then nothing escapes the timer and the run still ends done once the read works again', async () => {
    const root = tempDir('cc-runner-tick-');
    const { runner, uncaught } = watchedRunner(root);
    const run = runner.start(noisy(['0', '1500']));
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
    const { runner, uncaught, error } = watchedRunner(root);
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    const spy = vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.status !== 'done') return write(meta);
      failed++;
      throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    });
    const run = runner.start(noisy(['0', '0']));
    await until(() => failed >= 3);
    spy.mockRestore();

    await until(() => runner.store.read(run.id)?.status === 'done');
    await runsEnded(root);
    expect(uncaught).toEqual([]);
    // Logged once for the failing stretch, not on every tick.
    expect(error.mock.calls.filter((c) => String(c[0]).includes(run.id))).toHaveLength(1);
  });

  it('Given a wrapper just spawned, When recording the run as running fails once, Then the run is still followed, started only once, and ends done', async () => {
    const root = tempDir('cc-runner-tick-');
    const { runner, uncaught } = watchedRunner(root);
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.status === 'running' && failed === 0) {
        failed++;
        throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      }
      return write(meta);
    });
    const run = runner.start(noisy(['0', '300']));

    await until(() => runner.store.read(run.id)?.status === 'done');
    await runsEnded(root);
    expect(failed).toBe(1);
    expect(runner.store.readRaw(run.id).lines.filter((l) => l.line === 'line one')).toHaveLength(1);
    expect(uncaught).toEqual([]);
  });

  it('Given a wrapper that cannot be spawned, When recording its failure fails once, Then it is recorded failed on a later try', async () => {
    const root = tempDir('cc-runner-tick-');
    const { runner, uncaught } = watchedRunner(root, '/nonexistent/node-removed-by-brew-upgrade');
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.status === 'failed' && failed === 0) {
        failed++;
        throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      }
      return write(meta);
    });
    const run = runner.start(noisy(['0']));

    await until(() => runner.store.read(run.id)?.status === 'failed');
    expect(failed).toBe(1);
    expect(runner.store.read(run.id)!.error).toMatch(/could not start the run/);
    expect(uncaught).toEqual([]);
  });

  it('Given a later start is due, When it throws, Then nothing escapes the timer and it is tried again', () => {
    vi.useFakeTimers();
    try {
      const { runner } = watchedRunner(tempDir('cc-runner-tick-'));
      let calls = 0;
      vi.spyOn(internals(runner), 'pump').mockImplementation(() => {
        calls++;
        if (calls === 1) throw new Error('EIO: i/o error, read');
      });
      // pollMs 20: a later start is due 80 ms on.
      internals(runner).retryLater();
      expect(() => vi.advanceTimersByTime(80)).not.toThrow();
      expect(calls).toBe(1);
      vi.advanceTimersByTime(80);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Given a SIGKILL armed for after the grace, When it throws, Then nothing escapes the timer', () => {
    vi.useFakeTimers();
    try {
      const { runner } = watchedRunner(tempDir('cc-runner-tick-'));
      let ran = false;
      internals(runner).afterGrace(() => {
        ran = true;
        throw new Error('EIO: i/o error, read');
      });
      expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
      expect(ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Given a run another process cancelled, whose SIGKILL is armed here, When settling it throws and it is tracked again, Then no second SIGKILL is armed', async () => {
    const root = tempDir('cc-runner-tick-');
    const { runner } = watchedRunner(root);
    const run = runner.start(noisy(['0', '400']));
    await until(() => runner.store.read(run.id)?.childPid != null);
    const armed = vi.spyOn(internals(runner), 'afterGrace').mockImplementation(() => {});
    // Another process marks it cancelled; this one arms its SIGKILL on the next look.
    runner.store.write({ ...runner.store.read(run.id)!, status: 'cancelled' });
    await until(() => armed.mock.calls.length === 1);
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.endedAt && failed < 3) {
        failed++;
        throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      }
      return write(meta);
    });

    await until(() => runner.store.read(run.id)?.endedAt != null);
    await runsEnded(root);
    expect(failed).toBe(3);
    expect(armed).toHaveBeenCalledTimes(1);
  });

  it('Given a run started here whose running record cannot be written, When the user cancels it, Then its command is stopped and it ends cancelled', async () => {
    const root = tempDir('cc-runner-tick-');
    const { runner } = watchedRunner(root);
    const write = runner.store.write.bind(runner.store);
    let failed = 0;
    vi.spyOn(runner.store, 'write').mockImplementation((meta) => {
      if (meta.status === 'running') {
        failed++;
        throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      }
      return write(meta);
    });
    const run = runner.start(noisy(['0', '30000']));
    await until(() => failed >= 2 && runner.store.readWrapper(run.id) !== null);
    expect(runner.store.read(run.id)!.status).toBe('queued');

    expect(runner.cancel(run.id)?.status).toBe('cancelled');
    await until(() => runner.store.read(run.id)?.endedAt != null);
    await runsEnded(root, 10_000);
    expect(runner.store.read(run.id)!.status).toBe('cancelled');
  });
});
