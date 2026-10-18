import { describe, expect, it } from 'vitest';
import { testConfig } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { holdPeerLock, settlesWithin } from '../helpers/peer-lock.js';
import { fakeLaunchdExec } from '../../server/system/fake-launchd.js';
import { ScheduleService, SCHEDULE_JOBS } from '../../server/system/schedule.js';

// R35-srv-core-X-03: a schedule save was serialized only by a map inside one server process. During a blue/green
// handover the other child's save of the same job could interleave its enable/disable, bootout, bootstrap and restore
// steps with this one's, leaving launchd with a schedule neither save showed.
describe('schedule saves across two server processes (R35-srv-core-X-03)', () => {
  it('given another process saving the same job, when this process saves it, then no launchctl step runs until the other save lets the lock go', async () => {
    const cfg = testConfig();
    const agentsDir = tempDir('cc-r35-agents-');
    const fake = fakeLaunchdExec();
    const svc = new ScheduleService({ exec: fake.exec, agentsDir, uid: 501, codeRoot: cfg.codeRoot, dataRoot: cfg.dataRoot });
    const job = SCHEDULE_JOBS.find((j) => j.kind === 'daily')!;
    const peer = await holdPeerLock(cfg.codeRoot, svc.plistPath(job));
    try {
      const save = svc.write(job, { hour: 7, minute: 15, weekday: null, enabled: true });
      expect(await settlesWithin(save, 500)).toBe(false);
      expect(fake.calls).toEqual([]);
      await peer.release(null);
      const r = await save;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(fake.loaded.has(job.label)).toBe(true);
    } finally {
      peer.stop();
    }
  });
});
