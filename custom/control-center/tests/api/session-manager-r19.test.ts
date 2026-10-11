import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, FAKE_TOKEN, type TestApp } from '../helpers/app.js';
import { BusyError } from '../../server/claude/manager.js';
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

describe('session manager: replaying an original request never duplicates a live evaluation (R19 review)', () => {
  function flakyToken() {
    const state = { ok: false };
    return { state, readToken: async () => (state.ok ? FAKE_TOKEN : Promise.reject(new Error('Keychain item career-ops-claude-token not found'))) };
  }
  const SLOW = { events: [INIT, { __sleep: 3000 }, result('still reading', 0.01)] };

  for (const via of ['reply', 'fork'] as const) {
    it(`given a failed-before-spawn evaluation and a newer live one of the same posting, when the user tries a ${via} of the failed one, then it is refused with 409`, async () => {
      const token = flakyToken();
      const app = await makeTestApp({}, { readToken: token.readToken });
      try {
        const url = `https://jobs.example.com/synthetic/r19-dup-${via}`;
        const body = { mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` };
        const { id } = (await call(app, 'POST', '/api/sessions', body)).json();
        expect((await settleOn(app, id)).meta.status).toBe('error');
        token.state.ok = true;
        const live = await withScenario(scenarioFile(SLOW), async () => (await call(app, 'POST', '/api/sessions', body)).json());
        const runsBefore = app.runner.store.list().length;
        const res = await call(app, 'POST', via === 'reply' ? `/api/sessions/${id}/turns` : `/api/sessions/${id}/fork`, { prompt: 'retry' });
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toContain(live.id);
        expect(app.runner.store.list().length).toBe(runsBefore);
        await settleOn(app, live.id);
      } finally {
        await app.close();
      }
    });
  }

  it('given a reply replaying a failed evaluation that has not reached its run yet, when the same posting is started again, then the start is refused with 409', async () => {
    let release!: () => void;
    const state = { mode: 'fail' as 'fail' | 'hold' };
    const readToken = async () => {
      if (state.mode === 'fail') throw new Error('Keychain item career-ops-claude-token not found');
      await new Promise<void>((resolve) => (release = resolve));
      return FAKE_TOKEN;
    };
    const app = await makeTestApp({}, { readToken });
    try {
      const url = 'https://jobs.example.com/synthetic/r19-dup-window';
      const body = { mode: 'oferta', target: { type: 'url', value: url }, prompt: `Evaluate this job posting following the mode file: ${url}` };
      const { id } = (await call(app, 'POST', '/api/sessions', body)).json();
      expect((await settleOn(app, id)).meta.status).toBe('error');
      state.mode = 'hold';
      await withScenario(scenarioFile(NO_REPORT), async () => {
        const reply = call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'retry' });
        const deadline = Date.now() + 10_000;
        while (!release && Date.now() < deadline) await wait(20);
        expect((await call(app, 'POST', '/api/sessions', body)).statusCode).toBe(409);
        release();
        expect((await reply).statusCode).toBe(202);
      });
      await settleOn(app, id);
    } finally {
      await app.close();
    }
  });

  it('given a source whose cancelled first turn is still stopping and never started a conversation, when it is forked, then the fork starts only once that run has ended', async () => {
    const app = await makeTestApp();
    try {
      const stubborn = scenarioFile({ events: [{ __ignoreSigterm: true }, { __sleep: 8000 }, result('late', 0.01)] });
      const { id, turns } = await withScenario(stubborn, async () => (await call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' })).json());
      const srcRun = turns[0].runId as string;
      const deadline = Date.now() + 10_000;
      while (app.runner.store.read(srcRun)?.childPid == null && Date.now() < deadline) await wait(50);
      expect((await call(app, 'POST', `/api/sessions/${id}/cancel`, {})).statusCode).toBe(200);
      const res = await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/fork`, { prompt: 'again' }));
      expect(res.statusCode, res.body).toBe(202);
      const endedAt = app.runner.store.read(srcRun)!.endedAt;
      expect(endedAt).not.toBeNull();
      const forkRun = app.runner.store.read(res.json().turns[0].runId)!;
      expect(Date.parse(forkRun.createdAt)).toBeGreaterThanOrEqual(Date.parse(endedAt!));
      await settleOn(app, res.json().id);
    } finally {
      await app.close();
    }
  }, 30_000);
});

describe('session manager: fork busy guard (R19-claude-L3-01)', () => {
  it('given a session running a turn, when it is forked, then the fork is refused with 409 and no second run starts', async () => {
    const app = await makeTestApp();
    try {
      const slow = scenarioFile({ events: [INIT, { __sleep: 3000 }, result('done', 0.01)] });
      const { id } = await withScenario(slow, async () => (await call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' })).json());
      const runsBefore = app.runner.store.list().length;
      const res = await call(app, 'POST', `/api/sessions/${id}/fork`, { prompt: 'and fork' });
      expect(res.statusCode, res.body).toBe(409);
      expect(app.runner.store.list().length).toBe(runsBefore);
      await settleOn(app, id);
    } finally {
      await app.close();
    }
  });

  it('given a session starting a reply turn, when it is forked, then the fork is refused; and a reply while a fork of it starts is refused', async () => {
    const app = await makeTestApp();
    try {
      const { id } = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions', { mode: 'devchat', target: { type: 'none', value: null }, prompt: 'look around' })).json());
      await settleOn(app, id);
      await withScenario(scenarioFile(NO_REPORT), async () => {
        const reply = app.sessions.send(id, 'go on');
        await expect(app.sessions.fork(id, 'fork now')).rejects.toBeInstanceOf(BusyError);
        await reply;
        await settleOn(app, id);
        const fork = app.sessions.fork(id, 'fork now');
        await expect(app.sessions.send(id, 'reply now')).rejects.toBeInstanceOf(BusyError);
        await settleOn(app, (await fork).id);
      });
    } finally {
      await app.close();
    }
  });
});

describe('session manager: a waiting evaluation keeps its reserved number (R19-claude-L3-02)', () => {
  const sentinel = (app: TestApp, num: number) => path.join(app.cfg.dataRoot, 'reports', `${String(num).padStart(3, '0')}-RESERVED.md`);

  it('given its sentinel was garbage-collected and the number handed to another evaluation, when the user replies, then the reply is not told the lost number', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r19-l3-a'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      // verify-pipeline's 4h GC deletes the sentinel; the next reservation takes the same number.
      fs.rmSync(sentinel(app, n));
      const other = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r19-l3-b'] })).json());
      expect(other.reserved).toEqual([n]);
      await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' }));
      const { meta } = await settleOn(app, id);
      expect(runArgs(app, meta.turns[1]!.runId).preamble).not.toContain(`Report number ${n} is reserved`);
      expect(meta.reportNum).not.toBe(n);
      // The number it got instead stays its own on the next reply.
      const fresh = meta.reportNum!;
      expect(fresh).toEqual(expect.any(Number));
      await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'once more' }));
      const third = (await settleOn(app, id)).meta;
      expect(runArgs(app, third.turns[2]!.runId).preamble).toContain(`Report number ${fresh} is reserved`);
      expect(third.reportNum).toBe(fresh);
      await settleOn(app, other.sessions[0].id);
    } finally {
      await app.close();
    }
  });

  it('given a lost number whose replacement cannot be recorded, when the turn fails before spawn, then the replacement goes back to the pool and the next reply runs', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r19-l3-d'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      await settleOn(app, id);
      fs.rmSync(sentinel(app, n));
      const reserved = () => fs.readdirSync(path.join(app.cfg.dataRoot, 'reports')).filter((f) => f.endsWith('-RESERVED.md'));
      const before = reserved();
      // reservation.json cannot be written: a folder stands in its place.
      fs.mkdirSync(path.join(app.sessions.store.guardDirOf(id), 'reservation.json'));
      await call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' });
      const { meta } = await settleOn(app, id);
      expect(meta.status).toBe('error');
      expect(meta.reportNum).toBeNull();
      expect(reserved()).toEqual(before);
      fs.rmdirSync(path.join(app.sessions.store.guardDirOf(id), 'reservation.json'));
      await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'and again' }));
      const next = (await settleOn(app, id)).meta;
      expect(next.status).toBe('awaiting_user');
      expect(runArgs(app, next.turns.at(-1)!.runId).preamble).not.toMatch(/Report number \d+ is reserved/);
    } finally {
      await app.close();
    }
  });

  it('given its sentinel is still its own, when the user replies, then the number is kept and the sentinel refreshed so a 4h GC does not free it mid-turn', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario(scenarioFile(NO_REPORT), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r19-l3-c'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      await settleOn(app, id);
      const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
      fs.utimesSync(sentinel(app, n), old, old);
      await withScenario(scenarioFile(NO_REPORT), async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' }));
      const { meta } = await settleOn(app, id);
      expect(runArgs(app, meta.turns[1]!.runId).preamble).toContain(`Report number ${n} is reserved`);
      expect(meta.reportNum).toBe(n);
      expect(Date.now() - fs.statSync(sentinel(app, n)).mtimeMs).toBeLessThan(60 * 60 * 1000);
    } finally {
      await app.close();
    }
  });
});
