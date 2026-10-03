import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';

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
