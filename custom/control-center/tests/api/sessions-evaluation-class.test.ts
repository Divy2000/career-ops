// Every report-gated mode (oferta, auto-pipeline, a localized oferta) evaluates a posting the same way: each writes a
// report and a tracker row for it, so a live evaluation in one of them holds the posting against the others too, for
// a single start, a Batch evaluate and a replayed original request alike (R19-srv-core-L3-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const call = (app: TestApp, url: string, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url, headers: app.authedWrite, payload });
const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
// A started run keeps writing into its data root after app.close(): cancel open turns and wait for them to end.
const quiet = async (app: TestApp) => {
  const safe = () => {
    const out: Array<{ id: string; status: string; turns: Array<{ endedAt: string | null }> }> = [];
    const dir = path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions');
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const n of names) {
      try { const m = app.sessions.read(n); if (m) out.push(m); } catch { /* unreadable or half-written meta */ }
    }
    return out;
  };
  const open = (s: { turns: Array<{ endedAt: string | null }> }) => { const last = s.turns.at(-1); return !!last && !last.endedAt; };
  for (const s of safe()) if (open(s) && (s.status === 'running' || s.status === 'queued')) app.sessions.cancel(s.id);
  for (let i = 0; i < 400 && safe().some(open); i += 1) await new Promise((r) => setTimeout(r, 25));
};
const URL_A = 'https://jobs.example.com/synthetic/l3-01';
const OTHER_URL = 'https://jobs.example.com/synthetic/l3-02';
const target = (value: string) => ({ type: 'url' as const, value });
type Fan = { sessions: Array<{ status: string; error?: string; target: { value: string } }>; reserved: number[] };

function liveSession(app: TestApp, mode: string, status: 'running' | 'awaiting_user' = 'running') {
  const meta = app.sessions.store.create({ mode, policyClass: 'evaluate', target: target(URL_A), model: null, reportNum: null });
  app.sessions.store.setStatus(meta.id, status);
  return meta;
}

describe('a live evaluation holds its posting against every report-gated mode', () => {
  for (const [held, starting] of [['auto-pipeline', 'oferta'], ['oferta', 'auto-pipeline'], ['oferta', 'de/angebot']] as const) {
    it(`given a live ${held} session on a URL, when a single ${starting} start names it, then it is refused with 409`, async () => {
      const app = await freshApp();
      try {
        const live = liveSession(app, held);
        const res = await call(app, '/api/sessions', { mode: starting, target: target(URL_A), prompt: 'evaluate' });
        expect(res.statusCode, res.body).toBe(409);
        expect((res.json() as { error: string }).error).toContain(live.id);
      } finally {
        await quiet(app);
        await app.close();
      }
    });
  }

  it('given a live auto-pipeline session on a URL, when Batch evaluate (oferta) names it, then that URL is not started and gets no number', async () => {
    const app = await freshApp();
    try {
      const live = liveSession(app, 'auto-pipeline');
      const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [URL_A, OTHER_URL] });
      expect(res.statusCode, res.body).toBe(202);
      const fan = res.json() as Fan;
      expect(fan.reserved).toHaveLength(1);
      const refused = fan.sessions.find((s) => s.target.value === URL_A)!;
      expect(refused.status).toBe('error');
      expect(refused.error).toContain(live.id);
      expect(fan.sessions.filter((s) => s.status !== 'error').map((s) => s.target.value)).toEqual([OTHER_URL]);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a Batch evaluate (oferta) starting a URL, when any report-gated mode asks, then the URL reads as starting', async () => {
    const app = await freshApp();
    try {
      const fan = app.sessions.fanOut({ mode: 'oferta', urls: [URL_A] });
      try {
        expect(app.sessions.isStartingInBatch('auto-pipeline', target(URL_A))).toBe(true);
        expect(app.sessions.isStartingInBatch('de/angebot', target(URL_A))).toBe(true);
      } finally {
        await fan.catch(() => undefined);
      }
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a live auto-pipeline session on a URL, when an oferta session that never started its conversation is replied to, then the replay is refused with 409', async () => {
    const app = await freshApp();
    try {
      const live = liveSession(app, 'auto-pipeline');
      const stale = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: target(URL_A), model: null, reportNum: null });
      app.sessions.store.setStatus(stale.id, 'error');
      const res = await call(app, `/api/sessions/${stale.id}/turns`, { prompt: 'retry' });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('given a live session of a mode that writes no report on a URL, when an oferta start names it, then it starts', async () => {
    const app = await freshApp();
    try {
      app.sessions.store.create({ mode: 'deep', policyClass: 'read-only', target: target(URL_A), model: null, reportNum: null });
      const res = await call(app, '/api/sessions', { mode: 'oferta', target: target(URL_A), prompt: 'evaluate' });
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      await quiet(app);
      await app.close();
    }
  });
});
