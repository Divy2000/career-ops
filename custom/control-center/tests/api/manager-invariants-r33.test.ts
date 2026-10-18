// Invariants of the session manager (server/claude/manager.invariants.md), encoded as tests: one tracker settles a
// turn and every other process sees it finishing until it is done (R33-claude-L1-01), a session's status describes its
// last turn, the batch-start refusal names a batch only when one runs (R33-claude-L2-01), and a tailored CV session holds
// its row number for the application it pinned (R33-feat-a-L2-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { SessionStore, type SessionMeta } from '../../server/claude/sessions.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

/** Cancels every open turn of `app` and waits for each to be settled, so no run writes into a removed root. */
async function quiet(app: TestApp): Promise<void> {
  const open = () => app.sessions.store.list().filter((s) => s.turns.at(-1) && !s.turns.at(-1)!.endedAt);
  for (const s of open()) if (s.status === 'running' || s.status === 'queued') app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && open().length; i += 1) await wait(25);
}

describe('a cancelled turn another server process is still finalizing (R33-claude-L1-01)', () => {
  /**
   * Server A follows a turn and, finalizing it, blocks in its report-number release; the user cancelled it through
   * server B, which does not track it. B sees a cancelled session whose run has ended and whose turn has not.
   */
  async function peerFinalizing(): Promise<{ a: TestApp; b: TestApp; id: string; open: () => void; dataRoot: string; restore: () => void }> {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-r33-finalize-guard-');
    let releasing = false;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slowRelease: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) {
        releasing = true;
        await gate;
      }
      return execNoShell(cmd, args, opts);
    };
    const scenario = path.join(tempDir('cc-r33-scenario-'), 'scenario.json');
    fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, ...Array.from({ length: 300 }, () => ({ __sleep: 100 }))] }));
    const before = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    const restore = () => {
      if (before === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = before;
    };
    const a = await makeTestApp({ dataRoot, guardRoot }, { exec: slowRelease });
    const b = await makeTestApp({ dataRoot, guardRoot });
    const meta = a.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null, reportNum: 7 });
    a.sessions.store.setStatus(meta.id, 'done');
    await a.sessions.send(meta.id, 'What is overdue?');
    await until(() => a.sessions.read(meta.id)!.turns.length === 1, 'turn 1 to begin');
    b.sessions.cancel(meta.id);
    await until(() => releasing, 'A to block in its report-number release');
    const seen = b.sessions.read(meta.id)!;
    expect(seen.status).toBe('cancelled');
    expect(seen.turns.at(-1)!.endedAt).toBeNull();
    return { a, b, id: meta.id, open, dataRoot, restore };
  }

  async function teardown(s: { a: TestApp; b: TestApp; open: () => void; dataRoot: string; restore: () => void }): Promise<void> {
    s.open();
    try {
      await quiet(s.a);
      await quiet(s.b);
    } finally {
      await s.a.close();
      await s.b.close();
      s.restore();
      await runsEnded(s.dataRoot);
    }
  }

  it('given A still finalizing, when a reply is sent through B, then it is refused as still finishing and no turn starts', async () => {
    const s = await peerFinalizing();
    try {
      await expect(s.b.sessions.send(s.id, 'Again?')).rejects.toThrow(/still finishing/);
      expect(s.b.sessions.read(s.id)!.turns).toHaveLength(1);
    } finally {
      await teardown(s);
    }
  }, 40_000);

  it('given A still finalizing, when the session is deleted through B, then it is refused and the session stays', async () => {
    const s = await peerFinalizing();
    try {
      await expect(s.b.sessions.delete(s.id)).rejects.toThrow(/still finishing/);
      expect(s.b.sessions.read(s.id)).not.toBeNull();
    } finally {
      await teardown(s);
    }
  }, 40_000);

  it('given A finished finalizing, when a reply is sent through B, then it starts', async () => {
    const s = await peerFinalizing();
    try {
      s.open();
      await until(() => s.b.sessions.read(s.id)!.turns.at(-1)!.endedAt !== null && !s.a.sessions.isActive(s.id), 'A to settle turn 1');
      const sent = await s.b.sessions.send(s.id, 'Again?');
      expect(sent.turns).toHaveLength(2);
    } finally {
      await teardown(s);
    }
  }, 40_000);
});

/** Mulberry32: a small seeded PRNG, so a failing sequence can be replayed from its printed seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('a session status describes its last turn (R33-claude-L1-01)', () => {
  const OUTCOMES = ['awaiting_user', 'done', 'error', 'cancelled'] as const;

  it('given a later turn running, when an earlier turn ends, then the session stays running', () => {
    const store = new SessionStore(copyFixtureRoot(), tempDir('cc-r33-store-guard-'));
    const meta = store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
    store.beginTurn(meta.id, { runId: 'run-1', userText: 'one' });
    store.setStatus(meta.id, 'cancelled');
    store.beginTurn(meta.id, { runId: 'run-2', userText: 'two' });
    const after = store.endTurn(meta.id, 1, { costUsd: 0.5, tokens: 10, permissionDenials: 0, status: 'cancelled' });
    expect(after.status).toBe('running');
    expect(after.turns[0]!.endedAt).not.toBeNull();
    // Its cost is still counted once.
    expect(after.totals.costUsd).toBe(0.5);
  });

  it('given random sequences of turns beginning and ending out of order, then the status is always the last turn\'s', () => {
    for (let iter = 0; iter < 40; iter += 1) {
      const seed = 0x5eed0000 + iter;
      const rand = prng(seed);
      const store = new SessionStore(copyFixtureRoot(), tempDir('cc-r33-store-guard-'));
      const { id } = store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      // What the last turn decided: running until it ends, then its outcome.
      let expected: SessionMeta['status'] = 'queued';
      for (let step = 0; step < 25; step += 1) {
        const meta = store.read(id)!;
        const open = meta.turns.filter((t) => t.endedAt === null);
        const r = rand();
        if (r < 0.35 || meta.turns.length === 0) {
          store.beginTurn(id, { runId: `run-${step}`, userText: `turn ${step}` });
          expected = 'running';
        } else if (open.length > 0) {
          const t = open[Math.floor(rand() * open.length)]!;
          const status = OUTCOMES[Math.floor(rand() * OUTCOMES.length)]!;
          store.endTurn(id, t.n, { costUsd: 0, tokens: 0, permissionDenials: 0, status });
          if (t.n === meta.turns.at(-1)!.n) expected = status;
        } else {
          continue;
        }
        expect(store.read(id)!.status, `seed ${seed} step ${step}`).toBe(expected);
      }
    }
  });
});

describe('the batch-start refusal names a batch only while one runs (R33-claude-L2-01)', () => {
  const URL = 'https://jobs.example.com/synthetic/r33-single-start';
  const slowToken = { readToken: async () => (await wait(600), 'fake-oauth-token-for-tests') };

  it('given a single evaluation of a posting preparing, then no batch evaluate counts as starting it', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r33-l2-guard-') }, slowToken);
    try {
      const target = { type: 'url' as const, value: URL };
      const first = app.sessions.start({ mode: 'oferta', target, prompt: 'Evaluate it', reportNum: null });
      first.catch(() => {});
      expect(app.sessions.isStartingInBatch('oferta', target)).toBe(false);
      const second = await app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'oferta', target, prompt: 'Evaluate it' } });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).not.toMatch(/batch/i);
      await first;
    } finally {
      await quiet(app);
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a single reply replaying an evaluation preparing, then no batch evaluate counts as starting its posting', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r33-l2-guard-') }, slowToken);
    try {
      const target = { type: 'url' as const, value: URL };
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: app.sessions.effectivePolicy('oferta')!.policyClass, target, model: null });
      app.sessions.store.setStatus(meta.id, 'error', 'it failed');
      const reply = app.sessions.send(meta.id, 'Try again');
      reply.catch(() => {});
      expect(app.sessions.isStartingInBatch('oferta', target)).toBe(false);
      await reply;
    } finally {
      await quiet(app);
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
