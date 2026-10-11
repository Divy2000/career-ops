import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

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
const sentinels = (app: App) => fs.readdirSync(path.join(app.cfg.dataRoot, 'reports')).filter((f) => f.endsWith('-RESERVED.md'));
const pad = (n: number) => String(n).padStart(3, '0');

describe('deleting a session that holds a reserved report number (R23-claude-L1-01)', () => {
  it('given a Batch evaluate session waiting for the user, when the user deletes it, then its reservation file is removed and the number goes back to the pool', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r23-delete-held'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      expect(sentinels(app)).toContain(`${pad(n)}-RESERVED.md`);

      const res = await call(app, 'DELETE', `/api/sessions/${id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect((await call(app, 'GET', `/api/sessions/${id}`)).statusCode).toBe(404);
      expect(sentinels(app)).not.toContain(`${pad(n)}-RESERVED.md`);

      const next = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r23-delete-next'] })).json());
      expect(next.reserved).toEqual([n]);
      await settleOn(app, next.sessions[0].id as string);
    } finally {
      await app.close();
    }
  });

  it('given a session waiting for the user that holds a number, when the user asks to release that number, then the refusal tells them to delete the ended session, which releases it', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r23-release-held'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      // Cancel does nothing for a session that is not running, so the advice must not stop at it.
      expect((await call(app, 'POST', `/api/sessions/${id}/cancel`)).json()).toMatchObject({ status: 'awaiting_user', reportNum: n });

      const refused = await call(app, 'POST', '/api/actions/pipeline.releaseReportNums', { params: { range: String(n) } });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toMatch(/delete/i);

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(sentinels(app)).not.toContain(`${pad(n)}-RESERVED.md`);
    } finally {
      await app.close();
    }
  });
});
