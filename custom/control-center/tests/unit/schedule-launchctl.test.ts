import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchctlPrint, parsePrintDisabled, ScheduleService, SCHEDULE_JOBS } from '../../server/system/schedule.js';
import { formatLocalMinute } from '../../web/lib/time.js';
import type { Exec } from '../../server/routes/system.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'launchctl');
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), 'utf8');

describe('launchctl print, parsed from captured real output', () => {
  it('reads a loaded but idle job: "not running" is the whole state and the job never exited', () => {
    expect(parseLaunchctlPrint(read('print-idle.txt'))).toEqual({ state: 'not running', lastExit: null });
  });

  it('reads the last exit code once the job has run', () => {
    expect(parseLaunchctlPrint(read('print-after-run.txt'))).toEqual({ state: 'not running', lastExit: 0 });
  });

  it('reads a non-zero exit code', () => {
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 78\n')).toEqual({ state: 'not running', lastExit: 78 });
  });

  it('finds disabled and enabled labels in print-disabled output', () => {
    const out = read('print-disabled.txt');
    expect(parsePrintDisabled(out, 'com.career-ops.immigration-watch')).toBe(false);
    expect(parsePrintDisabled(out, 'com.career-ops.upstream-sync')).toBe(true);
  });
});

describe('ScheduleService.readOne against launchctl output', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agents-'));
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
    expect(formatLocalMinute(s.nextFire!)).toBe('2026-10-04 08:00');
  });
});
