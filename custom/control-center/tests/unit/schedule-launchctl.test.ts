import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchctlPrint, parsePrintDisabled, ScheduleService, SCHEDULE_JOBS } from '../../server/system/schedule.js';
import { formatLocalMinute, describeLastExit } from '../../web/lib/time.js';
import type { Exec } from '../../server/routes/system.js';
import { tempDir } from '../helpers/tmp.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'launchctl');
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');

describe('launchctl print, parsed from captured real output', () => {
  it('reads a loaded but idle job: "not running" is the whole state and the job never exited', () => {
    expect(parseLaunchctlPrint(read('print-idle.txt'))).toEqual({ state: 'not running', lastExit: null, lastSignal: null, runs: 0 });
  });

  it('reads the last exit code and run count once the job has run', () => {
    expect(parseLaunchctlPrint(read('print-after-run.txt'))).toEqual({ state: 'not running', lastExit: 0, lastSignal: null, runs: 3 });
  });

  it('reads a non-zero exit code', () => {
    expect(parseLaunchctlPrint('\tstate = not running\n\truns = 1\n\tlast exit code = 78\n')).toMatchObject({ lastExit: 78, runs: 1 });
  });

  it('reads the terminating signal of a job that launchd killed, which has no exit code', () => {
    // Hand-written from launchd's documented format; no real signal capture exists on this machine.
    expect(parseLaunchctlPrint('\tstate = not running\n\truns = 2\n\tlast terminating signal = Killed: 9\n')).toEqual({ state: 'not running', lastExit: null, lastSignal: 'Killed: 9', runs: 2 });
  });

  it('finds disabled and enabled labels in print-disabled output', () => {
    const out = read('print-disabled.txt');
    expect(parsePrintDisabled(out, 'com.career-ops.immigration-watch')).toBe(false);
    expect(parsePrintDisabled(out, 'com.career-ops.upstream-sync')).toBe(true);
  });
});

describe('ScheduleService.readOne against launchctl output', () => {
  const agentsDir = tempDir('cc-agents-');
  const job = SCHEDULE_JOBS[0]!;
  fs.writeFileSync(path.join(agentsDir, `${job.label}.plist`), '<plist/>');
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'plutil') return { code: 0, stdout: JSON.stringify({ Label: job.label, ProgramArguments: ['/bin/bash', `/code/${job.script}`], StartCalendarInterval: { Hour: 8, Minute: 0 } }), stderr: '' };
    if (args[0] === 'print') return { code: 0, stdout: read('print-idle.txt'), stderr: '' };
    return { code: 0, stdout: read('print-disabled.txt'), stderr: '' };
  };

  it('reports the job as loaded and idle with an instant that is 08:00 in local time', async () => {
    const now = new Date(2026, 9, 3, 9, 30);
    const svc = new ScheduleService({ exec, agentsDir, uid: 501, codeRoot: '/code', dataRoot: '/data', now: () => now });
    const s = await svc.readOne(job);
    expect(s).toMatchObject({ loaded: true, state: 'not running', lastExit: null, disabled: false });
    // 08:00 Pacific daylight time is 15:00 UTC; the UTC slice of this string is what the page used to show.
    expect(s.nextFire).toBe('2026-10-04T15:00:00.000Z');
    expect(formatLocalMinute(s.nextFire!)).toBe('2026-10-04 08:00');
  });
});

describe('describeLastExit', () => {
  const base = { lastExit: null, lastSignal: null, runs: null };
  it('says never ran only when the job has no runs or never exited', () => {
    expect(describeLastExit({ ...base, runs: 0 })).toBe('never ran');
    expect(describeLastExit({ ...base })).toBe('never ran');
  });
  it('shows the exit code, including zero', () => {
    expect(describeLastExit({ ...base, runs: 3, lastExit: 0 })).toBe('0');
    expect(describeLastExit({ ...base, runs: 3, lastExit: 78 })).toBe('78');
  });
  it('shows a terminating signal as a failure', () => {
    expect(describeLastExit({ ...base, runs: 2, lastSignal: 'Killed: 9' })).toBe('killed by signal (Killed: 9)');
  });
  it('does not claim it never ran when it ran but left no exit information', () => {
    expect(describeLastExit({ ...base, runs: 4 })).toBe('unknown (ran 4 times)');
  });
});
