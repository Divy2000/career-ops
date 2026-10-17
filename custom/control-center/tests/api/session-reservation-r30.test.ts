import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import type { SessionEvent } from '../../server/claude/stream-parse.js';

type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);

describe('a first turn that cannot start while its events cannot be written (R30-claude-L1-01)', () => {
  it('given a Batch evaluate of two postings whose first cannot start and whose error event cannot be appended, when the batch starts, then both sessions are answered and both reserved numbers go back to the pool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    const append = app.sessions.store.appendEvent.bind(app.sessions.store);
    const first: string[] = [];
    vi.spyOn(app.sessions.store, 'appendEvent').mockImplementation((id: string, event: SessionEvent) => {
      if (first.length === 0) first.push(id);
      if (id === first[0]) throw new Error('timed out waiting for the session events lock');
      return append(id, event);
    });
    try {
      const res = await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r30-l1-a', 'https://jobs.example.com/synthetic/r30-l1-b'] });
      expect(res.statusCode, res.body).toBe(202);
      const body = res.json() as { sessions: Array<{ id: string; status: string; reportNum: number | null }>; reserved: number[] };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions.map((s) => s.status)).toEqual(['error', 'error']);
      expect(body.sessions.map((s) => s.reportNum)).toEqual([null, null]);
      for (const n of body.reserved) expect(fs.existsSync(sentinelPath(app, n))).toBe(false);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  });
  it('given a Batch evaluate of two postings whose first cannot start and whose session record cannot be settled, when the batch starts, then the second still starts and both are answered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    const setStatus = app.sessions.store.setStatus.bind(app.sessions.store);
    const first: string[] = [];
    vi.spyOn(app.sessions.store, 'setStatus').mockImplementation((id, status, error) => {
      if (first.length === 0) first.push(id);
      if (id === first[0] && status === 'error') throw new Error('ENOSPC: no space left on device, write');
      return setStatus(id, status, error);
    });
    try {
      const res = await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r30-l1-c', 'https://jobs.example.com/synthetic/r30-l1-d'] });
      expect(res.statusCode, res.body).toBe(202);
      const body = res.json() as { sessions: Array<{ id: string; status: string; reportNum: number | null }>; reserved: number[] };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[1]).toMatchObject({ status: 'error', reportNum: null });
      expect(fs.existsSync(sentinelPath(app, body.reserved[1]!))).toBe(false);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  });
});
