// The invariants of server/routes/sessions.invariants.md, checked through the routes: every start admitted in the tick
// that creates its session, duplicate paid work refused across processes, and the AI policy pass claim settled on every
// exit of a start or fork (R30-srv-core-L1-01, R30-srv-core-X-01, R30-w4srv-claim-stuck, R32-claude-H-01,
// R33-srv-core-L1-01). The randomized cases draw from a seeded PRNG and name the seed in every failure; set
// SESSIONS_ROUTE_SEED to replay one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { BusyError, evaluationClass, NotFoundError, postingKey, SessionManager } from '../../server/claude/manager.js';
import { postingClaimFile } from '../../server/claude/process-claim.js';
import { listLaunchableModeIds } from '../../server/claude/modes.js';
import { isReportGated } from '../../server/claude/honesty.js';
import { policyClaim } from '../../server/domains/policyPass.js';
import type { SessionMeta } from '../../server/claude/sessions.js';
import type * as Registry from '../../server/actions/registry.js';

// Every read of the tracker row a start pins waits as long as the current case says: the window an await between a
// start's checks and its create used to leave open (R33-srv-core-L1-01).
const rowDelay = vi.hoisted(() => ({ next: (): number => 0 }));
vi.mock('../../server/actions/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof Registry>();
  return {
    ...real,
    rowsSetUnder: async (...args: Parameters<typeof Registry.rowsSetUnder>) => {
      const ms = rowDelay.next();
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      return real.rowsSetUnder(...args);
    },
  };
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE_SEED = Number(process.env.SESSIONS_ROUTE_SEED ?? 0x5e55);

/** mulberry32: a small seeded PRNG, so a failing sequence can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const LIVE = new Set<SessionMeta['status']>(['queued', 'running', 'awaiting_user']);
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false });

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

const allSessions = (app: TestApp): SessionMeta[] => {
  const dir = path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((n) => app.sessions.read(n)).filter((m): m is SessionMeta => m !== null);
};
// Started runs keep writing into the data root after app.close(): cancel every open turn and wait for it to end.
async function quiet(app: TestApp): Promise<void> {
  const open = (s: SessionMeta) => !!s.turns.at(-1) && !s.turns.at(-1)!.endedAt;
  for (const s of allSessions(app)) if (open(s) && (s.status === 'running' || s.status === 'queued')) app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && (allSessions(app).some(open) || allSessions(app).some((s) => app.sessions.isActive(s.id))); i += 1) await wait(25);
}

describe('a start is admitted in the tick that creates its session (R33-srv-core-L1-01)', () => {
  const INBOX_URL = 'https://jobs.example.com/acme/123';
  // Every run outlives the requests of its round, so a session that started is still live when the next one is checked.
  const HOLD = [INIT, { __sleep: 4000 }, result('done')];
  type Op = { name: string; send: (app: TestApp, done: SessionMeta) => Promise<{ statusCode: number; body: string }> };
  const post = (app: TestApp, url: string, payload: unknown) => app.app.inject({ method: 'POST', url, headers: app.authedWrite, payload: payload as Record<string, unknown> });
  const pdf = (row: string): Op => ({ name: `pdf "${row}"`, send: (app) => post(app, '/api/sessions', { mode: 'pdf', target: { type: 'app', value: row }, prompt: `Generate the tailored CV PDF for tracker row #${row.trim()}.` }) });
  const OPS: Op[] = [
    pdf('3'),
    pdf(' 3'),
    pdf('03'),
    pdf('6'),
    { name: 'Process inbox', send: (app) => post(app, '/api/sessions', { mode: 'pipeline', prompt: 'Process the inbox.' }) },
    { name: 'evaluate a pending Inbox row', send: (app) => post(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: INBOX_URL }, prompt: 'Evaluate this posting' }) },
    { name: 'reply to a done CV of row 3', send: (app, done) => post(app, `/api/sessions/${done.id}/turns`, { prompt: 'carry on' }) },
    { name: 'fork a done CV of row 3', send: (app, done) => post(app, `/api/sessions/${done.id}/fork`, { prompt: 'again' }) },
  ];
  const cvRow = (m: SessionMeta) => (m.mode === 'pdf' && m.target.type === 'app' ? String(Number(m.target.value?.trim())) : null);

  /** What must hold over the live sessions whatever the interleaving: no paid work runs twice. */
  function violations(app: TestApp): string[] {
    const live = allSessions(app).filter((m) => LIVE.has(m.status) || app.sessions.isActive(m.id));
    const out: string[] = [];
    const rows = new Map<string, number>();
    for (const m of live) {
      const row = cvRow(m);
      if (row) rows.set(row, (rows.get(row) ?? 0) + 1);
    }
    for (const [row, n] of rows) if (n > 1) out.push(`${n} tailored CV sessions live for row ${row}`);
    const inbox = live.filter((m) => m.mode === 'pipeline');
    if (inbox.length > 1) out.push(`${inbox.length} Process inbox runs live`);
    if (inbox.length && live.some((m) => m.mode === 'oferta' && m.target.value === INBOX_URL)) out.push('a pending Inbox row is evaluated beside Process inbox');
    return out;
  }

  const ROUNDS = 6;
  let app: TestApp;
  beforeAll(async () => {
    app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
  });
  afterAll(async () => {
    rowDelay.next = () => 0;
    await quiet(app);
    await app.close();
    await runsEnded(app.cfg.dataRoot);
  });

  for (let round = 0; round < ROUNDS; round++) {
    const seed = BASE_SEED + round;
    it(`given concurrent starts, replies and forks drawn from seed ${seed}, then no tailored CV, Process inbox run or Inbox evaluation runs twice`, async () => {
      const rand = prng(seed);
      // Each start reads its row after 0-40 ms, so starts sent together reach their checks in a seed-chosen order.
      rowDelay.next = () => Math.floor(rand() * 40);
      const done = app.sessions.store.create({ mode: 'pdf', policyClass: app.sessions.effectivePolicy('pdf')!.policyClass, target: { type: 'app', value: '3' }, model: null, reportNum: null });
      app.sessions.store.setStatus(done.id, 'done');
      const ops = Array.from({ length: 3 + Math.floor(rand() * 3) }, () => pick(rand, OPS));
      try {
        const answers = await withScenario(HOLD, () => Promise.all(ops.map((op) => op.send(app, done))));
        const trace = ops.map((op, i) => `${op.name}: ${answers[i]!.statusCode}`).join(', ');
        expect(violations(app), `seed ${seed}: ${trace}`).toEqual([]);
        for (const [i, a] of answers.entries()) expect([202, 409], `seed ${seed}: ${ops[i]!.name} answered ${a.body}`).toContain(a.statusCode);
      } finally {
        rowDelay.next = () => 0;
        await quiet(app);
      }
    });
  }
});

describe('a fan-out only starts posting evaluations (R30-srv-core-X-01)', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
  });
  afterAll(async () => {
    await app.close();
  });
  const others = listLaunchableModeIds().filter((m) => !isReportGated(m));

  it('the table covers the modes whose start guards live only in a single start', () => {
    expect(others).toEqual(expect.arrayContaining(['pipeline', 'immigration-policy', 'sponsorship-check', 'pdf']));
  });

  for (const mode of others) {
    it(`given mode ${mode}, when it is fanned out, then it is refused and nothing starts`, async () => {
      const fanOut = vi.spyOn(SessionManager.prototype, 'fanOut');
      try {
        const res = await app.app.inject({ method: 'POST', url: '/api/sessions/fanout', headers: app.authedWrite, payload: { mode, urls: ['https://jobs.example.com/synthetic/fan-1'] } });
        expect([400, 422], res.body).toContain(res.statusCode);
        expect(allSessions(app)).toEqual([]);
      } finally {
        fanOut.mockRestore();
      }
    });
  }
});

describe('one posting started through the route of two server processes at once (R32-claude-H-01)', () => {
  it('given two processes on one data root, when both are asked to evaluate the posting together, then one starts and the other answers 409', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-route-r32-guard-');
    // A slow token read holds each start between its checks and its spawn, where the two used to overlap.
    const slowToken = { readToken: async () => (await wait(300), FAKE_TOKEN) };
    const a = await makeTestApp({ dataRoot, guardRoot }, slowToken);
    const b = await makeTestApp({ dataRoot, guardRoot }, slowToken);
    const URL = 'https://jobs.example.com/synthetic/r35-route-claim';
    const post = (app: TestApp) => app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'oferta', target: { type: 'url', value: URL }, prompt: 'Evaluate this posting' } });
    try {
      const [ra, rb] = await Promise.all([post(a), post(b)]);
      expect([ra.statusCode, rb.statusCode].sort(), `${ra.body} | ${rb.body}`).toEqual([202, 409]);
      expect(allSessions(a).filter((m) => m.target.value === URL)).toHaveLength(1);
    } finally {
      await quiet(a);
      await quiet(b);
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });

  it('given another live process holding the posting claim on disk, when the posting is started, then the start answers 409 and records no session', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-route-r32-guard-') });
    const URL = 'https://jobs.example.com/synthetic/r35-peer-claim';
    // The peer is a real second process: the claim names its pid, so this process cannot take it over as stale.
    const peer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', env: {} });
    try {
      const file = postingClaimFile(app.cfg.guardRoot, `${evaluationClass('oferta')}\0${postingKey('oferta', { type: 'url', value: URL })}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: peer.pid, at: Date.now(), nonce: 'peer' }));
      const res = await app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'oferta', target: { type: 'url', value: URL }, prompt: 'Evaluate this posting' } });
      expect(res.statusCode, res.body).toBe(409);
      expect(allSessions(app)).toEqual([]);
    } finally {
      peer.kill('SIGKILL');
      await app.close();
    }
  });
});

describe('the AI policy pass claim is settled on every exit of a start or fork (R30-srv-core-L1-01, R30-w4srv-claim-stuck)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
  });
  afterAll(async () => {
    await quiet(t);
    await t.close();
    await runsEnded(t.cfg.dataRoot);
  });

  let itemNo = 0;
  const writePending = () => {
    itemNo += 1;
    const id = `fr:2026-3500${itemNo}`;
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'data', 'immigration', 'pending.json'), JSON.stringify([{ id, source: 'Federal Register (Rule; USCIS)', title: `H-1B rule ${itemNo}`, url: `https://www.federalregister.gov/d/2026-3500${itemNo}`, published: '2026-10-01' }]));
  };
  const claimFile = () => path.join(t.cfg.dataRoot, 'data', 'immigration', '.policy-pass.claim');
  const claim = () => (fs.existsSync(claimFile()) ? (JSON.parse(fs.readFileSync(claimFile(), 'utf8')) as { owner: string }) : null);
  const start = () => t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'immigration-policy', prompt: 'Run the daily immigration policy pass.' } });
  const fork = (id: string) => t.app.inject({ method: 'POST', url: `/api/sessions/${id}/fork`, headers: t.authedWrite, payload: { prompt: 'Try again.' } });
  const PAUSE = [INIT, result('Which of these two sources should I trust?')];
  const SLOW_PASS = [INIT, { __sleep: 1500 }, result('Pass done.')];
  const LOCK_BUSY = () => {
    throw new Error('.policy-pass.claim.lock is held by another claimant; try again');
  };

  async function settledTo(owner: string | null, seed: string): Promise<void> {
    for (let i = 0; i < 200 && (claim()?.owner ?? null) !== owner; i++) await wait(50);
    expect(claim()?.owner ?? null, `${seed}: the claim's owner`).toBe(owner);
  }
  /** Every pass that is live holds the claim, and no start's claim is left behind. */
  function claimViolations(): string[] {
    const out: string[] = [];
    const owner = claim()?.owner ?? null;
    if (owner?.startsWith('starting:')) out.push(`a start's claim ${owner} is left behind`);
    for (const m of allSessions(t)) {
      if (m.mode === 'immigration-policy' && (m.status === 'running' || m.status === 'queued') && owner !== `session:${m.id}`) out.push(`pass ${m.id} is ${m.status} without the claim (held by ${owner})`);
    }
    return out;
  }
  async function cleanUp(): Promise<void> {
    await quiet(t);
    for (const m of allSessions(t)) await t.sessions.delete(m.id).catch(() => undefined);
    const left = claim()?.owner;
    if (left) policyClaim.release(t.cfg.dataRoot, left);
  }
  async function pausedPass(): Promise<SessionMeta> {
    writePending();
    const res = await withScenario(PAUSE, start);
    expect(res.statusCode, res.body).toBe(202);
    const id = (res.json() as { id: string }).id;
    for (let i = 0; i < 200 && t.sessions.read(id)?.status !== 'awaiting_user'; i++) await wait(50);
    expect(t.sessions.read(id)?.status).toBe('awaiting_user');
    expect(claim()?.owner).toBe(`session:${id}`);
    return t.sessions.read(id)!;
  }

  /** Injected failures: how many times each claim write or batch write throws before it goes through. */
  type Faults = { retag: number; releaseStarting: number; forkBatch: number; managerThrows: boolean };
  function inject(f: Faults, sourceId: string | null): () => void {
    const restores: Array<() => void> = [];
    let retag = f.retag;
    const realRetag = policyClaim.retag;
    const r1 = vi.spyOn(policyClaim, 'retag').mockImplementation((root, from, to) => (retag-- > 0 ? LOCK_BUSY() : realRetag(root, from, to)));
    restores.push(() => r1.mockRestore());
    let rel = f.releaseStarting;
    const realRelease = policyClaim.release;
    const r2 = vi.spyOn(policyClaim, 'release').mockImplementation((root, owner) => (owner.startsWith('starting:') && rel-- > 0 ? LOCK_BUSY() : realRelease(root, owner)));
    restores.push(() => r2.mockRestore());
    let batch = f.forkBatch;
    const store = t.sessions.store;
    const realSet = store.setPolicyBatch.bind(store);
    const r3 = vi.spyOn(store, 'setPolicyBatch').mockImplementation((id, b) => {
      if (id !== sourceId && b !== null && batch-- > 0) throw new Error('EIO: could not write meta.json');
      return realSet(id, b);
    });
    restores.push(() => r3.mockRestore());
    if (f.managerThrows) {
      const r4 = sourceId ? vi.spyOn(SessionManager.prototype, 'fork').mockRejectedValueOnce(new NotFoundError('no such session to fork')) : vi.spyOn(SessionManager.prototype, 'start').mockRejectedValueOnce(new BusyError('another evaluation is already starting'));
      restores.push(() => r4.mockRestore());
    }
    return () => {
      for (const r of restores.reverse()) r();
    };
  }

  async function runStart(f: Faults, seed: string): Promise<void> {
    writePending();
    const restore = inject(f, null);
    let res;
    try {
      res = await withScenario(SLOW_PASS, start);
    } finally {
      // Background retries of a failed cleanup go through the real claim functions from here on.
      restore();
    }
    expect([202, 409], `${seed}: ${res.body}`).toContain(res.statusCode);
    if (res.statusCode === 202) {
      expect(claim()?.owner, seed).toBe(`session:${(res.json() as { id: string }).id}`);
    } else {
      const session = (res.json() as { session?: { id: string } }).session;
      if (session) expect(LIVE.has(t.sessions.read(session.id)!.status), `${seed}: a refused start's session must not run on`).toBe(false);
      await settledTo(null, seed);
    }
    expect(claimViolations(), seed).toEqual([]);
  }

  async function runFork(f: Faults, seed: string): Promise<void> {
    const source = await pausedPass();
    const batch = source.policyBatch;
    expect(batch).toBeTruthy();
    const restore = inject(f, source.id);
    let res;
    try {
      res = await withScenario(SLOW_PASS, () => fork(source.id));
    } finally {
      restore();
    }
    expect([202, 404, 409], `${seed}: ${res.body}`).toContain(res.statusCode);
    if (res.statusCode === 202) {
      const forked = (res.json() as { id: string }).id;
      expect(claim()?.owner, seed).toBe(`session:${forked}`);
      expect(t.sessions.read(forked)!.policyBatch, seed).toBe(batch);
      expect(t.sessions.read(source.id)!.policyBatch, seed).toBeNull();
    } else {
      const session = (res.json() as { session?: { id: string } }).session;
      if (session) {
        expect(LIVE.has(t.sessions.read(session.id)!.status), `${seed}: a refused fork must not run on`).toBe(false);
        expect(t.sessions.read(session.id)!.policyBatch, `${seed}: a refused fork holds no batch`).toBeNull();
      }
      // The pass and its batch stay with the paused source.
      await settledTo(`session:${source.id}`, seed);
      expect(t.sessions.read(source.id)!.policyBatch, seed).toBe(batch);
    }
    expect(claimViolations(), seed).toEqual([]);
  }

  const NONE: Faults = { retag: 0, releaseStarting: 0, forkBatch: 0, managerThrows: false };
  const CASES: Array<{ name: string; op: 'start' | 'fork'; faults: Faults }> = [
    { name: 'nothing fails', op: 'start', faults: NONE },
    { name: 'the handover throws', op: 'start', faults: { ...NONE, retag: 1 } },
    { name: 'the handover and the release of the start claim throw', op: 'start', faults: { ...NONE, retag: 1, releaseStarting: 2 } },
    { name: 'the manager refuses the start', op: 'start', faults: { ...NONE, managerThrows: true } },
    { name: 'the manager refuses the start and the release throws once', op: 'start', faults: { ...NONE, managerThrows: true, releaseStarting: 1 } },
    { name: 'nothing fails', op: 'fork', faults: NONE },
    { name: 'the handover throws', op: 'fork', faults: { ...NONE, retag: 1 } },
    { name: 'the fork\'s batch cannot be written after the fork started', op: 'fork', faults: { ...NONE, forkBatch: 1 } },
    { name: 'the fork\'s batch cannot be written and the claim cannot be given back at first', op: 'fork', faults: { ...NONE, forkBatch: 1, retag: 1 } },
    { name: 'the manager refuses the fork', op: 'fork', faults: { ...NONE, managerThrows: true } },
    { name: 'the manager refuses the fork and the claim cannot be given back at first', op: 'fork', faults: { ...NONE, managerThrows: true, retag: 2 } },
  ];
  for (const c of CASES) {
    it(`given ${c.name}, when a pass is ${c.op === 'start' ? 'started' : 'forked'}, then every live pass holds the claim and no start's claim stays behind`, async () => {
      try {
        await (c.op === 'start' ? runStart(c.faults, c.name) : runFork(c.faults, c.name));
      } finally {
        await cleanUp();
      }
    });
  }

  for (let round = 0; round < 4; round++) {
    const seed = BASE_SEED + 100 + round;
    it(`given claim and batch writes that fail at points drawn from seed ${seed}, then the claim settles to one owner`, async () => {
      const rand = prng(seed);
      const op = rand() < 0.5 ? 'start' : 'fork';
      const faults: Faults = { retag: Math.floor(rand() * 3), releaseStarting: Math.floor(rand() * 3), forkBatch: op === 'fork' ? Math.floor(rand() * 2) : 0, managerThrows: rand() < 0.3 };
      const label = `seed ${seed}: ${op} ${JSON.stringify(faults)}`;
      try {
        await (op === 'start' ? runStart(faults, label) : runFork(faults, label));
      } finally {
        await cleanUp();
      }
    });
  }
});
