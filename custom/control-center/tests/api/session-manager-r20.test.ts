import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp } from '../helpers/app.js';
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

const call = (app: Awaited<ReturnType<typeof makeTestApp>>, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });

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

describe('session manager: a new session cancelled or deleted while its first turn prepares (R20-claude-L1-02)', () => {
  /** A token read held until released: the session sits queued with no turn, as during the CLI version probe. */
  function heldToken() {
    const gate: { release: (() => void) | null } = { release: null };
    const readToken = async () => {
      await new Promise<void>((resolve) => (gate.release = resolve));
      return FAKE_TOKEN;
    };
    return { gate, readToken };
  }
  async function untilHeld(gate: { release: (() => void) | null }): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!gate.release && Date.now() < deadline) await wait(20);
    expect(gate.release).not.toBeNull();
  }
  const queuedId = async (app: App): Promise<string> => {
    const list = (await call(app, 'GET', '/api/sessions')).json() as Array<{ id: string; status: string }>;
    expect(list.map((m) => m.status)).toEqual(['queued']);
    return list[0]!.id;
  };
  const sentinels = (app: App) => fs.readdirSync(path.join(app.cfg.dataRoot, 'reports')).filter((f) => f.endsWith('-RESERVED.md'));

  it('given a session queued before its first turn, when the user cancels it, then it ends cancelled and no Claude run starts', async () => {
    const token = heldToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const runsBefore = app.runner.store.list().length;
      const start = withScenario(scenarioFile(NO_REPORT), async () => {
        const pending = call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' });
        await untilHeld(token.gate);
        const id = await queuedId(app);
        const cancelled = await call(app, 'POST', `/api/sessions/${id}/cancel`, {});
        expect(cancelled.statusCode, cancelled.body).toBe(200);
        expect(cancelled.json().status).toBe('cancelled');
        token.gate.release!();
        return { id, res: await pending };
      });
      const { id, res } = await start;
      expect(res.json().status).toBe('cancelled');
      const { meta } = await settleOn(app, id);
      expect(meta.status).toBe('cancelled');
      expect(meta.turns).toEqual([]);
      expect(app.runner.store.list().length).toBe(runsBefore);
    } finally {
      await app.close();
    }
  });

  it('given a Batch evaluate session queued before its first turn, when the user cancels it, then its reserved report number goes back to the pool', async () => {
    const token = heldToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const before = sentinels(app);
      const fan = await withScenario(scenarioFile(NO_REPORT), async () => {
        const pending = call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r20-cancel-queued'] });
        await untilHeld(token.gate);
        const id = await queuedId(app);
        expect((await call(app, 'POST', `/api/sessions/${id}/cancel`, {})).statusCode).toBe(200);
        token.gate.release!();
        return (await pending).json();
      });
      const { meta } = await settleOn(app, fan.sessions[0].id);
      expect(meta).toMatchObject({ status: 'cancelled', reportNum: null, turns: [] });
      expect(sentinels(app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('given a session queued before its first turn, when the user deletes it, then the delete is refused with 409 and the turn still starts on the kept session', async () => {
    const token = heldToken();
    const app = await makeTestApp({}, { readToken: token.readToken });
    try {
      const { id, res } = await withScenario(scenarioFile(NO_REPORT), async () => {
        const pending = call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' });
        await untilHeld(token.gate);
        const id = await queuedId(app);
        const del = await call(app, 'DELETE', `/api/sessions/${id}`);
        expect(del.statusCode, del.body).toBe(409);
        token.gate.release!();
        return { id, res: await pending };
      });
      expect(res.statusCode, res.body).toBe(202);
      expect((await settleOn(app, id)).meta.turns).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('session manager: a turn whose run record vanished (HUNT follow-up, manager poll)', () => {
  it('given a Batch evaluate turn whose run folder is removed before the tracker sees it end, when the tracker polls, then the turn ends in error saying why and its report number goes back to the pool', async () => {
    // A slow poll, so the run ends and its folder goes (a runs prune, a manual delete) before the tracker reads it.
    const app = await makeTestApp({}, { sessionPollMs: 1500 });
    try {
      const reports = path.join(app.cfg.dataRoot, 'reports');
      const sentinels = () => fs.readdirSync(reports).filter((f) => f.endsWith('-RESERVED.md'));
      const before = sentinels();
      const fan = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r20-run-vanished'] })).json());
      const id = fan.sessions[0].id as string;
      const runId = fan.sessions[0].turns[0].runId as string;
      const deadline = Date.now() + 10_000;
      while (app.runner.store.read(runId)?.endedAt == null && Date.now() < deadline) await wait(20);
      fs.rmSync(app.runner.store.dirOf(runId), { recursive: true, force: true });
      const { meta } = await settleOn(app, id, 10_000);
      expect(meta.status).toBe('error');
      expect(String(meta.error)).toMatch(/run record/);
      expect(meta.reportNum).toBeNull();
      expect(meta.turns[0]!).toHaveProperty('endedAt', expect.any(String));
      expect(sentinels()).toEqual(before);
    } finally {
      await app.close();
    }
  }, 30_000);
});
