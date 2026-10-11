import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_TOKEN, makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
type Settled = { meta: Record<string, unknown> & { id: string; status: string; reportNum: number | null; turns: Array<{ n: number; runId: string }> } };
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: App, id: string, timeoutMs = 30_000): Promise<Settled> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return body as Settled;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string, cost: number) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false });
const NO_REPORT = { events: [INIT, result('The posting needs a login; I could not read it.', 0.01)] };
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

describe('session manager: a later turn cancelled while it prepares (R21-claude-L1-01)', () => {
  /** A token read that passes until `hold` is set, then waits for release: a later turn sits in preparation, as during the version probe or re-reservation. */
  function heldToken() {
    const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const readToken = async () => {
      if (gate.hold) await new Promise<void>((resolve) => (gate.release = resolve));
      return FAKE_TOKEN;
    };
    return { gate, readToken };
  }
  async function untilHeld(gate: { release: (() => void) | null }): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!gate.release && Date.now() < deadline) await wait(20);
    expect(gate.release).not.toBeNull();
  }
  const sentinels = (app: App) => fs.readdirSync(path.join(app.cfg.dataRoot, 'reports')).filter((f) => f.endsWith('-RESERVED.md'));

  it('given a session with an ended turn, when the user cancels the next reply while it prepares, then it ends cancelled and no Claude run starts', async () => {
    const token = heldToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const id = await withScenario(NO_REPORT, async () => {
        const res = await call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' });
        expect(res.statusCode, res.body).toBe(202);
        const id = res.json().id as string;
        await settleOn(app, id);
        return id;
      });
      const runsBefore = app.runner.store.list().length;
      token.gate.hold = true;
      const reply = await withScenario(NO_REPORT, async () => {
        const pending = call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'and now this' });
        await untilHeld(token.gate);
        const cancelled = await call(app, 'POST', `/api/sessions/${id}/cancel`, {});
        expect(cancelled.statusCode, cancelled.body).toBe(200);
        expect(cancelled.json().status).toBe('cancelled');
        token.gate.release!();
        return pending;
      });
      expect(reply.json().status).toBe('cancelled');
      const { meta } = await settleOn(app, id);
      expect(meta.status).toBe('cancelled');
      expect(meta.turns).toHaveLength(1);
      expect(app.runner.store.list().length).toBe(runsBefore);
      // The session is left consistent: the next reply runs.
      token.gate.hold = false;
      await withScenario(NO_REPORT, async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' }));
      const next = (await settleOn(app, id)).meta;
      expect(next.status).toBe('done');
      expect(next.turns).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('given a Batch evaluate session waiting for the user, when its next reply is cancelled while it prepares, then the session keeps its reserved report number for the retried reply', async () => {
    const token = heldToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r21-cancel-later'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      const held = sentinels(app);
      token.gate.hold = true;
      await withScenario(NO_REPORT, async () => {
        const pending = call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' });
        await untilHeld(token.gate);
        expect((await call(app, 'POST', `/api/sessions/${id}/cancel`, {})).statusCode).toBe(200);
        token.gate.release!();
        return pending;
      });
      const { meta } = await settleOn(app, id);
      expect(meta).toMatchObject({ status: 'cancelled', reportNum: n });
      expect(meta.turns).toHaveLength(1);
      expect(sentinels(app)).toEqual(held);
    } finally {
      await app.close();
    }
  });
});
