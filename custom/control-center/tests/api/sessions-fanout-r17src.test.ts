// Batch evaluate starts no second evaluation of a posting a live session of the same mode is already evaluating:
// both would write a report and a tracker row for it (R16-feata-01). The pages leave such URLs out too, but the
// server is what every client goes through.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const call = (app: TestApp, url: string, payload: Record<string, unknown>) => app.app.inject({ method: 'POST', url, headers: app.authedWrite, payload });
const freshApp = () => makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
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
        await app.close();
      }
    });
  }

  it('starts an evaluation of a URL whose earlier session ended', async () => {
    const app = await freshApp();
    try {
      const old = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: LIVE_URL }, model: null, reportNum: null });
      app.sessions.store.setStatus(old.id, 'done');
      const fan = (await call(app, '/api/sessions/fanout', { mode: 'oferta', urls: [LIVE_URL] })).json() as Fan;
      expect(fan.reserved).toHaveLength(1);
      expect(fan.sessions[0]!.status).not.toBe('error');
    } finally {
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
      await app.close();
    }
  });
});
