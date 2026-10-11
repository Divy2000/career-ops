import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, FAKE_TOKEN, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type Settled = { meta: Record<string, unknown> & { status: string; reportNum: number | null; turns: Array<{ n: number; runId: string; userText: string }> } };
const call = (app: TestApp, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: TestApp, id: string, timeoutMs = 30_000): Promise<Settled> {
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
function scenarioFile(scenario: unknown): string {
  const file = path.join(tempDir('cc-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  return file;
}
async function withScenario<T>(file: string, fn: () => Promise<T>): Promise<T> {
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
/** The prompt a turn's run gave the CLI (the argument after --) and its preamble. */
function runArgs(app: TestApp, runId: string): { message: string; preamble: string } {
  const args = app.runner.store.read(runId)!.cmd.args;
  return { message: args.at(-1)!, preamble: args[args.indexOf('--append-system-prompt') + 1]! };
}
const NO_REPORT = { events: [INIT, result('The posting needs a login; I could not read it.', 0.01)] };

describe('session manager: a first turn that never started (R19-claude-L1-01)', () => {
  /** A token read that fails until `ok` is set: the first turn fails before any Claude process starts. */
  function flakyToken() {
    const state = { ok: false };
    return { state, readToken: async () => (state.ok ? FAKE_TOKEN : Promise.reject(new Error('Keychain item career-ops-claude-token not found'))) };
  }

  it('given an evaluation whose first turn failed before spawn, when the user replies, then Claude gets the original request with the reply', async () => {
    const token = flakyToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const url = 'https://jobs.example.com/synthetic/r19-l1';
      const started = await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` });
      const { id } = started.json();
      expect((await settleOn(app, id)).meta.status).toBe('error');
      token.state.ok = true;
      const res = await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'retry' }));
      expect(res.statusCode, res.body).toBe(202);
      const { meta } = await settleOn(app, id);
      const { message } = runArgs(app, meta.turns[0]!.runId);
      expect(message).toContain(url);
      expect(message).toContain('retry');
    } finally {
      await app.close();
    }
  });

  it('given a session whose first turn failed before spawn, when the user forks it, then the fork gets the original request with the new prompt', async () => {
    const token = flakyToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const url = 'https://jobs.example.com/synthetic/r19-l1-fork';
      const { id } = (await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` })).json();
      expect((await settleOn(app, id)).meta.status).toBe('error');
      token.state.ok = true;
      const res = await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/fork`, { prompt: 'try again' }));
      expect(res.statusCode, res.body).toBe(202);
      const { meta } = await settleOn(app, res.json().id);
      const { message } = runArgs(app, meta.turns[0]!.runId);
      expect(message).toContain(url);
      expect(message).toContain('try again');
    } finally {
      await app.close();
    }
  });
});
