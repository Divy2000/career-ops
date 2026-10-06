// Session events ride the app's one event stream (/api/events) as session.event frames, so a page that follows any
// number of sessions holds one connection, not one per session plus the app's (the browser's 6-per-host HTTP/1.1
// limit stalled every request at five running sessions). Seed from SW3-web-a-01.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import type { BusEvent } from '../../server/watch/bus.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];

describe('session events on the app event stream', () => {
  it('publishes every stored event of a session, once and in order, as a session.event frame naming the session', async () => {
    const frames: BusEvent[] = [];
    const off = t.bus.onEvent((ev) => ev.type === 'session.event' && void frames.push(ev));
    try {
      const res = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'pdf', target: { type: 'app', value: '1' }, prompt: 'Render the CV' } });
      expect(res.statusCode, res.body).toBe(202);
      const id = res.json().id as string;
      let stored: Array<{ seq: number; ts: string; event: { type: string } }> = [];
      for (let i = 0; i < 300; i++) {
        const body = (await t.app.inject({ method: 'GET', url: `/api/sessions/${id}`, headers: t.authed })).json();
        stored = body.events;
        if (TERMINAL.includes(body.meta.status) && frames.filter((f) => (f.payload as { sessionId: string }).sessionId === id).length >= stored.length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const mine = frames.map((f) => f.payload as { sessionId: string; stored: { seq: number; ts: string; event: { type: string } } }).filter((p) => p.sessionId === id);
      expect(stored.length).toBeGreaterThan(1);
      // seq and event as stored (the manager stamps its live copy's ts a moment apart from the stored one).
      const shape = (e: { seq: number; event: { type: string } }) => ({ seq: e.seq, event: e.event });
      expect(mine.map((p) => shape(p.stored))).toEqual(stored.map(shape));
    } finally {
      off();
    }
  });
});
