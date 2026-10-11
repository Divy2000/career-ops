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
