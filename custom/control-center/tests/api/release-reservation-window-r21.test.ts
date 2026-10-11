// A manual "Release report numbers" must not free a number a session is about to be told (FU-fanout-01): Batch
// evaluate reserves every number at once but records each session (and so its number) one at a time, and a later
// turn that lost its number takes a fresh one before recording it. The release guard reads the session records, so
// a number reserved but not yet recorded must be refused too.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, FAKE_TOKEN, type TestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type Meta = { id: string; status: string; reportNum: number | null };
const call = (app: TestApp, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
const release = (app: TestApp, num: number) => call(app, 'POST', '/api/actions/pipeline.releaseReportNums', { params: { range: String(num) } });
const sentinel = (app: TestApp, num: number) => path.join(app.cfg.dataRoot, 'reports', `${String(num).padStart(3, '0')}-RESERVED.md`);
async function settleOn(app: TestApp, id: string, timeoutMs = 30_000): Promise<Meta> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json() as { meta: Meta };
    if (TERMINAL.includes(body.meta.status)) return body.meta;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
async function until<T>(probe: () => T | undefined | null, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const NO_REPORT = { events: [INIT, { type: 'result', subtype: 'success', result: 'The posting needs a login; I could not read it.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }] };
function scenarioFile(): string {
  const file = path.join(tempDir('cc-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(NO_REPORT));
  return file;
}

describe('Release report numbers while a session is about to record its number (FU-fanout-01)', () => {
  it('given a Batch evaluate whose second session is not created yet, when its number is released, then the release is refused and the sentinel stays', async () => {
    // The first session's token read is held, so the second session (and its record) does not exist yet.
    let unblock!: () => void;
    const held = new Promise<void>((r) => (unblock = r));
    let reads = 0;
    const readToken = async () => {
      reads += 1;
      if (reads === 1) await held;
      return FAKE_TOKEN;
    };
    const app = await makeTestApp({}, { readToken });
    process.env.FAKE_CLAUDE_SCENARIO = scenarioFile();
    try {
      const fanning = call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/fu-a', 'https://jobs.example.com/synthetic/fu-b'] });
      const first = await until(() => app.sessions.store.list().find((s) => s.reportNum !== null), 'the first session record');
      expect(app.sessions.store.list().filter((s) => s.target.type === 'url' && s.target.value?.includes('/fu-'))).toHaveLength(1);
      const second = first.reportNum! + 1;
      expect(fs.existsSync(sentinel(app, second))).toBe(true);
      const res = await release(app, second);
      expect(res.statusCode, res.body).toBe(409);
      expect(fs.existsSync(sentinel(app, second))).toBe(true);
      unblock();
      const fan = (await fanning).json() as { sessions: Meta[]; reserved: number[] };
      expect(fan.reserved).toEqual([first.reportNum, second]);
      for (const s of fan.sessions) await settleOn(app, s.id);
    } finally {
      unblock();
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  });

  it('given a reply whose lost number is replaced, when the fresh number is released before the session records it, then the release is refused', async () => {
    const ref = {} as { app: TestApp };
    let armed = false;
    let raced: { status: number; body: string; sentinelStayed: boolean } | null = null;
    // The fresh reservation has been taken (its sentinel written) but the manager has not seen the number yet.
    const exec: Exec = async (bin, args, opts) => {
      const r = await execNoShell(bin, args, opts);
      if (armed && args.includes('--count') && args[args.indexOf('--count') + 1] === '1' && r.code === 0) {
        armed = false;
        const num = Number(r.stdout.match(/\d+/)![0]);
        const res = await release(ref.app, num);
        raced = { status: res.statusCode, body: res.body, sentinelStayed: fs.existsSync(sentinel(ref.app, num)) };
      }
      return r;
    };
    const app = (ref.app = await makeTestApp({}, { exec }));
    process.env.FAKE_CLAUDE_SCENARIO = scenarioFile();
    try {
      const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/fu-c'] })).json() as { sessions: Meta[]; reserved: number[] };
      const id = fan.sessions[0]!.id;
      const n = fan.reserved[0]!;
      expect(await settleOn(app, id)).toMatchObject({ status: 'awaiting_user', reportNum: n });
      // The 4h GC freed the sentinel, so the reply takes a fresh number.
      fs.rmSync(sentinel(app, n));
      armed = true;
      await call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'try again' });
      const meta = await settleOn(app, id);
      expect(raced, 'the reply took a fresh number').not.toBeNull();
      expect(raced!.status, raced!.body).toBe(409);
      expect(raced!.sentinelStayed).toBe(true);
      expect(meta.reportNum).not.toBeNull();
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  });

  it('given a release that passed its check and is still running, when a Batch evaluate reserves meanwhile, then the number it takes is not released', async () => {
    const ref = {} as { app: TestApp };
    let fanning: Promise<{ json(): unknown }> | null = null;
    let reservedDuringRelease = false;
    // The release has passed its check; a Batch evaluate starts before the release subprocess runs.
    const exec: Exec = async (bin, args, opts) => {
      if (args.includes('--release') && fanning === null) {
        fanning = call(ref.app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/fu-d'] });
        await until(() => fs.readdirSync(path.join(ref.app.cfg.dataRoot, 'reports')).some((f) => f.endsWith('-RESERVED.md') && f !== '005-RESERVED.md'), 'the fan-out reservation', 1500).then(
          () => (reservedDuringRelease = true),
          () => undefined,
        );
      }
      return execNoShell(bin, args, opts);
    };
    const app = (ref.app = await makeTestApp({}, { exec }));
    process.env.FAKE_CLAUDE_SCENARIO = scenarioFile();
    try {
      const res = await call(app, 'POST', '/api/actions/pipeline.releaseReportNums', { params: { range: '8-50' } });
      expect(res.statusCode, res.body).toBe(200);
      expect(fanning).not.toBeNull();
      const fan = (await fanning!).json() as { sessions: Meta[]; reserved: number[] };
      const n = fan.reserved[0]!;
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(50);
      expect(await settleOn(app, fan.sessions[0]!.id)).toMatchObject({ status: 'awaiting_user', reportNum: n });
      expect(fs.existsSync(sentinel(app, n)), `reserved during the release: ${reservedDuringRelease}`).toBe(true);
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  });
});
