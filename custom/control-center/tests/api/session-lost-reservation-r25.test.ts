import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: App, id: string, timeoutMs = 30_000): Promise<{ meta: { status: string; reportNum: number | null } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const NO_REPORT = { events: [INIT, { type: 'result', subtype: 'success', result: 'The posting needs a login; I could not read it.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }] };
async function withScenario<T>(scenario: unknown, fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);
/** The stale-sentinel GC removed the session's sentinel and a new reservation claimed the number again at `at`. */
const reclaim = (app: App, n: number, at: number) =>
  fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(at).toISOString() }));
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(25);
  }
}

describe('a session whose reserved report number was collected and claimed again (R25-claude-L2-01)', () => {
  it('given a waiting Batch evaluate session whose number another reservation now holds, when the user deletes it, then the other reservation is left alone', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r25-delete-lost'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      reclaim(app, n, Date.now() + 1000);

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('given a waiting Batch evaluate session that still owns its number, when the user deletes it, then its reservation is released', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r25-delete-owned'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('given an ended session credited the report that holds its number and whose sentinel is gone, when the user deletes it, then nothing claims the number was lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 73);
      app.sessions.store.setCreditedReport(meta.id, { num: 73, file: '073-acme-2026-10-11.md' });

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('given a running session with no run record after a restart whose number another reservation now holds, when the server reconciles, then the other reservation is left alone and the session no longer holds the number', async () => {
    const releases: string[][] = [];
    const recording: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) releases.push(args);
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, { exec: recording });
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.beginTurn(meta.id, { runId: 'r25-gone-lost', userText: 'x' });
      app.sessions.store.setStatus(meta.id, 'running');
      app.sessions.store.setReportNum(meta.id, 71);
      reclaim(app, 71, Date.parse(meta.createdAt) + 60_000);

      app.sessions.reconcile();
      expect(app.sessions.read(meta.id)).toMatchObject({ status: 'error', reportNum: null });
      // A release is started synchronously by reconcile, so none recorded by now means none was started.
      expect(releases).toEqual([]);
      expect(fs.existsSync(sentinelPath(app, 71))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('given a running session with no run record after a restart that still owns its number, when the server reconciles, then its reservation is released', async () => {
    const app = await makeTestApp();
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.beginTurn(meta.id, { runId: 'r25-gone-owned', userText: 'x' });
      app.sessions.store.setStatus(meta.id, 'running');
      app.sessions.store.setReportNum(meta.id, 72);
      reclaim(app, 72, Date.parse(meta.createdAt) - 60_000);

      app.sessions.reconcile();
      expect(app.sessions.read(meta.id)).toMatchObject({ status: 'error', reportNum: null });
      await until(() => !fs.existsSync(sentinelPath(app, 72)));
    } finally {
      await app.close();
    }
  });

  it('given a waiting session whose first release attempt fails while the GC collects its sentinel and another reservation claims the number, when the user deletes it, then the retry leaves the other reservation alone', async () => {
    let app: App | null = null;
    let n = 0;
    const releases: string[][] = [];
    const flaky: Exec = async (cmd, args, opts) => {
      if (!args.includes('--release')) return execNoShell(cmd, args, opts);
      releases.push(args);
      if (releases.length === 1) {
        reclaim(app!, n, Date.now() + 1000);
        return { code: 1, stdout: '', stderr: 'tracker lock busy' };
      }
      return execNoShell(cmd, args, opts);
    };
    app = await makeTestApp({}, { exec: flaky });
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app!, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r25-delete-retry'] })).json());
      const id = fan.sessions[0].id as string;
      n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(releases).toHaveLength(1);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('given a running session with no run record after a restart whose sentinel cannot be read, when the server reconciles, then the session is still settled holding no number', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.beginTurn(meta.id, { runId: 'r25-gone-unreadable', userText: 'x' });
      app.sessions.store.setStatus(meta.id, 'running');
      app.sessions.store.setReportNum(meta.id, 74);
      fs.mkdirSync(sentinelPath(app, 74));

      expect(() => app.sessions.reconcile()).not.toThrow();
      expect(app.sessions.read(meta.id)).toMatchObject({ status: 'error', reportNum: null });
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});
