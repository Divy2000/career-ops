import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import type { BusEvent } from '../../server/watch/bus.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('session manager: a cancel while a failed first turn releases its number (R22-claude-L1-01)', () => {
  it('given a batch-evaluate first turn that cannot start, when the user cancels while its report number is being released, then the session ends with one outcome: error, in the store, the event stream and the bus', async () => {
    let releasing = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // The release of the reserved number waits (a busy tracker lock) until the test lets it go.
    const exec: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) {
        releasing = true;
        await gate;
      }
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, { exec, readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    const published: Array<{ sessionId: string; status: string }> = [];
    const off = app.bus.onEvent((ev: BusEvent) => {
      if (ev.type === 'session.status') published.push(ev.payload as { sessionId: string; status: string });
    });
    try {
      const pending = app.app.inject({ method: 'POST', url: '/api/sessions/fanout', headers: app.authedWrite, payload: { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r22-mgr-cancel'] } });
      const deadline = Date.now() + 10_000;
      while (!releasing && Date.now() < deadline) await wait(10);
      expect(releasing).toBe(true);
      const [session] = app.sessions.list();
      app.sessions.cancel(session!.id);
      open();
      const res = await pending;
      expect(res.statusCode, res.body).toBe(202);
      const answered = (res.json().sessions as Array<{ id: string; status: string }>)[0]!;
      const stored = app.sessions.read(session!.id)!;
      const statuses = app.sessions.store.readEvents(session!.id).map((e) => e.event).filter((e) => e.type === 'status').map((e) => (e as { status: string }).status);
      expect(stored.status).toBe('error');
      expect(answered.status).toBe('error');
      expect(statuses).toEqual(['error']);
      expect(published.filter((p) => p.sessionId === session!.id).map((p) => p.status)).toEqual(['error']);
    } finally {
      off();
      open();
      await app.close();
    }
  });
});
