// Process inbox (pipeline mode) evaluates every pending Inbox row, so an evaluation of one of them started beside it
// (Batch evaluate, the advisor, a second tab) evaluates, reports and bills that row twice. The pages hold each other
// back, but the server is what every client goes through: it refuses the second start whichever way round it comes.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell } from '../../server/routes/system.js';
import type { SessionMeta } from '../../server/claude/sessions.js';

const call = (app: TestApp, url: string, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url, headers: app.authedWrite, payload });
const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
// Started runs keep writing into the data root after app.close(): cancel every open turn and wait for it to end.
const quiet = async (app: TestApp) => {
  const safe = () => {
    const out: SessionMeta[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions'));
    } catch {
      return out;
    }
    for (const n of names) {
      try {
        const m = app.sessions.read(n);
        if (m) out.push(m);
      } catch {
        // unreadable or half-written meta
      }
    }
    return out;
  };
  const open = (s: SessionMeta) => {
    const last = s.turns.at(-1);
    return !!last && !last.endedAt;
  };
  for (const s of safe()) if (open(s) && (s.status === 'running' || s.status === 'queued')) app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && safe().some(open); i += 1) await new Promise((r) => setTimeout(r, 25));
};

// A pending row of the fixture's data/pipeline.md, and a posting the Inbox does not list as pending.
const INBOX_URL = 'https://jobs.example.com/acme/123';
const DONE_URL = 'https://jobs.example.com/initech/9';
const OUTSIDE_URL = 'https://jobs.example.com/synthetic/99';

const session = (app: TestApp, mode: string, target: SessionMeta['target'], status: SessionMeta['status']) => {
  const meta = app.sessions.store.create({ mode, policyClass: app.sessions.effectivePolicy(mode)!.policyClass, target, model: null, reportNum: null });
  if (status !== 'queued') app.sessions.store.setStatus(meta.id, status);
  return meta;
};
const livePipeline = (app: TestApp, status: SessionMeta['status'] = 'running') => session(app, 'pipeline', { type: 'none', value: null }, status);
const evaluation = (app: TestApp, url: string, status: SessionMeta['status'] = 'running') => session(app, 'oferta', { type: 'url', value: url }, status);
const count = (app: TestApp, mode: string) => app.sessions.store.list().filter((s) => s.mode === mode).length;

async function withApp(fn: (app: TestApp) => Promise<void>, app?: TestApp): Promise<void> {
  const a = app ?? (await freshApp());
  try {
    await fn(a);
  } finally {
    await quiet(a);
    await a.close();
  }
}

describe('an evaluation of a pending Inbox row while Process inbox is live', () => {
  for (const status of ['queued', 'running', 'awaiting_user'] as const) {
    it(`is refused with 409 naming the ${status} Process inbox session, and nothing starts`, async () => {
      await withApp(async (app) => {
        const pipe = livePipeline(app, status);
        const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: INBOX_URL }, prompt: 'evaluate' });
        expect(res.statusCode).toBe(409);
        const error = (res.json() as { error: string }).error;
        expect(error).toContain(pipe.id);
        expect(error).toMatch(/Process inbox/);
        expect(count(app, 'oferta')).toBe(0);
      });
    });
  }

  it('as a Batch evaluate fan-out is refused with 409 before any report number is reserved, and nothing starts', async () => {
    await withApp(async (app) => {
      const pipe = livePipeline(app);
      const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [OUTSIDE_URL, INBOX_URL] });
      expect(res.statusCode).toBe(409);
      const error = (res.json() as { error: string }).error;
      expect(error).toContain(pipe.id);
      expect(error).toContain(INBOX_URL);
      expect(count(app, 'oferta')).toBe(0);
    });
  });

  it('still starts for a posting the Inbox does not list as pending', async () => {
    await withApp(async (app) => {
      livePipeline(app);
      for (const url of [OUTSIDE_URL, DONE_URL]) {
        const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'evaluate' });
        expect(res.statusCode).toBe(202);
      }
    });
  });

  it('starts once the Process inbox session has ended', async () => {
    await withApp(async (app) => {
      livePipeline(app, 'done');
      const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: INBOX_URL }, prompt: 'evaluate' });
      expect(res.statusCode).toBe(202);
    });
  });
});

describe('a Process inbox start while evaluations of its pending rows run', () => {
  const startPipeline = (app: TestApp) => call(app, '/api/sessions', { mode: 'pipeline', prompt: 'Process the pending pipeline rows' });

  for (const status of ['queued', 'running', 'awaiting_user'] as const) {
    it(`is refused with 409 naming the ${status} evaluation, and nothing starts`, async () => {
      await withApp(async (app) => {
        const live = evaluation(app, INBOX_URL, status);
        const res = await startPipeline(app);
        expect(res.statusCode).toBe(409);
        const error = (res.json() as { error: string }).error;
        expect(error).toContain(live.id);
        expect(error).toContain(INBOX_URL);
        expect(count(app, 'pipeline')).toBe(0);
      });
    });
  }

  it('is refused with 409 while a Batch evaluate is still starting a pending row', async () => {
    // Hold the fan-out at its first child call, so its URL is claimed but no session exists yet.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const app = await makeTestApp(
      { dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') },
      {
        exec: async (cmd, args, opts) => {
          if (!gated) {
            gated = true;
            await gate;
          }
          return execNoShell(cmd, args, opts);
        },
      },
    );
    await withApp(async () => {
      const fanP = app.sessions.fanOut({ mode: 'oferta', urls: [INBOX_URL] });
      let res;
      try {
        res = await startPipeline(app);
      } finally {
        release();
      }
      await fanP;
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(INBOX_URL);
      expect(count(app, 'pipeline')).toBe(0);
    }, app);
  });

  it('still starts when the live evaluations are of postings the Inbox does not list as pending', async () => {
    await withApp(async (app) => {
      evaluation(app, OUTSIDE_URL);
      evaluation(app, DONE_URL);
      evaluation(app, INBOX_URL, 'done');
      const res = await startPipeline(app);
      expect(res.statusCode).toBe(202);
    });
  });
});

describe('a reply or fork of a finished Process inbox run while evaluations of its pending rows run', () => {
  for (const route of ['turns', 'fork'] as const) {
    it(`POST /${route} is refused with 409 naming the evaluation, and nothing starts`, async () => {
      await withApp(async (app) => {
        const pipe = livePipeline(app, 'done');
        const live = evaluation(app, INBOX_URL);
        const res = await call(app, `/api/sessions/${pipe.id}/${route}`, { prompt: 'carry on' });
        expect(res.statusCode).toBe(409);
        const error = (res.json() as { error: string }).error;
        expect(error).toContain(live.id);
        expect(count(app, 'pipeline')).toBe(1);
        expect(app.sessions.read(pipe.id)!.turns).toHaveLength(0);
      });
    });
  }
});

describe('an evaluation of a pending Inbox row while a reply to a finished Process inbox run is starting', () => {
  it('is refused with 409: the run carries on over the pending rows, though it still reads done until its turn begins', async () => {
    // Hold the reply's turn at its token read, so the request is under way while the run still reads done.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading!: () => void;
    let held = false;
    const tokenRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const app = await makeTestApp(
      { dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') },
      {
        // Only the reply's read is held: an evaluation the server wrongly lets through must not wait on it too.
        readToken: async () => {
          if (!held) {
            held = true;
            reading();
            await gate;
          }
          return 'fake-oauth-token-for-tests';
        },
      },
    );
    await withApp(async () => {
      const pipe = livePipeline(app, 'done');
      const replyP = call(app, `/api/sessions/${pipe.id}/turns`, { prompt: 'carry on' });
      let res;
      try {
        await tokenRead;
        expect(app.sessions.read(pipe.id)!.status).toBe('done');
        res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: INBOX_URL }, prompt: 'evaluate' });
      } finally {
        release();
      }
      expect((await replyP).statusCode).toBe(202);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(pipe.id);
      expect(count(app, 'oferta')).toBe(0);
    }, app);
  });
});

describe('a reply or fork of an evaluation of a pending Inbox row while Process inbox is live', () => {
  for (const route of ['turns', 'fork'] as const) {
    it(`POST /${route} is refused with 409 naming the Process inbox session, and nothing starts`, async () => {
      await withApp(async (app) => {
        const pipe = livePipeline(app);
        const ended = evaluation(app, INBOX_URL, 'error');
        const res = await call(app, `/api/sessions/${ended.id}/${route}`, { prompt: 'retry' });
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(pipe.id);
        expect(count(app, 'oferta')).toBe(1);
        expect(app.sessions.read(ended.id)!.turns).toHaveLength(0);
      });
    });
  }
});

describe('a Process inbox start while a reply to a finished evaluation of a pending row is starting', () => {
  it('is refused with 409: the evaluation carries on, though it still reads done until its turn begins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading!: () => void;
    let held = false;
    const tokenRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const app = await makeTestApp(
      { dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') },
      {
        // Only the reply's read is held: a Process inbox start the server wrongly lets through must not wait on it too.
        readToken: async () => {
          if (!held) {
            held = true;
            reading();
            await gate;
          }
          return 'fake-oauth-token-for-tests';
        },
      },
    );
    await withApp(async () => {
      const ended = evaluation(app, INBOX_URL, 'done');
      const replyP = call(app, `/api/sessions/${ended.id}/turns`, { prompt: 'one more thing' });
      let res;
      try {
        await tokenRead;
        expect(app.sessions.read(ended.id)!.status).toBe('done');
        res = await call(app, '/api/sessions', { mode: 'pipeline', prompt: 'Process the pending pipeline rows' });
      } finally {
        release();
      }
      expect((await replyP).statusCode).toBe(202);
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(ended.id);
      expect(count(app, 'pipeline')).toBe(0);
    }, app);
  });
});

describe('a second Process inbox run while one is live', () => {
  it('a start is refused with 409 naming the live run, and nothing starts', async () => {
    await withApp(async (app) => {
      const pipe = livePipeline(app);
      const res = await call(app, '/api/sessions', { mode: 'pipeline', prompt: 'Process the pending pipeline rows' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(pipe.id);
      expect(count(app, 'pipeline')).toBe(1);
    });
  });

  for (const route of ['turns', 'fork'] as const) {
    it(`POST /${route} of another, finished run is refused with 409 naming the live run, and nothing starts`, async () => {
      await withApp(async (app) => {
        const old = livePipeline(app, 'done');
        const pipe = livePipeline(app);
        const res = await call(app, `/api/sessions/${old.id}/${route}`, { prompt: 'carry on' });
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(pipe.id);
        expect(count(app, 'pipeline')).toBe(2);
        expect(app.sessions.read(old.id)!.turns).toHaveLength(0);
      });
    });
  }

  it('a fork of the run waiting for the reply carries that run on, so it is not refused over it', async () => {
    await withApp(async (app) => {
      const waiting = livePipeline(app, 'awaiting_user');
      const res = await call(app, `/api/sessions/${waiting.id}/fork`, { prompt: 'carry on' });
      expect(res.statusCode).toBe(202);
    });
  });
});

describe('the forks of one Process inbox run', () => {
  const forkOf = (app: TestApp, source: SessionMeta, status: SessionMeta['status']) => {
    const meta = app.sessions.store.create({ mode: 'pipeline', policyClass: source.policyClass, target: source.target, model: null, forkedFrom: source.id });
    app.sessions.store.setStatus(meta.id, status);
    return meta;
  };

  for (const route of ['turns', 'fork'] as const) {
    it(`POST /${route} of a fork waiting for a reply goes on beside the paused run it forked`, async () => {
      await withApp(async (app) => {
        const source = livePipeline(app, 'awaiting_user');
        const fork = forkOf(app, source, 'awaiting_user');
        const res = await call(app, `/api/sessions/${fork.id}/${route}`, { prompt: 'carry on' });
        expect(res.statusCode).toBe(202);
      });
    });
  }

  for (const status of ['queued', 'running'] as const) {
    it(`a fork of a ${status} run is refused with 409: both would process the pending rows at once`, async () => {
      await withApp(async (app) => {
        const pipe = livePipeline(app, status);
        const res = await call(app, `/api/sessions/${pipe.id}/fork`, { prompt: 'carry on' });
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(pipe.id);
        expect(count(app, 'pipeline')).toBe(1);
      });
    });
  }
});

describe('another spelling of a pending Inbox row URL (R25-shared-comp-L2-01)', () => {
  // The same posting as INBOX_URL by the key POST /api/pipeline/add dedups on: a tracking param and a trailing slash.
  const RESPELLED = 'https://jobs.example.com/acme/123/?utm_source=linkedin';

  it('an evaluation of it while Process inbox is live is refused with 409 naming the Process inbox session, and nothing starts', async () => {
    await withApp(async (app) => {
      const pipe = livePipeline(app);
      const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: RESPELLED }, prompt: 'evaluate' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(pipe.id);
      expect(count(app, 'oferta')).toBe(0);
    });
  });

  it('a Process inbox start while an evaluation of it runs is refused with 409 naming the evaluation, and nothing starts', async () => {
    await withApp(async (app) => {
      const live = evaluation(app, RESPELLED);
      const res = await call(app, '/api/sessions', { mode: 'pipeline', prompt: 'Process the pending pipeline rows' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
      expect(count(app, 'pipeline')).toBe(0);
    });
  });

  it('a second evaluation of it while an evaluation of the row runs is refused with 409 naming that evaluation, and nothing starts', async () => {
    await withApp(async (app) => {
      const live = evaluation(app, INBOX_URL);
      const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: RESPELLED }, prompt: 'evaluate' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
      expect(count(app, 'oferta')).toBe(1);
    });
  });

  it('a Batch evaluate of it while an evaluation of the row runs starts nothing for it and reserves no number for it', async () => {
    await withApp(async (app) => {
      const live = evaluation(app, INBOX_URL);
      const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [RESPELLED, OUTSIDE_URL] });
      expect(res.statusCode).toBe(202);
      const fan = res.json() as { sessions: Array<{ status: string; error?: string; target: { value: string } }>; reserved: number[] };
      expect(fan.reserved).toHaveLength(1);
      expect(fan.sessions.filter((s) => s.status !== 'error').map((s) => s.target.value)).toEqual([OUTSIDE_URL]);
      expect(fan.sessions.find((s) => s.target.value === RESPELLED)!.error).toContain(live.id);
    });
  });

  it('a Batch evaluate naming it twice, spelled two ways, starts one evaluation and reserves one number', async () => {
    await withApp(async (app) => {
      const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [OUTSIDE_URL, `${OUTSIDE_URL}/?utm_source=linkedin`] });
      expect(res.statusCode).toBe(202);
      const fan = res.json() as { sessions: Array<{ status: string; error?: string; target: { value: string } }>; reserved: number[] };
      expect(fan.reserved).toHaveLength(1);
      expect(fan.sessions.filter((s) => s.status !== 'error').map((s) => s.target.value)).toEqual([OUTSIDE_URL]);
      expect(fan.sessions.find((s) => s.status === 'error')!.error).toContain(OUTSIDE_URL);
    });
  });
});
