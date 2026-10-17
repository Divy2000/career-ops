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
async function settleOn(app: App, id: string, timeoutMs = 30_000): Promise<{ meta: { status: string; reportNum: number | null; lastReason?: string } }> {
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
  const file = path.join(tempDir('cc-r28-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);
const reportPath = (app: App, file: string) => path.join(app.cfg.dataRoot, 'reports', file);
/** The stale-sentinel GC removed the session's sentinel and a new reservation claimed the number again at `at`. */
const reclaim = (app: App, n: number, at: number) =>
  fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(at).toISOString() }));

describe('a credited report that holds its number (R27-mgr-rev-01)', () => {
  it('given a waiting session credited a report that was renamed since and whose sentinel is gone, when the user deletes it, then nothing claims the number was lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 74);
      app.sessions.store.setCreditedReport(meta.id, { num: 74, file: '074-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(reportPath(app, '074-acme-corp-2026-10-11.md'), '# Acme Corp\n');

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('given a waiting session whose credited report was deleted and whose sentinel is gone, when the user deletes it, then the number reads as lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 75);
      app.sessions.store.setCreditedReport(meta.id, { num: 75, file: '075-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/report number 75 was already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

describe('a release that checks ownership only before it runs (R27-mgr-rev-03)', () => {
  it('given a waiting session that owns its number, when the GC collects the sentinel and another reservation claims it after the check but before the release runs, then the other reservation is left alone', async () => {
    let app: App | null = null;
    let n = 0;
    let raced = false;
    const racing: Exec = async (cmd, args, opts) => {
      if (args.includes('--release') && !raced) {
        raced = true;
        reclaim(app!, n, Date.now() + 1000);
      }
      return execNoShell(cmd, args, opts);
    };
    app = await makeTestApp({}, { exec: racing });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app!, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-release-race'] })).json());
      const id = fan.sessions[0].id as string;
      n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(raced).toBe(true);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelPath(app, n), 'utf8')).token).toBe('someone-else');
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

