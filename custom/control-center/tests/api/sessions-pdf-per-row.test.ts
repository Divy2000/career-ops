// A tailored CV (pdf mode) for a tracker row is one paid session that writes that row's CV. The Apply page and the Ask
// drawer each check the browser's copy of the sessions list, which can be stale, so the server refuses a second start
// for a row whose pdf session is still live (R19-shared-comp-L1-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import type { SessionMeta } from '../../server/claude/sessions.js';

const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
const startPdf = (app: TestApp, row: string) =>
  app.app.inject({ method: 'POST', url: '/api/sessions', headers: app.authedWrite, payload: { mode: 'pdf', target: { type: 'app', value: row }, prompt: `Generate the tailored CV PDF for tracker row #${row}.` } });
const pdfSession = (app: TestApp, row: string, status: SessionMeta['status']) => {
  const meta = app.sessions.store.create({ mode: 'pdf', policyClass: app.sessions.effectivePolicy('pdf')!.policyClass, target: { type: 'app', value: row }, model: null, reportNum: null });
  if (status !== 'queued') app.sessions.store.setStatus(meta.id, status);
  return meta;
};
const pdfCount = (app: TestApp) => app.sessions.store.list().filter((s) => s.mode === 'pdf').length;
// Started runs keep writing into the data root after app.close(): cancel every open turn and wait for it to end.
const quiet = async (app: TestApp) => {
  const dir = path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions');
  const all = () => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => app.sessions.read(n)).filter((m): m is SessionMeta => m !== null) : []);
  const open = (s: SessionMeta) => !!s.turns.at(-1) && !s.turns.at(-1)!.endedAt;
  for (const s of all()) if (open(s) && (s.status === 'running' || s.status === 'queued')) app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && all().some(open); i += 1) await new Promise((r) => setTimeout(r, 25));
};
async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  const app = await freshApp();
  try {
    await fn(app);
  } finally {
    await quiet(app);
    await app.close();
  }
}

describe('a tailored CV start for a row whose pdf session is live', () => {
  for (const status of ['queued', 'running', 'awaiting_user'] as const) {
    it(`is refused with 409 naming the ${status} session, and nothing starts`, async () => {
      await withApp(async (app) => {
        const live = pdfSession(app, '12', status);
        const res = await startPdf(app, '12');
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(live.id);
        expect(pdfCount(app)).toBe(1);
      });
    });
  }

  it('still starts for another row, and for the same row once its session has ended', async () => {
    await withApp(async (app) => {
      pdfSession(app, '12', 'running');
      pdfSession(app, '7', 'done');
      expect((await startPdf(app, '3')).statusCode).toBe(202);
      expect((await startPdf(app, '7')).statusCode).toBe(202);
    });
  });

  it('refuses the second of two starts sent together for the same row', async () => {
    await withApp(async (app) => {
      const [a, b] = await Promise.all([startPdf(app, '12'), startPdf(app, '12')]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
      expect(pdfCount(app)).toBe(1);
    });
  });
});

describe('a reply to or fork of a tailored CV session while another for its row is live', () => {
  const turn = (app: TestApp, id: string, kind: 'turns' | 'fork') => app.app.inject({ method: 'POST', url: `/api/sessions/${id}/${kind}`, headers: app.authedWrite, payload: { prompt: 'carry on' } });

  it('a reply to a finished one is refused with 409 naming the live one', async () => {
    await withApp(async (app) => {
      const live = pdfSession(app, '12', 'running');
      const done = pdfSession(app, '12', 'done');
      const res = await turn(app, done.id, 'turns');
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
    });
  });

  for (const status of ['queued', 'running'] as const) {
    it(`a fork of the ${status} one is refused with 409, and nothing starts`, async () => {
      await withApp(async (app) => {
        const live = pdfSession(app, '12', status);
        const res = await turn(app, live.id, 'fork');
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(live.id);
        expect(pdfCount(app)).toBe(1);
      });
    });
  }

  it('a fork of one waiting for the user and its source both still take a reply once paused', async () => {
    await withApp(async (app) => {
      const source = pdfSession(app, '12', 'awaiting_user');
      const fork = app.sessions.store.create({ mode: 'pdf', policyClass: source.policyClass, target: source.target, model: null, forkedFrom: source.id });
      app.sessions.store.setStatus(fork.id, 'awaiting_user');
      expect((await turn(app, fork.id, 'turns')).statusCode).toBe(202);
      await quiet(app);
      app.sessions.store.setStatus(fork.id, 'awaiting_user');
      expect((await turn(app, source.id, 'turns')).statusCode).toBe(202);
    });
  });

  it('of two paused ones of the same lineage, only one of two replies sent together goes on', async () => {
    await withApp(async (app) => {
      const source = pdfSession(app, '12', 'awaiting_user');
      const fork = app.sessions.store.create({ mode: 'pdf', policyClass: source.policyClass, target: source.target, model: null, forkedFrom: source.id });
      app.sessions.store.setStatus(fork.id, 'awaiting_user');
      // The first reply is held in flight before its turn begins (the token read), so its session still reads paused.
      const send = app.sessions.send.bind(app.sessions);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const spy = vi.spyOn(app.sessions, 'send').mockImplementationOnce(async (...args) => {
        await held;
        return send(...args);
      });
      const first = turn(app, source.id, 'turns');
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      const second = await turn(app, fork.id, 'turns');
      release();
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: string }).error).toContain(source.id);
      expect((await first).statusCode).toBe(202);
    });
  });

  it('two paused ones of different lineages (from before this guard) do not block each other for good', async () => {
    await withApp(async (app) => {
      pdfSession(app, '12', 'awaiting_user');
      const other = pdfSession(app, '12', 'awaiting_user');
      expect((await turn(app, other.id, 'turns')).statusCode).toBe(202);
    });
  });

  it('a reply to the one waiting for the user goes on: it is the live session', async () => {
    await withApp(async (app) => {
      const paused = pdfSession(app, '12', 'awaiting_user');
      expect((await turn(app, paused.id, 'turns')).statusCode).toBe(202);
    });
  });
});

describe('a tailored CV start naming the row with spaces or leading zeros', () => {
  for (const row of [' 12', '12 ', '012']) {
    it(`"${row}" is refused while row 12's session is live`, async () => {
      await withApp(async (app) => {
        const live = pdfSession(app, '12', 'running');
        const res = await startPdf(app, row);
        expect(res.statusCode).toBe(409);
        expect((res.json() as { error: string }).error).toContain(live.id);
      });
    });
  }
});
