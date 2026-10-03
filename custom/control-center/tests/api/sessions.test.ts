import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: Record<string, unknown> = {}) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];

async function settle(id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await get(`/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return body as { meta: Record<string, unknown> & { status: string; turns: Array<{ runId: string; userText: string }>; claudeSessionId: string }; events: Array<{ seq: number; event: Record<string, unknown> & { type: string } }> };
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}

type Settled = { meta: Record<string, unknown> & { status: string; turns: Array<{ n: number; runId: string; userText: string }>; claudeSessionId: string; forkPending?: boolean; totals: { costUsd: number; tokens: number } }; events: Array<{ seq: number; event: Record<string, unknown> & { type: string } }> };
const call = (app: TestApp, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: TestApp, id: string, timeoutMs = 30_000): Promise<Settled> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return body as Settled;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
async function until(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(50);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const result = (text: string, cost: number) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false });
const SLOW = { events: [INIT, delta('before '), { __sleep: 1500 }, delta('after'), result('before after', 0.07)] };
function scenarioFile(scenario: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scenario-')), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  return file;
}
/** The fake CLI reads FAKE_CLAUDE_SCENARIO from the env captured when the run starts. */
async function withScenario<T>(file: string, fn: () => Promise<T>): Promise<T> {
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}

describe('Claude sessions', () => {
  it('evaluate: streams events, the scripted report write passes the hook, the tracker merges and the honesty gate marks done', async () => {
    const res = await post('/api/sessions', { mode: 'oferta', target: { type: 'url', value: 'https://jobs.example.com/synthetic/8' }, prompt: 'Evaluate https://jobs.example.com/synthetic/8' });
    expect(res.statusCode).toBe(202);
    const { id } = res.json();
    const { meta, events } = await settle(id);
    const types = events.map((e) => e.event.type);
    expect(types).toContain('session.init');
    expect(types).toContain('text.delta');
    expect(types.filter((x) => x === 'tool.use')).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const evaluation = events.find((e) => e.event.type === 'evaluation')!.event as unknown as { reports: Array<{ num: number; file: string; score: number }> };
    expect(evaluation.reports).toEqual([{ num: 8, file: '008-synthetic-corp.md', score: 4.1 }]);
    expect(meta.status).toBe('done');
    expect(meta.lastReason).toMatch(/008-synthetic-corp\.md created/);
    expect(meta.totals).toEqual({ costUsd: 0.12, tokens: 1900 });
    expect(meta.filesChanged).toEqual(expect.arrayContaining(['reports/008-synthetic-corp.md', 'batch/tracker-additions/008-synthetic-corp.tsv']));
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'reports', '008-synthetic-corp.md'))).toBe(true);
    const merge = events.filter((e) => e.event.type === 'tool.result').at(-1)!.event as unknown as { ok: boolean; summary: string };
    expect(merge.ok, merge.summary).toBe(true);
    const tracker = (await get('/api/tracker')).json();
    expect(tracker.rows.some((r: { company: string }) => r.company === 'Synthetic Corp')).toBe(true);
    const run = (await get(`/api/runs/${meta.turns[0]!.runId}`)).json();
    expect(run.meta.claude).toBe(true);
    expect(run.meta.cmd.args.join(' ')).not.toContain(FAKE_TOKEN);
    expect(run.meta.cmd.args).toEqual(expect.arrayContaining(['--session-id', meta.claudeSessionId, '--permission-mode', 'dontAsk']));
  });

  it('a write to data/blacklist.md is blocked by the hook and surfaces as permission.denied; in-scope writes still land', async () => {
    const { id } = (await post('/api/sessions', { mode: 'pdf', target: { type: 'app', value: '1' }, prompt: 'Render the CV' })).json();
    const { meta, events } = await settle(id);
    const denied = events.filter((e) => e.event.type === 'permission.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]!.event).toMatchObject({ tool: 'Write' });
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'blacklist.md'), 'utf8')).not.toContain('Synthetic Corp');
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'output', 'synthetic-corp-cv.html'))).toBe(true);
    expect(meta.status).toBe('done');
    expect(meta.turns[0]).toMatchObject({ permissionDenials: 1 });
    expect(meta.filesChanged).toEqual(['output/synthetic-corp-cv.html']);
  });

  it('a turn that ends with a question waits for the user; the next turn resumes the same Claude session id', async () => {
    const { id } = (await post('/api/sessions', { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' })).json();
    const first = await settle(id);
    expect(first.meta.status).toBe('awaiting_user');
    expect(first.meta.lastReason).toMatch(/question/);
    const turn2 = await post(`/api/sessions/${id}/turns`, { prompt: 'Globex Payments' });
    expect(turn2.statusCode).toBe(202);
    expect((await post(`/api/sessions/${id}/turns`, { prompt: 'too early' })).statusCode).toBe(409);
    const second = await settle(id);
    expect(second.meta.status).toBe('done');
    expect(second.meta.turns).toHaveLength(2);
    const inits = second.events.filter((e) => e.event.type === 'session.init').map((e) => e.event.claudeSessionId);
    expect(inits).toEqual([first.meta.claudeSessionId, first.meta.claudeSessionId]);
    const run2 = (await get(`/api/runs/${second.meta.turns[1]!.runId}`)).json();
    expect(run2.meta.cmd.args).toEqual(expect.arrayContaining(['--resume', first.meta.claudeSessionId]));
    expect(run2.meta.cmd.args).not.toContain('--session-id');
    expect(run2.meta.cmd.args[1]).toBe('Globex Payments');
    const fork = await post(`/api/sessions/${id}/fork`, { prompt: 'Try a different angle' });
    expect(fork.statusCode).toBe(202);
    expect(fork.json().claudeSessionId).toBe(first.meta.claudeSessionId);
    expect(fork.json().forkedFrom).toBe(id);
    const forked = await settle(fork.json().id);
    const runF = (await get(`/api/runs/${forked.meta.turns[0]!.runId}`)).json();
    expect(runF.meta.cmd.args).toContain('--fork-session');
  });

  it('apply without a probed Playwright MCP runs without the MCP config and the fill turn carries the edited answers', async () => {
    expect((await get('/api/sessions/engine')).json().playwrightAvailable).toBe(false);
    const { id } = (await post('/api/sessions', { mode: 'apply', target: { type: 'url', value: 'https://jobs.example.com/acme/123' }, prompt: 'Draft answers' })).json();
    const first = await settle(id);
    expect(first.meta.status).toBe('done');
    const env = first.events.find((e) => e.event.type === 'envelope')!.event as unknown as { kind: string; payload: { fields: Array<{ id: string }> } };
    expect(env.kind).toBe('answers');
    expect(env.payload.fields.map((f) => f.id)).toEqual(['full_name', 'why_us', 'sponsorship']);
    const run = (await get(`/api/runs/${first.meta.turns[0]!.runId}`)).json();
    expect(run.meta.cmd.args).not.toContain('--mcp-config');
    const answers = JSON.stringify({ fields: [{ id: 'why_us', value: 'Edited answer' }] });
    await post(`/api/sessions/${id}/turns`, { prompt: `Fill the real form with these confirmed answers: ${answers}` });
    const second = await settle(id);
    expect(second.meta.turns[1]!.userText).toContain('Edited answer');
  });

  it('cancel kills the turn and leaves the session cancelled', async () => {
    const { id } = (await post('/api/sessions', { mode: 'calibrate', prompt: 'Calibrate' })).json();
    const deadline = Date.now() + 15_000;
    while ((await get(`/api/sessions/${id}`)).json().events.length < 2) {
      if (Date.now() > deadline) throw new Error('session never started streaming');
      await wait(100);
    }
    expect((await post(`/api/sessions/${id}/cancel`)).statusCode).toBe(200);
    const { meta } = await settle(id);
    expect(meta.status).toBe('cancelled');
    expect((await get(`/api/runs/${meta.turns[0]!.runId}`)).json().meta.status).toBe('cancelled');
  });

  it('fan-out reserves report numbers first, hands each session its number and no reservation is left behind', async () => {
    const res = await post('/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/9', 'https://jobs.example.com/synthetic/10'] });
    expect(res.statusCode).toBe(202);
    const { sessions, reserved } = res.json();
    expect(reserved).toEqual([9, 10]);
    expect(sessions.map((s: { reportNum: number }) => s.reportNum)).toEqual([9, 10]);
    const done = await Promise.all(sessions.map((s: { id: string }) => settle(s.id)));
    expect(done.map((d) => d.meta.status)).toEqual(['done', 'done']);
    const names = fs.readdirSync(path.join(t.cfg.dataRoot, 'reports'));
    expect(names).toEqual(expect.arrayContaining(['009-synthetic-corp.md', '010-synthetic-corp.md']));
    expect(names.filter((n) => /^(009|010)-RESERVED/.test(n))).toEqual([]);
    const run = (await get(`/api/runs/${done[0]!.meta.turns[0]!.runId}`)).json();
    expect(run.meta.cmd.args.join('\n')).toMatch(/Report number 9 is reserved/);
  });

  it('a missing Keychain token fails the session loudly without spawning', async () => {
    const other = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    try {
      const res = await other.app.inject({ method: 'POST', url: '/api/sessions', headers: other.authedWrite, payload: { mode: 'oferta', prompt: 'x' } });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: 'error', error: expect.stringMatching(/Keychain/) });
      expect((await other.app.inject({ method: 'GET', url: '/api/runs', headers: other.authed })).json()).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('a session child never sees the server CC_ internals, only the guard variables set for it', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CC_TOKEN: 'leak-token', CC_SESSION_SECRET: 'leak-secret', CC_DATA_ROOT: '/x', CC_GUARD_DIR: '/g', FAKE_CLAUDE_REPORT_ENV: '1' });
    try {
      const { id } = (await post('/api/sessions', { mode: 'deep', prompt: 'Research' })).json();
      const { events } = await settle(id);
      const line = events.map((e) => e.event).find((e) => e.type === 'stderr' && String(e.text).startsWith('fake-claude-env: '));
      expect(String(line?.text).replace('fake-claude-env: ', '').split(',')).toEqual(['CC_MODE', 'CC_POLICY_FILE', 'CC_POLICY_SHA256', 'CC_SESSION_DIR', 'CC_TURN_DIR']);
      // Only the claude process holds the OAuth token; its Bash and hook children do not.
      expect(events.map((e) => e.event).find((e) => e.type === 'stderr' && String(e.text).startsWith('fake-claude-token: '))?.text).toBe('fake-claude-token: self=present children=absent');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('a turn still queued when the server restarts ends with a clear error instead of hanging', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-guard-'));
    const a = await makeTestApp({ dataRoot, guardRoot });
    const req = (app: TestApp, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload });
    try {
      expect((await req(a, 'PUT', '/api/settings/app', { claudeConcurrency: 1 })).statusCode).toBe(200);
      const slowId: string = (await req(a, 'POST', '/api/sessions', { mode: 'calibrate', prompt: 'Calibrate' })).json().id;
      const queued = (await req(a, 'POST', '/api/sessions', { mode: 'deep', prompt: 'Research' })).json();
      expect(queued.status).toBe('running');
      expect(a.runner.queuedIds()).toEqual([queued.turns[0].runId]);
      await a.close();
      const b = await makeTestApp({ dataRoot, guardRoot });
      try {
        const deadline = Date.now() + 15_000;
        let meta = (await req(b, 'GET', `/api/sessions/${queued.id}`)).json().meta;
        while (meta.status === 'running' && Date.now() < deadline) {
          await wait(100);
          meta = (await req(b, 'GET', `/api/sessions/${queued.id}`)).json().meta;
        }
        expect(meta).toMatchObject({ status: 'error', error: expect.stringMatching(/queued when the server restarted/) });
        expect((await req(b, 'GET', `/api/runs/${queued.turns[0].runId}`)).json().meta.status).toBe('lost');
        expect((await req(b, 'POST', `/api/sessions/${slowId}/cancel`, {})).statusCode).toBe(200);
      } finally {
        await b.close();
      }
    } finally {
      await a.close().catch(() => undefined);
    }
  });

  it('two concurrent sends on one session: one starts a turn, the other gets 409', async () => {
    const slow = await makeTestApp({}, { readToken: async () => (await wait(150), FAKE_TOKEN) });
    try {
      const { id } = (await call(slow, 'POST', '/api/sessions', { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' })).json();
      expect((await settleOn(slow, id)).meta.status).toBe('awaiting_user');
      const [one, two] = await Promise.all([call(slow, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Globex Payments' }), call(slow, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Initech Cloud' })]);
      expect([one.statusCode, two.statusCode].sort()).toEqual([202, 409]);
      const { meta } = await settleOn(slow, id);
      expect(meta.turns.map((x) => x.n)).toEqual([1, 2]);
      const runs = (await call(slow, 'GET', '/api/runs')).json() as Array<{ params: { sessionId?: string } }>;
      expect(runs.filter((r) => r.params.sessionId === id)).toHaveLength(2);
    } finally {
      await slow.close();
    }
  });

  it('a fork adopts the Claude session id minted by --fork-session, and its next turn resumes that id, never the source', async () => {
    const { id } = (await post('/api/sessions', { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' })).json();
    const source = await settle(id);
    const fork = (await post(`/api/sessions/${id}/fork`, { prompt: 'Try a different angle' })).json();
    const forked = await settle(fork.id);
    expect(forked.meta.claudeSessionId).not.toBe(source.meta.claudeSessionId);
    expect(forked.meta.forkPending).toBe(false);
    expect((await post(`/api/sessions/${fork.id}/turns`, { prompt: 'Globex Payments' })).statusCode).toBe(202);
    const again = await settle(fork.id);
    const args = (await get(`/api/runs/${again.meta.turns[1]!.runId}`)).json().meta.cmd.args as string[];
    expect(args).toEqual(expect.arrayContaining(['--resume', forked.meta.claudeSessionId]));
    expect(args).not.toContain('--fork-session');
    expect(args).not.toContain(source.meta.claudeSessionId);
    expect((await get(`/api/sessions/${id}`)).json().meta.claudeSessionId).toBe(source.meta.claudeSessionId);
  });

  it('a fork whose first turn failed before spawning still forks the source on the retry, never --session-id with the source id', async () => {
    let tokenMissing = false;
    const app = await makeTestApp({}, { readToken: async () => { if (tokenMissing) throw new Error('Keychain item career-ops-claude-token not found'); return FAKE_TOKEN; } });
    try {
      const { id } = (await call(app, 'POST', '/api/sessions', { mode: 'interview/practice', target: { type: 'app', value: '3' }, prompt: 'Practice' })).json();
      const source = await settleOn(app, id);
      tokenMissing = true;
      const fork = (await call(app, 'POST', `/api/sessions/${id}/fork`, { prompt: 'Try a different angle' })).json();
      expect(fork).toMatchObject({ status: 'error', turns: [], forkPending: true });
      tokenMissing = false;
      expect((await call(app, 'POST', `/api/sessions/${fork.id}/turns`, { prompt: 'Try a different angle' })).statusCode).toBe(202);
      const retried = await settleOn(app, fork.id);
      const args = (await call(app, 'GET', `/api/runs/${retried.meta.turns[0]!.runId}`)).json().meta.cmd.args as string[];
      expect(args).toEqual(expect.arrayContaining(['--resume', source.meta.claudeSessionId, '--fork-session']));
      expect(args).not.toContain('--session-id');
      expect(retried.meta.claudeSessionId).not.toBe(source.meta.claudeSessionId);
      expect(retried.meta.forkPending).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('the honesty gate never credits a session with a report another session wrote while it ran', async () => {
    const h = await makeTestApp();
    try {
      expect((await call(h, 'PUT', '/api/settings/app', { claudeConcurrency: 4 })).statusCode).toBe(200);
      const silent = scenarioFile({ events: [INIT, { __sleep: 1200 }, result('Evaluation complete.', 0.02)] });
      const [a, aReserved] = await withScenario(silent, async () => [(await call(h, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate A' })).json(), (await call(h, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate A2', reportNum: 50 })).json()]);
      const b = (await call(h, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate B' })).json();
      const bReserved = (await call(h, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate B2', reportNum: 51 })).json();
      const [ra, raReserved, rb, rbReserved] = (await Promise.all([a, aReserved, b, bReserved].map((x) => settleOn(h, x.id)))) as [Settled, Settled, Settled, Settled];
      expect(rb.meta.status).toBe('done');
      expect(rbReserved.meta.status).toBe('done');
      expect(ra.meta).toMatchObject({ status: 'awaiting_user', lastReason: expect.stringMatching(/no new report/) });
      expect(raReserved.meta).toMatchObject({ status: 'awaiting_user', lastReason: expect.stringMatching(/no new report/) });
      expect(ra.events.some((e) => e.event.type === 'evaluation')).toBe(false);
      expect(raReserved.events.some((e) => e.event.type === 'evaluation')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('reservations go back to the pool when the token read fails and when a fan-out stops halfway', async () => {
    const reserved = (app: TestApp) => fs.readdirSync(path.join(app.cfg.dataRoot, 'reports')).filter((n) => /^\d+-RESERVED\.md$/.test(n) && n !== '005-RESERVED.md');
    const urls = ['https://jobs.example.com/synthetic/21', 'https://jobs.example.com/synthetic/22', 'https://jobs.example.com/synthetic/23'];
    const noToken = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    try {
      const res = await call(noToken, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls });
      expect(res.statusCode).toBe(202);
      expect(res.json().reserved).toEqual([8, 9, 10]);
      expect(res.json().sessions.map((x: { status: string; reportNum: number | null }) => [x.status, x.reportNum])).toEqual([['error', null], ['error', null], ['error', null]]);
      expect(reserved(noToken)).toEqual([]);
    } finally {
      await noToken.close();
    }
    const half = await makeTestApp();
    try {
      const original = half.sessions.start.bind(half.sessions);
      let calls = 0;
      vi.spyOn(half.sessions, 'start').mockImplementation(async (input) => {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
        return original(input);
      });
      expect((await call(half, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls })).statusCode).toBe(502);
      const first = half.sessions.list().find((x) => x.reportNum === 8 || x.target.value === urls[0])!;
      expect((await settleOn(half, first.id)).meta.status).toBe('done');
      expect(reserved(half)).toEqual([]);
    } finally {
      await half.close();
    }
  });

  it('a server handover resumes the transcript where the old process stopped: no duplicate events, cost counted once', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-guard-'));
    const a = await makeTestApp({ dataRoot, guardRoot });
    let b: TestApp | null = null;
    try {
      const { id } = await withScenario(scenarioFile(SLOW), async () => (await call(a, 'POST', '/api/sessions', { mode: 'deep', prompt: 'Research' })).json());
      await until(() => a.sessions.store.readEvents(id).some((e) => e.event.type === 'text.delta'));
      await a.close();
      b = await makeTestApp({ dataRoot, guardRoot }, { deferReconcile: true });
      const seen = b.sessions.store.readEvents(id).length;
      await wait(400);
      expect(b.sessions.store.readEvents(id)).toHaveLength(seen);
      b.activate();
      const { meta, events } = await settleOn(b, id);
      const types = events.map((e) => e.event.type);
      expect(types.filter((x) => x === 'session.init')).toHaveLength(1);
      expect(events.filter((e) => e.event.type === 'text.delta').map((e) => e.event.text)).toEqual(['before ', 'after']);
      expect(types.filter((x) => x === 'turn.done')).toHaveLength(1);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(meta).toMatchObject({ status: 'done', totals: { costUsd: 0.07, tokens: 15 } });
    } finally {
      await b?.close();
      await a.close().catch(() => undefined);
    }
  });

  it('two servers finishing the same turn count its cost and release its report number once', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-guard-'));
    const releases: string[] = [];
    const counting: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) releases.push(args[args.indexOf('--release') + 1]!);
      return execNoShell(cmd, args, opts);
    };
    const a = await makeTestApp({ dataRoot, guardRoot }, { exec: counting });
    let b: TestApp | null = null;
    try {
      const { id } = await withScenario(scenarioFile(SLOW), async () => (await call(a, 'POST', '/api/sessions', { mode: 'deep', prompt: 'Research', reportNum: 60 })).json());
      await until(() => a.sessions.store.readEvents(id).some((e) => e.event.type === 'text.delta'));
      // The overlap the handover prevents, forced: a second server reconciles while the first still tracks.
      b = await makeTestApp({ dataRoot, guardRoot }, { exec: counting });
      await settleOn(b, id);
      await wait(600);
      const meta = b.sessions.read(id)!;
      expect(meta.totals).toEqual({ costUsd: 0.07, tokens: 15 });
      expect(meta.reportNum).toBeNull();
      expect(releases.filter((r) => r === '60')).toHaveLength(1);
      expect(b.sessions.store.readEvents(id).filter((e) => e.event.type === 'status' && e.event.status === 'done')).toHaveLength(1);
    } finally {
      await b?.close();
      await a.close().catch(() => undefined);
    }
  });

  it('rejects unknown modes and bad bodies, deletes finished sessions and records remembered facts', async () => {
    expect((await post('/api/sessions', { mode: 'nope', prompt: 'x' })).statusCode).toBe(404);
    expect((await post('/api/sessions', { mode: 'oferta' })).statusCode).toBe(400);
    expect((await get('/api/sessions/nope')).statusCode).toBe(404);
    const { id } = (await post('/api/sessions', { mode: 'deep', prompt: 'Research' })).json();
    await settle(id);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: t.authedWrite, payload: {} })).statusCode).toBe(200);
    expect((await get(`/api/sessions/${id}`)).statusCode).toBe(404);
    expect((await post('/api/memory', { fact: 'Prefers remote roles' })).json()).toEqual({ result: 'ok' });
    expect((await post('/api/memory', { fact: 'Prefers remote roles' })).json()).toEqual({ result: 'deduped' });
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'modes', '_profile.md'), 'utf8')).toContain('- Prefers remote roles');
  });
});
