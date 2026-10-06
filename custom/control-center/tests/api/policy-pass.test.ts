// Sponsorship > Run AI policy pass starts an immigration-policy session. Like run-daily.sh, the pass gets
// daily-prompt.md filled in with the queued official items, and a pass that ends done acknowledges exactly those
// items, so they leave pending.json and the next daily run does not send them to Claude again (SW-web-b-02).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FAKE_TOKEN, makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import type { RunMeta } from '../../server/runner/store.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
// A turn that cannot read the Claude token fails before it spawns (a locked Keychain).
let tokenMissing = false;
// While set, a turn waits on the token as on a Keychain prompt nobody has answered yet.
let tokenGate: Promise<void> | null = null;
beforeAll(async () => {
  t = await makeTestApp({}, {
    readToken: async () => {
      if (tokenGate) await tokenGate;
      if (tokenMissing) throw new Error('Keychain item career-ops-claude-token not found');
      return FAKE_TOKEN;
    },
  });
});
/** Holds every turn at its token read until the returned function is called. */
function holdToken(): () => void {
  let open!: () => void;
  tokenGate = new Promise((resolve) => (open = resolve));
  return () => {
    tokenGate = null;
    open();
  };
}
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

describe('one AI policy pass at a time (SW8-server-01)', () => {
  const SLOW = [INIT, { __sleep: 1500 }, result('Pass done.')];

  it('a pass is refused with 409 while the daily job (which runs its own pass) is running, and nothing starts', async () => {
    const busy = await makeTestApp({ fakeDaily: 'running' });
    try {
      const sessionsBefore = (await busy.app.inject({ method: 'GET', url: '/api/sessions', headers: busy.authed })).json().length;
      const res = await busy.app.inject({ method: 'POST', url: '/api/sessions', headers: busy.authedWrite, payload: { mode: 'immigration-policy', prompt: 'Run the daily immigration policy pass.' } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/daily job/);
      expect((await busy.app.inject({ method: 'GET', url: '/api/sessions', headers: busy.authed })).json()).toHaveLength(sessionsBefore);
    } finally {
      await busy.close();
    }
  });

  it('a second pass is refused while the first is still running, even when both are asked for at once', async () => {
    writePending([item(7)]);
    const [a, b] = await withScenario({ events: SLOW }, async () => Promise.all([start(), start()]));
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json().error).toMatch(/policy pass is already running/);
    await settle((a.statusCode === 202 ? a : b).json().id);
    // Once it is over, a new one starts.
    writePending([item(8)]);
    const next = await start();
    expect(next.statusCode).toBe(202);
    await settle(next.json().id);
  });

  it('Run the daily job now is refused with 409 while a policy pass session is running', async () => {
    writePending([item(9)]);
    const pass = await withScenario({ events: SLOW }, start);
    expect(pass.statusCode).toBe(202);
    const spy = vi.spyOn(t.runner, 'start').mockImplementation(() => ({ id: '20261005000000-abcdef' }) as RunMeta);
    try {
      const res = await t.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: t.authedWrite, payload: { params: {}, confirmed: true } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/policy pass/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await settle(pass.json().id);
    }
  });
});

describe('the policy-pass claim the daily job honours too (SW8-server-01 review)', () => {
  const claimFile = () => path.join(t.cfg.dataRoot, 'data', 'immigration', '.policy-pass.claim');
  const claim = () => (fs.existsSync(claimFile()) ? (JSON.parse(fs.readFileSync(claimFile(), 'utf8')) as { owner: string }) : null);
  const reply = (id: string) => t.app.inject({ method: 'POST', url: `/api/sessions/${id}/turns`, headers: t.authedWrite, payload: { prompt: 'Go on.' } });
  const fork = (id: string) => t.app.inject({ method: 'POST', url: `/api/sessions/${id}/fork`, headers: t.authedWrite, payload: { prompt: 'Try again.' } });
  const del = (id: string) => t.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: t.authedWrite, payload: {} });
  const PAUSE = [INIT, result('Which of these two sources should I trust?')];
  /** Deletes a cancelled session once the manager has finalized its run (it refuses a running one with 409). */
  const delOnceStopped = async (id: string) => {
    let res = await del(id);
    for (let i = 0; i < 200 && res.statusCode === 409; i++) {
      await wait(50);
      res = await del(id);
    }
    return res;
  };

  it('a paused pass keeps the claim: another pass is refused, its own reply goes on, and a fork takes the claim from it', async () => {
    writePending([item(4)]);
    const a = (await withScenario({ events: PAUSE }, start)).json() as { id: string };
    expect((await settle(a.id)).meta.status).toBe('awaiting_user');
    expect(claim()?.owner).toBe(`session:${a.id}`);
    const b = await start();
    expect(b.statusCode, b.body).toBe(409);
    expect(b.json().error).toContain(a.id);
    const forked = await withScenario({ events: [INIT, { __sleep: 1500 }, result('Pass done.')] }, () => fork(a.id));
    expect(forked.statusCode, forked.body).toBe(202);
    const forkId = forked.json().id as string;
    expect(claim()?.owner).toBe(`session:${forkId}`);
    // The paused source no longer holds the pass while its fork runs it.
    const resumed = await reply(a.id);
    expect(resumed.statusCode, resumed.body).toBe(409);
    await settle(forkId);
    expect(claim()).toBeNull();
    // Once the fork is done the source may go on, and holds the claim while it does.
    const later = await withScenario({ events: PAUSE }, () => reply(a.id));
    expect(later.statusCode, later.body).toBe(202);
    expect((await settle(a.id)).meta.status).toBe('awaiting_user');
    expect(claim()?.owner).toBe(`session:${a.id}`);
    // Deleting the paused session releases it.
    expect((await del(a.id)).statusCode).toBe(200);
    expect(claim()).toBeNull();
  });

  it('a pass is refused while a daily run the app started is still queued (no lock, no pidfile yet)', async () => {
    const blocker = t.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: ['pipeline'], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    const queued: string[] = [];
    try {
      const d = await t.app.inject({ method: 'POST', url: '/api/actions/daily.runNow', headers: t.authedWrite, payload: { params: {}, confirmed: true } });
      expect(d.statusCode, d.body).toBe(202);
      queued.push(d.json().runId);
      const res = await start();
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toMatch(/daily job/);
    } finally {
      for (const id of queued) t.runner.cancel(id);
      t.runner.cancel(blocker.id);
      for (let i = 0; i < 200 && !t.runner.store.readExit(blocker.id); i++) await wait(50);
    }
  });

  it('a stale claim (its daily job is gone) is taken over by a new pass', async () => {
    fs.writeFileSync(claimFile(), JSON.stringify({ owner: 'daily:999999', batch: null, at: new Date().toISOString() }));
    writePending([item(5)]);
    const res = await start();
    expect(res.statusCode, res.body).toBe(202);
    expect(claim()?.owner).toBe(`session:${res.json().id}`);
    expect((await settle(res.json().id)).meta.status).toBe('done');
    expect(claim()).toBeNull();
  });

  it('a cancelled pass keeps the claim until its Claude process has really exited (SW8-server-01 review)', async () => {
    writePending([item(6)]);
    // A CLI that ignores SIGTERM, sleeping in short steps so the SIGKILL that ends it lands between them.
    const stubborn = [INIT, { __ignoreSigterm: true }, ...Array.from({ length: 200 }, () => ({ __sleep: 100 })), result('Pass done.')];
    const res = await withScenario({ events: stubborn }, start);
    expect(res.statusCode, res.body).toBe(202);
    const id = res.json().id as string;
    const runId = () => (t.sessions.read(id)!.turns.at(-1)!.runId);
    for (let i = 0; i < 100 && !t.runner.store.read(runId())?.childPid; i++) await wait(50);
    expect((await t.app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel`, headers: t.authedWrite, payload: {} })).statusCode).toBe(200);
    await wait(500);
    // The process is still running (the runner sends SIGKILL after 5 s): the pass still holds the queue.
    expect(t.runner.store.readExit(runId())).toBeNull();
    expect(claim()?.owner).toBe(`session:${id}`);
    const other = await start();
    expect(other.statusCode, other.body).toBe(409);
    for (let i = 0; i < 300 && !t.runner.store.readExit(runId()); i++) await wait(50);
    expect(t.runner.store.readExit(runId())).not.toBeNull();
    for (let i = 0; i < 100 && claim(); i++) await wait(50);
    expect(claim()).toBeNull();
  });

  it('a fork of a paused pass takes its batch with it, so the fork that ends done acknowledges the items (SW8-server-01 review)', async () => {
    writePending([item(11)]);
    const a = (await withScenario({ events: PAUSE }, start)).json() as { id: string };
    expect((await settle(a.id)).meta.status).toBe('awaiting_user');
    const batch = t.sessions.read(a.id)!.policyBatch;
    expect(batch).toBeTruthy();
    const forked = await withScenario({ events: [INIT, result('Pass done.')] }, () => fork(a.id));
    expect(forked.statusCode, forked.body).toBe(202);
    const forkId = forked.json().id as string;
    expect(t.sessions.read(a.id)!.policyBatch ?? null).toBeNull();
    expect((await settle(forkId)).meta.status).toBe('done');
    expect(readPending()).toEqual([]);
    expect((await del(a.id)).statusCode).toBe(200);
  });

  it('a fork of a paused pass that fails before it starts leaves the batch and the claim with the paused pass (SW8-server-01 review)', async () => {
    writePending([item(12)]);
    const a = (await withScenario({ events: PAUSE }, start)).json() as { id: string };
    expect((await settle(a.id)).meta.status).toBe('awaiting_user');
    const batch = t.sessions.read(a.id)!.policyBatch;
    expect(batch).toBeTruthy();
    tokenMissing = true;
    let forked;
    try {
      forked = await fork(a.id);
    } finally {
      tokenMissing = false;
    }
    expect(forked.statusCode, forked.body).toBe(202);
    const forkId = forked.json().id as string;
    expect((await settle(forkId)).meta.status).toBe('error');
    expect(t.sessions.read(forkId)!.policyBatch ?? null).toBeNull();
    expect(t.sessions.read(a.id)!.policyBatch).toBe(batch);
    expect(claim()?.owner).toBe(`session:${a.id}`);
    // The paused pass goes on with its items, and acknowledges them when it ends done.
    const later = await withScenario({ events: [INIT, result('Pass done.')] }, () => reply(a.id));
    expect(later.statusCode, later.body).toBe(202);
    expect((await settle(a.id)).meta.status).toBe('done');
    expect(readPending()).toEqual([]);
    expect(claim()).toBeNull();
    expect((await del(forkId)).statusCode).toBe(200);
    expect((await del(a.id)).statusCode).toBe(200);
  });

  it('a pass still waiting on the token keeps its claim however long it waits: a second pass is refused (SW8 review 2)', async () => {
    writePending([item(14)]);
    const open = holdToken();
    let first;
    let second;
    try {
      first = withScenario({ events: [INIT, result('Pass done.')] }, start);
      for (let i = 0; i < 100 && !claim()?.owner.startsWith('starting:'); i++) await wait(20);
      expect(claim()?.owner).toMatch(/^starting:/);
      // Long past any fixed time limit for a start.
      fs.writeFileSync(claimFile(), JSON.stringify({ ...claim(), at: new Date(Date.now() - 60 * 60_000).toISOString() }));
      // Not awaited before the token is given: a second start that took the claim would wait on the token too.
      second = withScenario({ events: [INIT, result('Pass done.')] }, start);
      await wait(200);
    } finally {
      open();
    }
    const refused = await second!;
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatch(/starting/);
    const res = await first;
    expect(res.statusCode, res.body).toBe(202);
    expect((await settle(res.json().id)).meta.status).toBe('done');
    expect(readPending()).toEqual([]);
    expect(claim()).toBeNull();
    expect((await del(res.json().id)).statusCode).toBe(200);
  });

  it('a start whose claim was taken while it waited on the token is cancelled and refused with 409, and the holder keeps the claim (SW8 review 2)', async () => {
    writePending([item(15)]);
    const known = new Set(t.sessions.list().map((m) => m.id));
    const open = holdToken();
    let first;
    try {
      first = withScenario({ events: [INIT, ...Array.from({ length: 30 }, () => ({ __sleep: 100 })), result('Pass done.')] }, start);
      for (let i = 0; i < 100 && !claim()?.owner.startsWith('starting:'); i++) await wait(20);
      expect(claim()?.owner).toMatch(/^starting:/);
      // Another pass took the claim over meanwhile.
      fs.writeFileSync(claimFile(), JSON.stringify({ owner: 'session:s-other-pass', batch: null, at: new Date().toISOString() }));
    } finally {
      open();
    }
    const res = await first;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatch(/cancelled/);
    const started = t.sessions.list().filter((m) => !known.has(m.id));
    expect(started).toHaveLength(1);
    expect(t.sessions.read(started[0]!.id)!.status).toBe('cancelled');
    expect(claim()?.owner).toBe('session:s-other-pass');
    expect(readPending().map((i) => i.id)).toEqual([item(15).id]);
    fs.rmSync(claimFile());
    expect((await delOnceStopped(started[0]!.id)).statusCode).toBe(200);
  });

  it('a fork whose claim was taken while it waited on the token is cancelled and refused with 409, and the paused pass keeps its batch (SW8 review 2)', async () => {
    writePending([item(16)]);
    const a = (await withScenario({ events: PAUSE }, start)).json() as { id: string };
    expect((await settle(a.id)).meta.status).toBe('awaiting_user');
    const batch = t.sessions.read(a.id)!.policyBatch;
    expect(batch).toBeTruthy();
    const known = new Set(t.sessions.list().map((m) => m.id));
    const open = holdToken();
    let forking;
    try {
      forking = withScenario({ events: [INIT, ...Array.from({ length: 30 }, () => ({ __sleep: 100 })), result('Pass done.')] }, () => fork(a.id));
      for (let i = 0; i < 100 && !claim()?.owner.startsWith('starting:'); i++) await wait(20);
      expect(claim()?.owner).toMatch(/^starting:/);
      fs.writeFileSync(claimFile(), JSON.stringify({ owner: 'session:s-other-pass', batch: null, at: new Date().toISOString() }));
    } finally {
      open();
    }
    const res = await forking;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatch(/cancelled/);
    const started = t.sessions.list().filter((m) => !known.has(m.id));
    expect(started).toHaveLength(1);
    expect(t.sessions.read(started[0]!.id)!.status).toBe('cancelled');
    expect(t.sessions.read(started[0]!.id)!.policyBatch ?? null).toBeNull();
    expect(t.sessions.read(a.id)!.policyBatch).toBe(batch);
    expect(claim()?.owner).toBe('session:s-other-pass');
    fs.rmSync(claimFile());
    expect((await delOnceStopped(started[0]!.id)).statusCode).toBe(200);
    expect((await del(a.id)).statusCode).toBe(200);
  });
});
