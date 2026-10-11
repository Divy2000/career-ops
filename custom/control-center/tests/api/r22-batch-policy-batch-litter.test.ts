// A manual AI policy pass snapshots the queue into data/immigration/batches/ before its session starts. A batch no
// session can ever acknowledge (the start failed, or the session holding it was deleted before it ended done) is
// removed, so failed passes do not pile up batch files; one a session can still continue, or that is recorded done
// for a later ack, stays (R22-fu-6).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { recordDonePolicyBatch } from '../../server/domains/policyPass.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string, isError = false) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: isError });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const batchesDir = () => path.join(t.cfg.dataRoot, 'data', 'immigration', 'batches');
const batchFiles = () => (fs.existsSync(batchesDir()) ? fs.readdirSync(batchesDir()).sort() : []);
const exists = (batch: string) => fs.existsSync(path.join(t.cfg.dataRoot, batch));
const writePending = (ids: number[]) =>
  fs.writeFileSync(path.join(t.cfg.dataRoot, 'data', 'immigration', 'pending.json'), JSON.stringify(ids.map((n) => ({ id: `fr:r22-${n}`, source: 'Federal Register', title: `rule ${n}`, url: `https://www.federalregister.gov/d/r22-${n}`, published: '2026-10-01' }))));
const start = () => t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'immigration-policy', prompt: 'Run the daily immigration policy pass.' } });
const del = (id: string) => t.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: t.authedWrite, payload: {} });

async function withScenario<T>(events: unknown[], fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ events }));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
/** Waits until the session's last turn is finalized (its status settled and nothing of it still running). */
async function settled(id: string): Promise<string> {
  for (let i = 0; i < 600; i++) {
    const meta = t.sessions.read(id)!;
    if (['done', 'awaiting_user', 'error', 'cancelled'].includes(meta.status) && meta.turns.at(-1)?.endedAt) return meta.status;
    await wait(50);
  }
  throw new Error(`session ${id} did not settle`);
}
/** Deletes a session once the manager lets go of it (it refuses one still finishing with 409). */
async function delOnceIdle(id: string) {
  let res = await del(id);
  for (let i = 0; i < 200 && res.statusCode === 409; i++) {
    await wait(50);
    res = await del(id);
  }
  return res;
}

describe('the batch file of a manual AI policy pass that does not end done (R22-fu-6)', () => {
  it('given a pass that ends in error, when it is still kept, then its batch stays so a reply can continue it', async () => {
    writePending([1]);
    const res = await withScenario([INIT, result('the pass broke', true)], start);
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().id as string;
    expect(await settled(id)).toBe('error');
    const batch = t.sessions.read(id)!.policyBatch!;
    expect(batch).toBeTruthy();
    expect(exists(batch)).toBe(true);
    expect((await delOnceIdle(id)).statusCode).toBe(200);
  });

  it('given a pass that ended in error, when its session is deleted, then its batch file is removed', async () => {
    writePending([2]);
    const res = await withScenario([INIT, result('the pass broke', true)], start);
    const id = res.json().id as string;
    expect(await settled(id)).toBe('error');
    const batch = t.sessions.read(id)!.policyBatch!;
    expect((await delOnceIdle(id)).statusCode).toBe(200);
    expect(exists(batch)).toBe(false);
  });

  it('given a pass that was cancelled, when its session is deleted, then its batch file is removed', async () => {
    writePending([3]);
    const res = await withScenario([INIT, ...Array.from({ length: 50 }, () => ({ __sleep: 100 })), result('Pass done.')], start);
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().id as string;
    const batch = t.sessions.read(id)!.policyBatch!;
    expect((await t.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, headers: t.authedWrite, payload: {} })).statusCode).toBe(200);
    expect(await settled(id)).toBe('cancelled');
    expect((await delOnceIdle(id)).statusCode).toBe(200);
    expect(exists(batch)).toBe(false);
  });

  it('given a pass whose session fails to start, when the start is refused, then no batch file is left behind', async () => {
    writePending([4]);
    const before = batchFiles();
    const spy = vi.spyOn(t.sessions, 'start').mockRejectedValueOnce(new Error('spawn failed'));
    try {
      const res = await start();
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(batchFiles()).toEqual(before);
  });

  it('given two sessions holding the same batch (a fork interrupted mid hand-over), when one is deleted, then the batch stays for the other', async () => {
    writePending([5]);
    const a = await withScenario([INIT, result('the pass broke', true)], start);
    const b = await withScenario([INIT, result('the pass broke', true)], async () => {
      expect(await settled(a.json().id)).toBe('error');
      return start();
    });
    const aId = a.json().id as string;
    const bId = b.json().id as string;
    expect(await settled(bId)).toBe('error');
    const batch = t.sessions.read(aId)!.policyBatch!;
    const own = t.sessions.read(bId)!.policyBatch!;
    t.sessions.store.setPolicyBatch(bId, batch);
    expect((await delOnceIdle(aId)).statusCode).toBe(200);
    expect(exists(batch)).toBe(true);
    t.sessions.store.setPolicyBatch(bId, own);
    expect((await delOnceIdle(bId)).statusCode).toBe(200);
    expect(exists(own)).toBe(false);
    fs.rmSync(path.join(t.cfg.dataRoot, batch), { force: true });
  });

  it('given a session still naming a batch that is recorded done, when it is deleted, then the batch stays for the later ack', async () => {
    writePending([6]);
    const res = await withScenario([INIT, result('the pass broke', true)], start);
    const id = res.json().id as string;
    expect(await settled(id)).toBe('error');
    const batch = t.sessions.read(id)!.policyBatch!;
    recordDonePolicyBatch(t.cfg.dataRoot, batch);
    expect((await delOnceIdle(id)).statusCode).toBe(200);
    expect(exists(batch)).toBe(true);
    fs.rmSync(path.join(t.cfg.dataRoot, batch + '.done'), { force: true });
    fs.rmSync(path.join(t.cfg.dataRoot, batch), { force: true });
  });
});
