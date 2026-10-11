// A tailored CV (pdf mode) for a tracker row is one paid session that writes that row's CV. The Apply page and the Ask
// drawer each check the browser's copy of the sessions list, which can be stale, so the server refuses a second start
// for a row whose pdf session is still live (R19-shared-comp-L1-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
