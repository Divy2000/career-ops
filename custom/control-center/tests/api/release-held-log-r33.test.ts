import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { HELD_REPORT_NUMS_FILE, recordHeldReportNums } from '../../server/claude/manager.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (id: string, params: Record<string, unknown>) => t.app.inject({ method: 'POST', url: `/api/actions/${id}`, headers: t.authedWrite, payload: { params } });
const sentinel = (n: number) => path.join(t.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);

async function reserveOne(): Promise<number> {
  const reserved = await post('pipeline.reserveReportNums', { count: 1 });
  expect(reserved.statusCode, reserved.body).toBe(200);
  return Number(String(reserved.json().result).match(/\d+/)![0]);
}

/** A session that ran `node reserve-report-num.mjs` itself: the app logs the printed number in its guard folder, never in meta.reportNum. */
function selfReserving(num: number) {
  const meta = t.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://boards.greenhouse.io/acme/jobs/1' }, model: null });
  t.sessions.store.setStatus(meta.id, 'running');
  recordHeldReportNums(t.sessions.store.guardDirOf(meta.id), [num], t.cfg.dataRoot);
  return meta;
}

// R33-srv-core-X-01: the release check read only meta.reportNum, so it freed a number a live session had reserved
// itself, and the next evaluation was handed the same report number.
describe('Release report numbers beside a session that reserved its own number (R33-srv-core-X-01)', () => {
  it('given a running session holding a number it reserved itself, when that number is released, then it is refused naming the session and the sentinel stays', async () => {
    const num = await reserveOne();
    const meta = selfReserving(num);
    try {
      const res = await post('pipeline.releaseReportNums', { range: String(num) });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toContain(meta.id);
      expect(fs.existsSync(sentinel(num))).toBe(true);
    } finally {
      t.sessions.store.setStatus(meta.id, 'done');
      fs.rmSync(t.sessions.store.guardDirOf(meta.id), { recursive: true, force: true });
      await post('pipeline.releaseReportNums', { range: String(num) });
    }
  });

  it('given a session whose release of its own number is in flight, when that number is released here, then it is refused', async () => {
    const num = await reserveOne();
    const meta = selfReserving(num);
    // guard-hook.mjs logged the session's own release, which has not deleted the sentinel yet (or failed).
    fs.appendFileSync(path.join(t.sessions.store.guardDirOf(meta.id), HELD_REPORT_NUMS_FILE), `\n-${num}@toolu_r33;`);
    try {
      expect((await post('pipeline.releaseReportNums', { range: String(num) })).statusCode).toBe(409);
      expect(fs.existsSync(sentinel(num))).toBe(true);
    } finally {
      t.sessions.store.setStatus(meta.id, 'done');
      fs.rmSync(t.sessions.store.guardDirOf(meta.id), { recursive: true, force: true });
      await post('pipeline.releaseReportNums', { range: String(num) });
    }
  });

  it('given a session whose logged hold names an earlier reservation of the number, when the number is released, then it goes', async () => {
    const num = await reserveOne();
    const meta = selfReserving(num);
    // The sentinel was released, collected and reserved again by someone else: the session's hold names the old one.
    fs.writeFileSync(sentinel(num), JSON.stringify({ created_at: new Date(Date.now() + 60_000).toISOString(), token: 'someone-else' }));
    try {
      const res = await post('pipeline.releaseReportNums', { range: String(num) });
      expect(res.statusCode, res.body).toBe(200);
      expect(fs.existsSync(sentinel(num))).toBe(false);
    } finally {
      t.sessions.store.setStatus(meta.id, 'done');
      fs.rmSync(t.sessions.store.guardDirOf(meta.id), { recursive: true, force: true });
    }
  });

  it('given a session that let its own number go, when the number is released, then it goes', async () => {
    const num = await reserveOne();
    const meta = selfReserving(num);
    // Its release ran and the app reserved the number again for nobody: the hold ended with that release.
    fs.appendFileSync(path.join(t.sessions.store.guardDirOf(meta.id), HELD_REPORT_NUMS_FILE), `\n-${num}@toolu_r33b;`);
    fs.writeFileSync(sentinel(num), JSON.stringify({ created_at: new Date(Date.now() + 60_000).toISOString(), token: 'fresh' }));
    try {
      expect((await post('pipeline.releaseReportNums', { range: String(num) })).statusCode).toBe(200);
    } finally {
      t.sessions.store.setStatus(meta.id, 'done');
      fs.rmSync(t.sessions.store.guardDirOf(meta.id), { recursive: true, force: true });
    }
  });
});
