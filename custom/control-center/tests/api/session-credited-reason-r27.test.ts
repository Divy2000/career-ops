import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: App, id: string, turns: number, timeoutMs = 30_000): Promise<{ meta: { status: string; reportNum: number | null; lastReason?: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status) && body.meta.turns.length === turns && body.meta.turns.at(-1).endedAt) return body;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false });
const REPORT = '# Evaluation: Acme\n\n**Date:** 2026-10-17\n**Score:** 3.9/5\n**URL:** https://jobs.example.com/synthetic/r27-l202\n\n## A) Role Summary\nx\n';

describe('the reason a later turn gives for its report number (R27-claude-L2-02)', () => {
  it('given a Batch evaluate session whose silent first turn wrote the report under its number, when the reply turn ends done, then the reason says the report holds the number', async () => {
    const app = await makeTestApp();
    const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
    fs.writeFileSync(file, JSON.stringify({
      events: [INIT, { __write: { path: '{{DATA_ROOT}}/reports/{{REPORT_NUM}}-acme-2026-10-17.md', content: REPORT } }, result('')],
      resume: [INIT, result('The report is written.')],
    }));
    process.env.FAKE_CLAUDE_SCENARIO = file;
    try {
      const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r27-l202'] })).json();
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id, 1)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Go on.' })).statusCode).toBe(202);
      const { meta } = await settleOn(app, id, 2);
      expect(meta).toMatchObject({ status: 'done', reportNum: null });
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} is now held by the report`));
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  }, 30_000);

  it('given a waiting Batch evaluate session whose credited report the user deleted and whose number another reservation claimed, when the reply turn ends, then the other reservation is left alone', async () => {
    const app = await makeTestApp();
    const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
    fs.writeFileSync(file, JSON.stringify({
      events: [INIT, { __write: { path: '{{DATA_ROOT}}/reports/{{REPORT_NUM}}-acme-2026-10-17.md', content: REPORT } }, result('')],
      resume: [INIT, result('The report is written.')],
    }));
    process.env.FAKE_CLAUDE_SCENARIO = file;
    try {
      const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r27-l202-deleted'] })).json();
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id, 1)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      const reports = path.join(app.cfg.dataRoot, 'reports');
      const pad = String(n).padStart(3, '0');
      fs.rmSync(path.join(reports, `${pad}-acme-2026-10-17.md`));
      fs.writeFileSync(path.join(reports, `${pad}-RESERVED.md`), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(Date.now() + 1000).toISOString() }));

      expect((await call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Go on.' })).statusCode).toBe(202);
      await settleOn(app, id, 2);
      expect(fs.existsSync(path.join(reports, `${pad}-RESERVED.md`))).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  }, 30_000);
});
