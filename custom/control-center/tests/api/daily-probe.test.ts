import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, testConfig, type TestApp } from '../helpers/app.js';
import { maybeFakeDailyProbe } from '../../server/system/daily.js';
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

describe('a daily run with no done line', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  // The server's local calendar date: only today's log can belong to a job that runs now.
  const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const OLD = '2001-01-02';
  const unfinished = (date: string) => `=== ${date} 08:00:00 start\n--- 08:00:01 policy watch\n`;
  async function statuses(app: TestApp) {
    const logs = path.join(app.cfg.dataRoot, 'data', 'immigration', 'logs');
    for (const date of [TODAY, OLD]) fs.writeFileSync(path.join(logs, `${date}.log`), unfinished(date));
    const weeklyDir = path.join(app.cfg.dataRoot, 'data', 'upstream-sync');
    fs.mkdirSync(weeklyDir, { recursive: true });
    for (const date of [TODAY, OLD]) fs.writeFileSync(path.join(weeklyDir, `${date}.log`), unfinished(date));
    const get = async (url: string) => (await app.app.inject({ method: 'GET', url, headers: app.authed })).json();
    return {
      todayChip: (await get('/api/immigration/overview')).dailyLog.status,
      latest: (await get('/api/schedule/logs')).latest.status,
      today: (await get(`/api/schedule/logs/${TODAY}`)).status,
      old: (await get(`/api/schedule/logs/${OLD}`)).status,
      weeklyToday: (await get(`/api/schedule/logs/${TODAY}?job=upstream-sync`)).status,
      weeklyOld: (await get(`/api/schedule/logs/${OLD}?job=upstream-sync`)).status,
    };
  }
  it('reads interrupted on the Today chip and in the log browser when run-daily.sh is not running', async () => {
    t = await makeTestApp({ fakeDaily: 'idle' }, { exec: hostSays(true), dailyPollMs: 60_000 });
    expect(await statuses(t)).toEqual({ todayChip: 'interrupted', latest: 'interrupted', today: 'interrupted', old: 'interrupted', weeklyToday: 'running', weeklyOld: 'interrupted' });
  });
  it('reads running for today\'s log while run-daily.sh runs, even before the next poll, and interrupted for an older one', async () => {
    t = await makeTestApp({ fakeDaily: 'running' }, { exec: hostSays(false), dailyPollMs: 60_000 });
    expect(await statuses(t)).toEqual({ todayChip: 'running', latest: 'running', today: 'running', old: 'interrupted', weeklyToday: 'running', weeklyOld: 'interrupted' });
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
