// Batch evaluate starts no second evaluation of a posting a live session of the same mode is already evaluating:
// both would write a report and a tracker row for it (R16-feata-01). The pages leave such URLs out too, but the
// server is what every client goes through.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell } from '../../server/routes/system.js';

const call = (app: TestApp, url: string, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url, headers: app.authedWrite, payload });
const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
// A fan-out starts real runs. app.close() clears timers but does not kill a running child, which would keep writing
// into its data root after teardown and leave a directory behind. Stop every started run and wait for it to end.
const quiet = async (app: TestApp) => {
  // A fan-out starts real runs. app.close() clears timers but does not kill a running child, which would keep writing
  // into its data root after teardown and leave a directory behind. Cancel the runs whose turn is still open and wait
  // for those turns to end (a cancelled session's status flips at once, so wait on the turn's endedAt, not the status).
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
const LIVE_URL = 'https://jobs.example.com/synthetic/71';
const OTHER_URL = 'https://jobs.example.com/synthetic/72';
type Fan = { sessions: Array<{ id: string; status: string; error?: string; reportNum: number | null; target: { value: string } }>; reserved: number[] };

describe('fan-out and a live evaluation of the same posting', () => {
  for (const status of ['queued', 'running', 'awaiting_user'] as const) {
    it(`does not start a second evaluation of a URL a ${status} session evaluates, and reserves no number for it`, async () => {
      const app = await freshApp();
      try {
        const live = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: LIVE_URL }, model: null, reportNum: null });
        if (status !== 'queued') app.sessions.store.setStatus(live.id, status);
        const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL, OTHER_URL] });
        expect(res.statusCode).toBe(202);
        const fan = res.json() as Fan;
        expect(fan.reserved).toHaveLength(1);
        const started = fan.sessions.filter((s) => s.status !== 'error');
        expect(started.map((s) => s.target.value)).toEqual([OTHER_URL]);
        expect(started[0]!.reportNum).toBe(fan.reserved[0]);
        const refused = fan.sessions.find((s) => s.target.value === LIVE_URL)!;
        expect(refused).toMatchObject({ status: 'error', reportNum: null });
        expect(refused.error).toContain(live.id);
        expect(app.sessions.store.list().filter((s) => s.target.value === LIVE_URL)).toHaveLength(1);
      } finally {
        await quiet(app);
        await app.close();
      }
    });
  }

  it('refuses a single start of a posting a live session of the same mode already evaluates (R16-feata-01 review)', async () => {
    const app = await freshApp();
    try {
      const live = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: LIVE_URL }, model: null, reportNum: null });
      app.sessions.store.setStatus(live.id, 'running');
      const res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: LIVE_URL }, prompt: 'evaluate' });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toContain(live.id);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('starts an evaluation of a URL whose earlier session ended', async () => {
    const app = await freshApp();
    try {
      const old = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: LIVE_URL }, model: null, reportNum: null });
      app.sessions.store.setStatus(old.id, 'done');
      const fan = (await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL] })).json() as Fan;
      expect(fan.reserved).toHaveLength(1);
      expect(fan.sessions[0]!.status).not.toBe('error');
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('two fan-outs of the same URL at once start one evaluation', async () => {
    const app = await freshApp();
    try {
      const [a, b] = await Promise.all([call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL] }), call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL] })]);
      const sessions = [...(a.json() as Fan).sessions, ...(b.json() as Fan).sessions];
      expect(sessions.filter((s) => s.status !== 'error')).toHaveLength(1);
      expect(app.sessions.store.list().filter((s) => s.target.value === LIVE_URL)).toHaveLength(1);
      expect((a.json() as Fan).reserved.length + (b.json() as Fan).reserved.length).toBe(1);
    } finally {
      await quiet(app);
      await app.close();
    }
  });

  it('refuses a single start of a URL a batch evaluate is already starting (R16-feata-01 review)', async () => {
    // Hold the fan-out at its first child call, so its URL is claimed but no session exists yet.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    const app = await makeTestApp({}, {
      exec: async (cmd, args, opts) => {
        if (!gated) { gated = true; await gate; }
        return execNoShell(cmd, args, opts);
      },
    });
    try {
      const fanP = app.sessions.fanOut({ mode: 'oferta', urls: [LIVE_URL] });
      let res;
      try {
        res = await call(app, '/api/sessions', { mode: 'oferta', target: { type: 'url', value: LIVE_URL }, prompt: 'evaluate' });
      } finally {
        release();
      }
      expect(res.statusCode).toBe(409);
      const fan = await fanP;
      expect(fan.sessions.filter((s) => s.status !== 'error')).toHaveLength(1);
      expect(app.sessions.store.list().filter((s) => s.target.value === LIVE_URL)).toHaveLength(1);
    } finally {
      release();
      await quiet(app);
      await app.close();
    }
  });

  it('still refuses a live posting when another session folder holds an unreadable meta.json', async () => {
    const app = await freshApp();
    try {
      const corrupt = path.join(app.cfg.dataRoot, 'data', 'control-center', 'sessions', 's20200101000000-c0ffee');
      fs.mkdirSync(corrupt, { recursive: true });
      fs.writeFileSync(path.join(corrupt, 'meta.json'), '{');
      const live = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: LIVE_URL }, model: null, reportNum: null });
      app.sessions.store.setStatus(live.id, 'running');
      const res = await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL, OTHER_URL] });
      expect(res.statusCode).toBe(202);
      const fan = res.json() as Fan;
      expect(fan.sessions.filter((s) => s.status !== 'error').map((s) => s.target.value)).toEqual([OTHER_URL]);
      expect(fan.sessions.find((s) => s.target.value === LIVE_URL)!.error).toContain(live.id);
    } finally {
      await quiet(app);
      await app.close();
    }
  });
});
