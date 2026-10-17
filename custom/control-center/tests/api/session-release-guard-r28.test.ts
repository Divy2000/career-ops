import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

// R28-cl2-rev-01: reserve-report-num.mjs --release force-deletes whichever sentinels it names, so a session may release
// only the numbers it holds: the one the app reserved for it, and the ones its own reserve-report-num.mjs runs printed.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
type Ev = { type: string; ok?: boolean; summary?: string };
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: App, id: string, timeoutMs = 30_000): Promise<Ev[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return (body.events as Array<{ event: Ev }>).map((e) => e.event);
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read', 'Bash'] };
const RESULT = { type: 'result', subtype: 'success', result: 'Done with the numbers.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false };
async function withScenario<T>(events: unknown[], fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-r28-release-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ events }));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const sentinel = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);
const otherHolds = (app: App, n: number) => fs.writeFileSync(sentinel(app, n), JSON.stringify({ pid: process.pid, token: 'another-evaluation', created_at: new Date().toISOString() }));
const results = (events: Ev[]) => events.filter((e) => e.type === 'tool.result');

describe('a session releases only the report numbers it holds (R28-cl2-rev-01)', () => {
  it('given a session that reserved a number itself, when it releases that one and another evaluation\'s, then only its own goes', async () => {
    // Its own data root: past the other evaluation's 060, the session's reservation is 061.
    const app = await makeTestApp();
    try {
      otherHolds(app, 60);
      const events = await withScenario([INIT, { __bash: 'node reserve-report-num.mjs' }, { __bash: 'node reserve-report-num.mjs --release 060' }, { __bash: 'node reserve-report-num.mjs --release 061' }, RESULT], async () =>
        settleOn(app, (await call(app, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate' })).json().id),
      );
      const [reserve, other, own] = results(events);
      expect(reserve).toMatchObject({ ok: true, summary: expect.stringMatching(/\b061\b/) });
      expect(other).toMatchObject({ ok: false, summary: expect.stringMatching(/releases only/) });
      expect(fs.existsSync(sentinel(app, 60))).toBe(true);
      expect(own, own?.summary).toMatchObject({ ok: true });
      expect(fs.existsSync(sentinel(app, 61))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('given a session the app reserved a number for, when it releases that number, then it may, and another session holding a different number may not', async () => {
    const app = await makeTestApp();
    try {
      const fan = await withScenario([INIT, { __bash: 'node reserve-report-num.mjs --release {{REPORT_NUM}}' }, RESULT], async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/release-1'] })).json());
      const n = fan.reserved[0] as number;
      const [own] = results(await settleOn(app, fan.sessions[0].id));
      expect(own, own?.summary).toMatchObject({ ok: true });
      expect(fs.existsSync(sentinel(app, n))).toBe(false);
      otherHolds(app, 90);
      const second = await withScenario([INIT, { __bash: 'node reserve-report-num.mjs --release 090' }, RESULT], async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/release-2'] })).json());
      expect(second.reserved[0]).not.toBe(90);
      const [other] = results(await settleOn(app, second.sessions[0].id));
      expect(other).toMatchObject({ ok: false, summary: expect.stringMatching(/releases only/) });
      expect(fs.existsSync(sentinel(app, 90))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('given a session that released its number, when another evaluation reserves it and the session releases it again, then the second release is refused', async () => {
    const app = await makeTestApp();
    try {
      otherHolds(app, 60);
      const gate = tempDir('cc-r28-release-gate-');
      const start = withScenario([INIT, { __bash: 'node reserve-report-num.mjs' }, { __bash: 'node reserve-report-num.mjs --release 061' }, { __waitFor: { dir: gate, pattern: '^go$' } }, { __bash: 'node reserve-report-num.mjs --release 061' }, RESULT], async () =>
        (await call(app, 'POST', '/api/sessions', { mode: 'oferta', prompt: 'Evaluate' })).json().id as string,
      );
      const id = await start;
      const deadline = Date.now() + 20_000;
      while (results(app.sessions.store.readEvents(id).map((e) => e.event as Ev)).length < 2) {
        if (Date.now() > deadline) throw new Error('the first release never ran');
        await wait(50);
      }
      expect(fs.existsSync(sentinel(app, 61))).toBe(false);
      otherHolds(app, 61);
      fs.writeFileSync(path.join(gate, 'go'), '');
      const [, first, again] = results(await settleOn(app, id));
      expect(first, first?.summary).toMatchObject({ ok: true });
      expect(again).toMatchObject({ ok: false, summary: expect.stringMatching(/releases only/) });
      expect(fs.existsSync(sentinel(app, 61))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
