import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { SessionStore, sessionsDir } from '../../server/claude/sessions.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
type Settled = { meta: Record<string, unknown> & { id: string; status: string; reportNum: number | null; conversationStarted?: boolean; turns: Array<{ n: number; runId: string }> } };
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
const NO_REPORT = { events: [INIT, result('The posting needs a login; I could not read it.', 0.01)] };
const SLOW = { events: [INIT, { __sleep: 3000 }, result('still reading', 0.01)] };
const evaluate = (url: string) => ({ mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` });

const call = (app: Awaited<ReturnType<typeof makeTestApp>>, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });

describe('session list: one unreadable session folder (R20-claude-L3-01)', () => {
  it('given a session whose meta.json is truncated, when the server starts and the Sessions list loads, then that session is skipped and every other one is listed', async () => {
    const dataRoot = copyFixtureRoot();
    const store = new SessionStore(dataRoot, tempDir('cc-r20-guard-'));
    const good = store.create({ mode: 'devchat', policyClass: 'devchat', target: { type: 'none', value: null }, model: null });
    store.setStatus(good.id, 'done');
    const bad = store.create({ mode: 'devchat', policyClass: 'devchat', target: { type: 'none', value: null }, model: null });
    fs.writeFileSync(path.join(sessionsDir(dataRoot), bad.id, 'meta.json'), '');
    const app = await makeTestApp({ dataRoot });
    try {
      const res = await call(app, 'GET', '/api/sessions');
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as Array<{ id: string }>).map((m) => m.id)).toEqual([good.id]);
    } finally {
      await app.close();
    }
  });
});

describe('session manager: resuming an uncredited evaluation never duplicates a live one (R20-claude-L1-01, R20-claude-L3-02)', () => {
  for (const via of ['reply', 'fork'] as const) {
    it(`given an evaluation that started its conversation and then failed, and a newer live one of the same posting, when the user tries a ${via} of the failed one, then it is refused with 409`, async () => {
      const app = await makeTestApp();
      try {
        const url = `https://jobs.example.com/synthetic/r20-resume-${via}`;
        const failing = scenarioFile({ events: [INIT], exitCode: 1 });
        const { id } = await withScenario(failing, async () => (await call(app, 'POST', '/api/sessions', evaluate(url))).json());
        const failed = (await settleOn(app, id)).meta;
        expect(failed.status).toBe('error');
        expect(failed.conversationStarted).toBe(true);
        const live = await withScenario(scenarioFile(SLOW), async () => (await call(app, 'POST', '/api/sessions', evaluate(url))).json());
        const runsBefore = app.runner.store.list().length;
        const res = await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', via === 'reply' ? `/api/sessions/${id}/turns` : `/api/sessions/${id}/fork`, { prompt: 'retry' }));
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toContain(live.id);
        expect(app.runner.store.list().length).toBe(runsBefore);
        await settleOn(app, live.id);
      } finally {
        await app.close();
      }
    });
  }

  it('given an evaluation waiting for the user with a conversation and no report yet, when it is forked, then the fork is refused with 409: the source still evaluates the posting', async () => {
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r20-fork-awaiting';
      const { id } = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions', evaluate(url))).json());
      const src = (await settleOn(app, id)).meta;
      expect(src.status).toBe('awaiting_user');
      expect(src.conversationStarted).toBe(true);
      const runsBefore = app.runner.store.list().length;
      const res = await call(app, 'POST', `/api/sessions/${id}/fork`, { prompt: 'try another angle' });
      expect(res.statusCode, res.body).toBe(409);
      expect(app.runner.store.list().length).toBe(runsBefore);
    } finally {
      await app.close();
    }
  });

  it('given an evaluation waiting for the user with a conversation and no other live one, when the user replies, then the reply runs', async () => {
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r20-reply-own';
      const { id } = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions', evaluate(url))).json());
      expect((await settleOn(app, id)).meta.status).toBe('awaiting_user');
      const res = await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'here is the text' }));
      expect(res.statusCode, res.body).toBe(202);
      expect((await settleOn(app, id)).meta.turns).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
