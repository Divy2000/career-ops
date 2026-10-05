// Sponsorship > Run AI policy pass starts an immigration-policy session. Like run-daily.sh, the pass gets
// daily-prompt.md filled in with the queued official items, and a pass that ends done acknowledges exactly those
// items, so they leave pending.json and the next daily run does not send them to Claude again (SW-web-b-02).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const item = (n: number) => ({ id: `fr:2026-2100${n}`, source: 'Federal Register (Rule; USCIS)', title: `H-1B rule number ${n}`, url: `https://www.federalregister.gov/d/2026-2100${n}`, published: '2026-10-01' });
const pendingFile = () => path.join(t.cfg.dataRoot, 'data', 'immigration', 'pending.json');
const writePending = (items: unknown) => fs.writeFileSync(pendingFile(), typeof items === 'string' ? items : JSON.stringify(items, null, 2));
const readPending = () => JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Array<{ id: string }>;
const start = () => t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'immigration-policy', prompt: 'Run the daily immigration policy pass.' } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Settled = { meta: { status: string; reason?: string | null; turns: Array<{ userText: string; reason?: string }> } };
async function settle(id: string, timeoutMs = 30_000): Promise<Settled> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await t.app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: t.authed })).json() as Settled;
    if (['done', 'awaiting_user', 'error', 'cancelled'].includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
async function withScenario<T>(scenario: unknown, fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string, isError = false) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: isError });

describe('the manual AI policy pass', () => {
  it('given queued items, when the pass ends done, then those items leave pending.json', async () => {
    writePending([item(1), item(2)]);
    const res = await start();
    expect(res.statusCode, res.body).toBe(202);
    const settled = await settle(res.json().id);
    expect(settled.meta.status).toBe('done');
    expect(readPending()).toEqual([]);
  });

  it('given queued items, when the pass starts, then it runs daily-prompt.md filled in with today and those items', async () => {
    writePending([item(3)]);
    const settled = await settle((await start()).json().id);
    const prompt = settled.meta.turns[0]!.userText;
    expect(prompt).not.toContain('{{');
    expect(prompt).toMatch(/Today is \d{4}-\d{2}-\d{2}\./);
    expect(prompt).toContain('"title": "H-1B rule number 3"');
    expect(prompt).toContain(`${path.join(t.cfg.dataRoot, 'data', 'immigration')}/policy-digest.md`);
  });

  it('given an item queued while the pass runs, when the pass ends done, then only the items it was given are acknowledged', async () => {
    writePending([item(4)]);
    await withScenario({ events: [INIT, { __sleep: 1500 }, result('SUMMARY: 0 policy changes, 0 company alerts')] }, async () => {
      const id = (await start()).json().id as string;
      writePending([item(4), item(5)]);
      expect((await settle(id)).meta.status).toBe('done');
    });
    expect(readPending().map((i) => i.id)).toEqual([item(5).id]);
  });

  it('given queued items, when the pass fails, then they stay pending for the next run', async () => {
    writePending([item(6)]);
    await withScenario({ events: [INIT, result('the pass broke', true)] }, async () => {
      expect((await settle((await start()).json().id)).meta.status).toBe('error');
    });
    expect(readPending().map((i) => i.id)).toEqual([item(6).id]);
  });

  it('given a pending.json that cannot be read, when the pass is started, then it is refused with the reason and no session starts', async () => {
    writePending('{ not json');
    const before = (await t.app.inject({ method: 'GET', url: '/api/sessions', headers: t.authed })).json().length as number;
    const res = await start();
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('data/immigration/pending.json is not valid JSON; fix or remove it, then run the pass again');
    expect((await t.app.inject({ method: 'GET', url: '/api/sessions', headers: t.authed })).json()).toHaveLength(before);
  });
});
