import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, testConfig, type TestApp } from '../helpers/app.js';
import { DailyJobWatch, dailyPidfile, dailyPidfileProbe, maybeFakeDailyProbe } from '../../server/system/daily.js';
import { EventBus } from '../../server/watch/bus.js';
import { execNoShell } from '../../server/routes/system.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { tempDir } from '../helpers/tmp.js';
import { configFromEnv, DEFAULT_CODE_ROOT } from '../../server/config.js';
import type { Exec } from '../../server/routes/system.js';

// The host reports the opposite of what the override says, so a pass proves the detector never asked the host.
// "Running" on the host is the job's pidfile naming a process whose command line is bash running run-daily.sh.
const JOB_COMMAND = '/bin/bash /checkout/custom/immigration/run-daily.sh';
const hostSays = (running: boolean): Exec => async (cmd) => (cmd === 'ps' && running ? { code: 0, stdout: `${JOB_COMMAND}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' });
const writePidfile = (dataRoot: string, pid: number | string) => {
  fs.mkdirSync(path.dirname(dailyPidfile(dataRoot)), { recursive: true });
  fs.writeFileSync(dailyPidfile(dataRoot), `${pid}\n`);
};

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function dailyRunning(app: TestApp): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 150));
  return (await app.app.inject({ method: 'GET', url: '/api/system/daily', headers: app.authed })).json().running;
}

describe('daily job detection', () => {
  it('ignores a running daily job on the host when the idle override is set', async () => {
    t = await makeTestApp({ fakeDaily: 'idle' }, { exec: hostSays(true), dailyPollMs: 30 });
    writePidfile(t.cfg.dataRoot, 4242);
    expect(await dailyRunning(t)).toBe(false);
  });
  it('reports running without a process when the running override is set', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 30 });
    expect(await dailyRunning(t)).toBe(true);
  });
  it('asks the host about the pid in the job pidfile when no override is set', async () => {
    t = await makeTestApp({}, { exec: hostSays(true), dailyPollMs: 30 });
    writePidfile(t.cfg.dataRoot, 4242);
    expect(await dailyRunning(t)).toBe(true);
  });
});

describe('the daily job probe on real processes', () => {
  // Real ps; the pidfile sits in this test's own data root, so a daily job running on the host cannot change the result.
  const children: ChildProcess[] = [];
  afterEach(() => {
    // Detached children lead their own process group: the job's lockf and its re-exec'd bash go with them.
    for (const c of children.splice(0)) {
      try {
        process.kill(-c.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
  const started = async (bin: string, args: string[], opts: { cwd?: string; argv0?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> => {
    const c = spawn(bin, args, { stdio: 'ignore', detached: true, ...opts });
    children.push(c);
    await new Promise((r) => setTimeout(r, 200));
    return c.pid!;
  };
  const probeOf = (dataRoot: string) => new DailyJobWatch(dailyPidfileProbe(dataRoot, execNoShell), new EventBus());
  const scriptAt = (dir: string, name = 'run-daily.sh') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'sleep 20\n');
    return path.join(dir, name);
  };

  it('does not count a pidfile naming a process that only mentions run-daily.sh in its arguments, such as a Claude prompt about it', async () => {
    const data = tempDir('cc-daily-data-');
    writePidfile(data, await started(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'Why did custom/immigration/run-daily.sh skip the rank step?']));
    expect(await probeOf(data).runningNow()).toBe(false);
  });

  it('does not count a pidfile naming a bash -c command line that only names run-daily.sh', async () => {
    const data = tempDir('cc-daily-data-');
    writePidfile(data, await started('/bin/bash', ['-c', 'sleep 20; echo custom/immigration/run-daily.sh']));
    expect(await probeOf(data).runningNow()).toBe(false);
  });

  it('counts the pidfile naming bash running run-daily.sh, the way launchd and the lock re-exec start it', async () => {
    const data = tempDir('cc-daily-data-');
    writePidfile(data, await started('/bin/bash', [scriptAt(path.join(tempDir('cc daily probe-'), 'custom', 'immigration'))]));
    expect(await probeOf(data).runningNow()).toBe(true);
  });

  it('does not count a stale pidfile whose process is gone, or one that holds no pid', async () => {
    const data = tempDir('cc-daily-data-');
    const gone = spawn('/bin/bash', ['-c', 'exit 0']);
    await new Promise((r) => gone.on('exit', r));
    writePidfile(data, gone.pid!);
    expect(await probeOf(data).runningNow()).toBe(false);
    writePidfile(data, 'not a pid');
    expect(await probeOf(data).runningNow()).toBe(false);
  });

  it('does not count another project\'s run-daily.sh that is running, since it wrote no pidfile into this data root', async () => {
    const data = tempDir('cc-daily-data-');
    await started('/bin/bash', [scriptAt(path.join(tempDir('cc-daily-other-'), 'x'))]);
    expect(await probeOf(data).runningNow()).toBe(false);
  });

  // run-daily.sh re-execs itself under macOS's /usr/bin/lockf; on a host without it the script cannot hold its lock.
  describe.skipIf(!fs.existsSync('/usr/bin/lockf'))('the real run-daily.sh, typed with a relative path (macOS: needs /usr/bin/lockf)', () => {
    // A checkout holding the real script and its data-root resolver, with a Keychain lookup that hangs: the job holds its
    // lock and has written its pidfile, and never gets to a step.
    function world() {
      const T = fs.realpathSync(tempDir('cc-daily-world-'));
      const root = path.join(T, 'root');
      const data = path.join(T, 'data');
      const bin = path.join(T, 'bin');
      fs.mkdirSync(path.join(root, 'custom', 'immigration'), { recursive: true });
      fs.mkdirSync(data);
      fs.mkdirSync(bin);
      fs.copyFileSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'immigration', 'run-daily.sh'), path.join(root, 'custom', 'immigration', 'run-daily.sh'));
      fs.copyFileSync(path.join(DEFAULT_CODE_ROOT, 'path-resolver.mjs'), path.join(root, 'path-resolver.mjs'));
      fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
      const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: T, CAREER_OPS_ROOT: data };
      return { root, data, env };
    }
    const runningSoon = async (data: string) => {
      for (let i = 0; i < 50 && !fs.existsSync(dailyPidfile(data)); i++) await new Promise((r) => setTimeout(r, 100));
      return probeOf(data).runningNow();
    };

    it('counts a run started from the checkout as bash custom/immigration/run-daily.sh', async () => {
      const w = world();
      await started('/bin/bash', ['custom/immigration/run-daily.sh'], { cwd: w.root, argv0: 'bash', env: w.env });
      expect(await runningSoon(w.data)).toBe(true);
    });

    it('counts a run started from custom/immigration as bash run-daily.sh', async () => {
      const w = world();
      await started('/bin/bash', ['run-daily.sh'], { cwd: path.join(w.root, 'custom', 'immigration'), argv0: 'bash', env: w.env });
      expect(await runningSoon(w.data)).toBe(true);
    });
  });
});

describe('a daily run with no done line', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  // The server's local calendar date: only today's log can belong to a job that runs now.
  const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const before = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const YESTERDAY = `${before.getFullYear()}-${pad(before.getMonth() + 1)}-${pad(before.getDate())}`;
  const OLD = '2001-01-02';
  const unfinished = (date: string) => `=== ${date} 08:00:00 start\n--- 08:00:01 policy watch\n`;
  async function statuses(app: TestApp, dailyDates = [TODAY, YESTERDAY, OLD]) {
    const logs = path.join(app.cfg.dataRoot, 'data', 'immigration', 'logs');
    for (const date of dailyDates) fs.writeFileSync(path.join(logs, `${date}.log`), unfinished(date));
    const weeklyDir = path.join(app.cfg.dataRoot, 'data', 'upstream-sync');
    fs.mkdirSync(weeklyDir, { recursive: true });
    for (const date of [TODAY, YESTERDAY, OLD]) fs.writeFileSync(path.join(weeklyDir, `${date}.log`), unfinished(date));
    const get = async (url: string) => (await app.app.inject({ method: 'GET', url, headers: app.authed })).json();
    return {
      todayChip: (await get('/api/immigration/overview')).dailyLog.status,
      latest: (await get('/api/schedule/logs')).latest.status,
      today: (await get(`/api/schedule/logs/${TODAY}`)).status ?? 'none',
      yesterday: (await get(`/api/schedule/logs/${YESTERDAY}`)).status,
      old: (await get(`/api/schedule/logs/${OLD}`)).status,
      weeklyToday: (await get(`/api/schedule/logs/${TODAY}?job=upstream-sync`)).status,
      weeklyYesterday: (await get(`/api/schedule/logs/${YESTERDAY}?job=upstream-sync`)).status,
      weeklyOld: (await get(`/api/schedule/logs/${OLD}?job=upstream-sync`)).status,
    };
  }
  it('reads interrupted on the Today chip and in the log browser when run-daily.sh is not running', async () => {
    t = await makeTestApp({ fakeDaily: 'idle' }, { exec: hostSays(true), dailyPollMs: 60_000 });
    expect(await statuses(t)).toEqual({ todayChip: 'interrupted', latest: 'interrupted', today: 'interrupted', yesterday: 'interrupted', old: 'interrupted', weeklyToday: 'running', weeklyYesterday: 'interrupted', weeklyOld: 'interrupted' });
  });
  it('reads running for today\'s log while run-daily.sh runs, even before the next poll; yesterday\'s unfinished run is interrupted once today\'s run has started (one run holds the lock), and an older one too', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 60_000 });
    expect(await statuses(t)).toEqual({ todayChip: 'running', latest: 'running', today: 'running', yesterday: 'interrupted', old: 'interrupted', weeklyToday: 'running', weeklyYesterday: 'interrupted', weeklyOld: 'interrupted' });
  });
  it('reads running for yesterday\'s log while run-daily.sh runs and no run has started today (a run can cross midnight)', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 60_000 });
    fs.rmSync(path.join(t.cfg.dataRoot, 'data', 'immigration', 'logs', `${TODAY}.log`), { force: true });
    expect(await statuses(t, [YESTERDAY, OLD])).toMatchObject({ todayChip: 'running', latest: 'running', today: 'none', yesterday: 'running', old: 'interrupted' });
  });
  it('reads running for yesterday\'s log while run-daily.sh runs when today\'s log has no start line yet', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 60_000 });
    const logs = path.join(t.cfg.dataRoot, 'data', 'immigration', 'logs');
    fs.writeFileSync(path.join(logs, `${TODAY}.log`), 'note: written before the start line\n');
    expect(await statuses(t, [YESTERDAY, OLD])).toMatchObject({ yesterday: 'running', old: 'interrupted' });
  });
});

describe('the overview route', () => {
  it('counts digest staleness from the local date, as the daily job dates its logs', async () => {
    t = await makeTestApp({ fakeDaily: 'idle' }, { exec: hostSays(false), dailyPollMs: 60_000 });
    // vitest runs in America/Los_Angeles: 20:00 local on 2026-10-04 is 03:00 UTC on 2026-10-05.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 4, 20, 0));
      const overview = (await t.app.inject({ method: 'GET', url: '/api/immigration/overview', headers: t.authed })).json();
      expect(overview.digest).toMatchObject({ latestDate: '2026-10-02', staleDays: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('maybeFakeDailyProbe', () => {
  const host = (running: boolean) => async () => running;
  it('ignores fakeDaily on a config that is not NODE_ENV=test', async () => {
    const cfg = { ...testConfig(), nodeEnv: 'production', fakeDaily: 'running' as const };
    expect(await maybeFakeDailyProbe(cfg, host(false))()).toBe(false);
    expect(await maybeFakeDailyProbe({ ...cfg, fakeDaily: 'idle' }, host(true))()).toBe(true);
  });
  it('answers from fakeDaily on a NODE_ENV=test config without asking the host', async () => {
    const cfg = { ...testConfig(), fakeDaily: 'running' as const };
    expect(await maybeFakeDailyProbe(cfg, host(false))()).toBe(true);
    expect(await maybeFakeDailyProbe({ ...cfg, fakeDaily: 'idle' }, host(true))()).toBe(false);
    expect(await maybeFakeDailyProbe(testConfig(), host(true))()).toBe(true);
  });
});

describe('CC_FAKE_DAILY', () => {
  afterEach(() => vi.unstubAllEnvs());
  const env = (nodeEnv: string | undefined, value = 'idle') => {
    // configFromEnv reads the required variables from process.env and the rest from its argument.
    for (const [k, v] of Object.entries({ CC_DATA_ROOT: '/x', CC_GUARD_DIR: '/y', CC_TOKEN: 't', CC_SESSION_SECRET: 's' })) vi.stubEnv(k, v);
    return { CC_PUBLIC_PORT: '4317', CC_FAKE_DAILY: value, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) };
  };
  it('is honored only under NODE_ENV=test', () => {
    expect(configFromEnv(env('test')).fakeDaily).toBe('idle');
    expect(configFromEnv(env('test', 'running')).fakeDaily).toBe('running');
    expect(configFromEnv(env('production')).fakeDaily).toBeUndefined();
    expect(configFromEnv(env(undefined)).fakeDaily).toBeUndefined();
  });
  it('rejects a value that is neither idle nor running', () => {
    expect(() => configFromEnv(env('test', 'maybe'))).toThrow(/CC_FAKE_DAILY must be idle or running/);
  });
});
