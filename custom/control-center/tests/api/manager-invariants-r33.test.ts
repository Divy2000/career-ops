// Invariants of the session manager (server/claude/manager.invariants.md), encoded as tests: one tracker settles a
// turn and every other process sees it finishing until it is done (R33-claude-L1-01), a session's status describes its
// last turn, the batch-start refusal names a batch only when one runs (R33-claude-L2-01), and a tailored CV session holds
// its row number for the application it pinned (R33-feat-a-L2-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
  async function peerFinalizing(mode = 'advisor', target: SessionMeta['target'] = { type: 'none', value: null }): Promise<{ a: TestApp; b: TestApp; id: string; open: () => void; dataRoot: string; restore: () => void }> {
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
    let a: TestApp | undefined;
    let b: TestApp | undefined;
    try {
      a = await makeTestApp({ dataRoot, guardRoot }, { exec: slowRelease });
      b = await makeTestApp({ dataRoot, guardRoot });
      const meta = a.sessions.store.create({ mode, policyClass: a.sessions.effectivePolicy(mode)!.policyClass, target, model: null, reportNum: 7 });
      a.sessions.store.setStatus(meta.id, 'done');
      await a.sessions.send(meta.id, 'What is overdue?');
      await until(() => a!.sessions.read(meta.id)!.turns.length === 1, 'turn 1 to begin');
      b.sessions.cancel(meta.id);
      await until(() => releasing, 'A to block in its report-number release');
      const seen = b.sessions.read(meta.id)!;
      expect(seen.status).toBe('cancelled');
      expect(seen.turns.at(-1)!.endedAt).toBeNull();
      return { a, b, id: meta.id, open, dataRoot, restore };
    } catch (err) {
      // Nothing reaches the caller's teardown: undo the scenario env, the blocked finalize and the apps here.
      await teardown({ a, b, open, dataRoot, restore });
      throw err;
    }
  }

  async function teardown(s: { a?: TestApp; b?: TestApp; open: () => void; dataRoot: string; restore: () => void }): Promise<void> {
    s.open();
    try {
      if (s.a) await quiet(s.a);
      if (s.b) await quiet(s.b);
    } finally {
      try {
        await s.a?.close();
        await s.b?.close();
      } finally {
        s.restore();
        await runsEnded(s.dataRoot);
      }
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

  it('given A still finalizing a cancelled evaluation, when B checks for a live evaluation of its posting, then it names that session', async () => {
    const target = { type: 'url' as const, value: 'https://jobs.example.com/synthetic/r33-peer-finalizing' };
    const s = await peerFinalizing('oferta', target);
    try {
      expect(s.b.sessions.liveEvaluationFor('oferta', target)).toBe(s.id);
      const res = await s.b.app.inject({ method: 'POST', url: '/api/sessions', headers: s.b.authedWrite, payload: { mode: 'oferta', target, prompt: 'Evaluate it' } });
      expect(res.statusCode).toBe(409);
    } finally {
      await teardown(s);
    }
  }, 40_000);

  it('given A still finalizing, when A closes, then a reply through B is still refused until that finalize ends', async () => {
    const s = await peerFinalizing();
    try {
      await s.a.close();
      await expect(s.b.sessions.send(s.id, 'Again?')).rejects.toThrow(/still finishing/);
      expect(s.b.sessions.read(s.id)!.turns).toHaveLength(1);
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

describe('one tracker settles a turn across server processes (R33-claude-L1-01)', () => {
  /** A follows a turn that streams a delta, waits 2.5 s, streams another and ends done; B reconciles meanwhile. */
  async function followedByBoth(fn: (a: TestApp, b: TestApp, id: string, deltas: () => number) => Promise<void>): Promise<void> {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-r33-standby-guard-');
    const scenario = path.join(tempDir('cc-r33-scenario-'), 'scenario.json');
    const text = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
    fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, text('one '), ...Array.from({ length: 25 }, () => ({ __sleep: 100 })), text('two'), { type: 'result', subtype: 'success', result: 'one two', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, is_error: false }] }));
    const before = process.env.FAKE_CLAUDE_SCENARIO;
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    let a: TestApp | undefined;
    let b: TestApp | undefined;
    try {
      a = await makeTestApp({ dataRoot, guardRoot });
      b = await makeTestApp({ dataRoot, guardRoot }, { deferReconcile: true });
      const meta = a.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      a.sessions.store.setStatus(meta.id, 'done');
      await a.sessions.send(meta.id, 'What is overdue?');
      const store = a.sessions.store;
      const deltas = () => store.readEvents(meta.id).filter((e) => e.event.type === 'text.delta').length;
      await until(() => deltas() === 1, 'the first delta');
      b.activate();
      expect(b.sessions.isActive(meta.id)).toBe(true);
      await fn(a, b, meta.id, deltas);
    } finally {
      try {
        await a?.close();
        await b?.close();
      } finally {
        if (before === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
        else process.env.FAKE_CLAUDE_SCENARIO = before;
        await runsEnded(dataRoot);
      }
    }
  }

  it('given a turn A follows, when B reconciles, then only A records its output and B lets go once A settled it', async () => {
    await followedByBoth(async (_a, b, id, deltas) => {
      await until(() => b.sessions.read(id)!.turns[0]!.endedAt !== null, 'the turn to be settled', 20_000);
      await until(() => !b.sessions.isActive(id), 'B to let go of the turn');
      expect(deltas()).toBe(2);
      expect(b.sessions.read(id)!.status).toBe('done');
    });
  }, 40_000);

  it('given B standing by, when A settles the turn and its run record goes, then B lets go without settling the turn again', async () => {
    await followedByBoth(async (a, b, id) => {
      const runId = a.sessions.read(id)!.turns[0]!.runId;
      await until(() => a.sessions.read(id)!.turns[0]!.endedAt !== null && !a.sessions.isActive(id), 'A to settle the turn', 20_000);
      await runsEnded(a.cfg.dataRoot);
      // Neither runner may still be following the run when its folder goes: a late write would land in a removed folder.
      await until(() => !a.runner.ending(runId) && !b.runner.ending(runId), 'both runners to let go of the run');
      fs.rmSync(a.runner.store.dirOf(runId), { recursive: true, force: true });
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(' '));
      try {
        await until(() => !b.sessions.isActive(id), 'B to let go of the turn');
      } finally {
        console.error = original;
      }
      expect(errors.filter((e) => e.includes(id))).toEqual([]);
      expect(b.sessions.read(id)!.status).toBe('done');
    });
  }, 40_000);

  // Fix-check FC-01 on R33-claude-L1-01: the standby's settled check read the session unguarded inside its timer, so a
  // torn meta.json threw out of the timer as an uncaught exception.
  it('given B standing by, when B cannot read the session for a while, then B warns, keeps standing by and lets go once A settled the turn', async () => {
    await followedByBoth(async (_a, b, id) => {
      const uncaught: unknown[] = [];
      const onUncaught = (err: unknown) => void uncaught.push(err);
      process.on('uncaughtException', onUncaught);
      const read = b.sessions.store.read.bind(b.sessions.store);
      let refused = 0;
      const spy = vi.spyOn(b.sessions.store, 'read').mockImplementation((sid: string) => {
        if (sid !== id) return read(sid);
        refused += 1;
        throw new SyntaxError('Unexpected end of JSON input');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await until(() => refused > 0, 'a standby tick to read the session', 10_000);
        // The tick has run past the read; any throw out of the timer has been raised by now.
        await wait(50);
      } finally {
        spy.mockRestore();
        process.off('uncaughtException', onUncaught);
      }
      try {
        expect(uncaught).toEqual([]);
        expect(warn.mock.calls.some((c) => String(c[0]).includes(id))).toBe(true);
      } finally {
        warn.mockRestore();
      }
      await until(() => b.sessions.read(id)!.turns[0]!.endedAt !== null, 'the turn to be settled', 20_000);
      await until(() => !b.sessions.isActive(id), 'B to let go of the turn');
      expect(b.sessions.read(id)!.status).toBe('done');
    });
  }, 40_000);

  it('given a turn A follows and B stands by for, when A is gone, then B takes it over and settles it', async () => {
    await followedByBoth(async (a, b, id, deltas) => {
      await wait(400);
      await a.close();
      await until(() => b.sessions.read(id)!.turns[0]!.endedAt !== null, 'B to settle the turn', 20_000);
      expect(b.sessions.read(id)!.status).toBe('done');
      expect(deltas()).toBe(2);
    });
  }, 40_000);

  // R36-claude-L1-01: a standby that took the track claim but could not read the session the second time gave the claim
  // back through a release that read the torn meta.json again, unguarded, so the throw left the timer uncaught.
  it('given A is gone, when B takes the track claim but cannot read the session again, then B gives the claim back without throwing and later settles the turn', async () => {
    await followedByBoth(async (a, b, id, deltas) => {
      await a.close();
      const claimFile = path.join(b.sessions.store.guardDirOf(id), 'track.claim');
      const uncaught: unknown[] = [];
      const onUncaught = (err: unknown) => void uncaught.push(err);
      process.on('uncaughtException', onUncaught);
      const read = b.sessions.store.read.bind(b.sessions.store);
      let reads = 0;
      let claimedDuringTornRead = false;
      const spy = vi.spyOn(b.sessions.store, 'read').mockImplementation((sid: string) => {
        if (sid !== id) return read(sid);
        reads += 1;
        if (reads === 1) return read(sid);
        if (reads === 2) claimedDuringTornRead = fs.existsSync(claimFile);
        throw new SyntaxError('Unexpected end of JSON input');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await until(() => reads >= 2, 'a standby tick to claim the turn and read the session again', 10_000);
        // The tick has run past the release; any throw out of the timer has been raised by now.
        await wait(50);
        expect(claimedDuringTornRead).toBe(true);
        expect(uncaught).toEqual([]);
        expect(fs.existsSync(claimFile)).toBe(false);
        expect(b.sessions.isActive(id)).toBe(true);
      } finally {
        spy.mockRestore();
        warn.mockRestore();
        process.off('uncaughtException', onUncaught);
      }
      await until(() => b.sessions.read(id)!.turns[0]!.endedAt !== null, 'B to settle the turn', 20_000);
      expect(b.sessions.read(id)!.status).toBe('done');
      expect(deltas()).toBe(2);
    });
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

describe('a tailored CV session holds its row number for the application it pinned (R33-feat-a-L2-01)', () => {
  const GLOBEX = { company: 'Globex Payments', role: 'Staff Software Engineer', report: 3 };
  const ACME = { company: 'Acme Robotics', role: 'Senior Backend Engineer', report: 99 };
  const startPdf = (app: TestApp) =>
    app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'pdf', target: { type: 'app', value: '3' }, prompt: 'Generate the tailored CV PDF for tracker row #3.' } });

  async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r33-cv-guard-') });
    try {
      await fn(app);
    } finally {
      await quiet(app);
      await app.close();
      await runsEnded(dataRoot);
    }
  }

  // Row 3 of the fixture tracker is Globex Payments.
  const cases: { name: string; pinned: SessionMeta['target']['row'] | undefined; status: number }[] = [
    { name: 'pinned to the application now under the number', pinned: GLOBEX, status: 409 },
    { name: 'pinned to an earlier application a reindex moved off the number', pinned: ACME, status: 202 },
    { name: 'started before rows were pinned (no pin)', pinned: undefined, status: 409 },
    { name: 'pinned to the same company under another report', pinned: { ...GLOBEX, report: 4 }, status: 202 },
    { name: 'pinned to the same application before it had a report', pinned: { ...GLOBEX, report: null }, status: 409 },
  ];
  for (const c of cases) {
    it(`given a running pdf session on #3 ${c.name}, when a tailored CV starts for #3, then it answers ${c.status}`, async () => {
      await withApp(async (app) => {
        const live = app.sessions.store.create({ mode: 'pdf', policyClass: app.sessions.effectivePolicy('pdf')!.policyClass, target: { type: 'app', value: '3', ...(c.pinned ? { row: c.pinned } : {}) }, model: null });
        app.sessions.store.setStatus(live.id, 'running');
        const res = await startPdf(app);
        expect(res.statusCode, res.body).toBe(c.status);
        if (c.status === 409) expect(res.json().error).toContain(live.id);
      });
    });
  }

  for (const c of [{ name: 'pinned to an earlier application', pinned: ACME as SessionMeta['target']['row'], status: 202 }, { name: 'with no pin', pinned: undefined, status: 409 }]) {
    it(`given a finished pdf session for Globex on #3 and a running one ${c.name}, when the finished one gets a reply, then it answers ${c.status}`, async () => {
      await withApp(async (app) => {
        const policyClass = app.sessions.effectivePolicy('pdf')!.policyClass;
        const own = app.sessions.store.create({ mode: 'pdf', policyClass, target: { type: 'app', value: '3', row: GLOBEX }, model: null });
        app.sessions.store.setStatus(own.id, 'done');
        const live = app.sessions.store.create({ mode: 'pdf', policyClass, target: { type: 'app', value: '3', ...(c.pinned ? { row: c.pinned } : {}) }, model: null });
        app.sessions.store.setStatus(live.id, 'running');
        const res = await app.app.inject({ method: 'POST', url: `/api/sessions/${own.id}/turns`, headers: app.authedWrite, payload: { prompt: 'Again, shorter.' } });
        expect(res.statusCode, res.body).toBe(c.status);
      });
    });
  }

  it('given two tailored CV starts for one row at once, then one starts and the other is refused', async () => {
    await withApp(async (app) => {
      const res = await Promise.all([startPdf(app), startPdf(app)]);
      expect(res.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    });
  });
});
