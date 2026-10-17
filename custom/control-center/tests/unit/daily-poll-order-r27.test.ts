import { describe, expect, it } from 'vitest';
import { DailyJobWatch } from '../../server/system/daily.js';
import { EventBus } from '../../server/watch/bus.js';

function deferredProbe() {
  const pending: Array<(running: boolean) => void> = [];
  const probe = () => new Promise<boolean>((resolve) => pending.push(resolve));
  return { probe, pending };
}

describe('DailyJobWatch poll ordering (R27-srv-core-X-01)', () => {
  it('given an older poll still waiting, when a newer poll answers stopped first, then the older answer does not overwrite it', async () => {
    const { probe, pending } = deferredProbe();
    const watch = new DailyJobWatch(probe, new EventBus(), 60_000);
    const older = watch.poll();
    const now = watch.runningNow();
    expect(pending.length).toBe(2);
    pending[1]!(false);
    expect(await now).toBe(false);
    pending[0]!(true);
    await older;
    expect(watch.status().running).toBe(false);
  });

  it('given an older poll waiting, when runningNow is asked, then it answers from a probe started after the call', async () => {
    const { probe, pending } = deferredProbe();
    const watch = new DailyJobWatch(probe, new EventBus(), 60_000);
    const older = watch.poll();
    const now = watch.runningNow();
    pending[0]!(true);
    await older;
    await Promise.resolve();
    await Promise.resolve();
    expect(pending.length).toBe(2);
    pending[1]!(false);
    expect(await now).toBe(false);
    expect(watch.status().running).toBe(false);
  });
});
