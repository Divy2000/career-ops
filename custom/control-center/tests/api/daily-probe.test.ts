import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, testConfig, type TestApp } from '../helpers/app.js';
import { DailyJobWatch, maybeFakeDailyProbe } from '../../server/system/daily.js';
import { EventBus } from '../../server/watch/bus.js';
import { execNoShell } from '../../server/routes/system.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { tempDir } from '../helpers/tmp.js';
import { configFromEnv } from '../../server/config.js';
import type { Exec } from '../../server/routes/system.js';

// The host reports the opposite of what the override says, so a pass proves the detector never asked the host.
const hostSays = (running: boolean): Exec => async (cmd) => (cmd === 'pgrep' ? { code: running ? 0 : 1, stdout: running ? '4242\n' : '', stderr: '' } : { code: 0, stdout: '', stderr: '' });

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
  it('ignores a real run-daily.sh process when the idle override is set', async () => {
    t = await makeTestApp({ fakeDaily: 'idle' }, { exec: hostSays(true), dailyPollMs: 30 });
    expect(await dailyRunning(t)).toBe(false);
  });
  it('reports running without a process when the running override is set', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 30 });
    expect(await dailyRunning(t)).toBe(true);
  });
  it('asks the host through pgrep when no override is set', async () => {
    t = await makeTestApp({}, { exec: hostSays(true), dailyPollMs: 30 });
    expect(await dailyRunning(t)).toBe(true);
  });
});

describe('the daily job probe on real processes', () => {
  // Real pgrep, but only the processes this test started count, so a daily job running on the host cannot change the result.
  const ownPgrep = (pids: number[]): Exec => async (cmd, args, opts) => {
    const r = await execNoShell(cmd, args, opts);
    const mine = r.stdout.split('\n').filter((p) => pids.includes(Number(p)));
    return { code: mine.length ? 0 : 1, stdout: mine.map((p) => `${p}\n`).join(''), stderr: r.stderr };
  };
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
  });
  const started = async (bin: string, args: string[]): Promise<number> => {
    const c = spawn(bin, args, { stdio: 'ignore' });
    children.push(c);
    await new Promise((r) => setTimeout(r, 200));
    return c.pid!;
  };

  it('does not count a process that only mentions run-daily.sh in its arguments, such as a Claude prompt about it', async () => {
    const pid = await started(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'Why did custom/immigration/run-daily.sh skip the rank step?']);
    const watch = new DailyJobWatch(ownPgrep([pid]), new EventBus());
    expect(await watch.runningNow()).toBe(false);
  });

  it('does not count a bash -c command line that only names run-daily.sh', async () => {
    const pid = await started('/bin/bash', ['-c', 'sleep 20; echo custom/immigration/run-daily.sh']);
    const watch = new DailyJobWatch(ownPgrep([pid]), new EventBus());
    expect(await watch.runningNow()).toBe(false);
  });

  it('counts bash running run-daily.sh, the way launchd and the lock re-exec start it', async () => {
    const script = path.join(tempDir('cc-daily-probe-'), 'custom', 'immigration', 'run-daily.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'sleep 20\n');
    const pid = await started('/bin/bash', [script]);
    const watch = new DailyJobWatch(ownPgrep([pid]), new EventBus());
    expect(await watch.runningNow()).toBe(true);
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
  const probe = (exec: Exec) => exec('pgrep', ['-f', 'custom/immigration/run-daily.sh'], { timeoutMs: 1000 });
  it('ignores fakeDaily on a config that is not NODE_ENV=test', async () => {
    const cfg = { ...testConfig(), nodeEnv: 'production', fakeDaily: 'running' as const };
    expect(await probe(maybeFakeDailyProbe(cfg, hostSays(false)))).toMatchObject({ code: 1 });
    expect(await probe(maybeFakeDailyProbe({ ...cfg, fakeDaily: 'idle' }, hostSays(true)))).toMatchObject({ code: 0 });
  });
  it('answers from fakeDaily on a NODE_ENV=test config and leaves other commands to the host exec', async () => {
    const cfg = { ...testConfig(), fakeDaily: 'running' as const };
    expect(await probe(maybeFakeDailyProbe(cfg, hostSays(false)))).toMatchObject({ code: 0 });
    const other = await maybeFakeDailyProbe(cfg, async () => ({ code: 7, stdout: 'host', stderr: '' }))('ls', [], { timeoutMs: 1000 });
    expect(other).toMatchObject({ code: 7, stdout: 'host' });
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
