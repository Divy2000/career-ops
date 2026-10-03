import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = (await get(`/api/runs/${id}`)).json().meta;
    if (!['queued', 'running'].includes(meta.status)) return meta;
    if (Date.now() > deadline) throw new Error(`run ${id} still ${meta.status}`);
    await wait(100);
  }
}

describe('action registry', () => {
  it('lists actions with cost, resources and a JSON schema for params', async () => {
    const res = await get('/api/actions');
    expect(res.statusCode).toBe(200);
    const setStatus = res.json().find((a: { id: string }) => a.id === 'tracker.setStatus');
    expect(setStatus).toMatchObject({ cost: 'free', resources: ['tracker'], sync: true });
    expect(setStatus.params.properties.state.enum).toContain('Applied');
    expect(res.json().find((a: { id: string }) => a.id === 'daily.runNow').confirm).toMatch(/Continue/);
  });

  it('rejects unknown actions and invalid params before anything runs', async () => {
    expect((await post('/api/actions/nope', { params: {} })).statusCode).toBe(404);
    const bad = await post('/api/actions/tracker.setStatus', { params: { row: 'x', state: 'Nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);
  });

  it('tracker.setStatus runs the core CLI with --source web and appends to status-log', async () => {
    const res = await post('/api/actions/tracker.setStatus', { params: { row: 2, state: 'Applied' } });
    expect(res.statusCode, res.body).toBe(200);
    const tracker = (await get('/api/tracker')).json();
    expect(tracker.rows.find((r: { num: number }) => r.num === 2).status).toBe('Applied');
    const log = fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'status-log.tsv'), 'utf8').trim().split('\n');
    expect(log.at(-1)).toMatch(/^2\t\d{4}-\d{2}-\d{2}\tEvaluated\tApplied\tweb/);
  });

  it('maps set-status exit codes to HTTP statuses', async () => {
    const missing = await post('/api/actions/tracker.setStatus', { params: { row: 99, state: 'Applied' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().exit).toBe(2);
  });

  it('system.doctor returns the JSON report synchronously', async () => {
    const res = await post('/api/actions/system.doctor', { params: {} });
    expect([200, 500]).toContain(res.statusCode);
    expect(res.json().result).toBeTypeOf('object');
  });

  it('an async action returns a run id, the run finishes and its log is readable', async () => {
    const res = await post('/api/actions/pipeline.prioritize', { params: {} });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const meta = await waitForRun(runId);
    expect(meta).toMatchObject({ actionId: 'pipeline.prioritize', status: 'done', exitCode: 0 });
    const detail = (await get(`/api/runs/${runId}`)).json();
    expect(Array.isArray(detail.lines)).toBe(true);
    const list = (await get('/api/runs')).json();
    expect(list.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await get('/api/runs/does-not-exist')).statusCode).toBe(404);
  });

  it('actions need the write headers like every other mutation', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/actions/system.doctor', headers: t.authed, payload: { params: {} } });
    expect(res.statusCode).toBe(403);
  });
});
