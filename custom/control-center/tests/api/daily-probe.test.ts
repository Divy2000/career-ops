import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers/app.js';
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
