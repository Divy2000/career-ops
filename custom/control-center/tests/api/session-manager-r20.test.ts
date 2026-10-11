import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { SessionStore, sessionsDir } from '../../server/claude/sessions.js';
import { tempDir } from '../helpers/tmp.js';

const call = (app: Awaited<ReturnType<typeof makeTestApp>>, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });

describe('session list: one unreadable session folder (R20-claude-L3-01)', () => {
  it('given a session whose meta.json is truncated, when the server starts and the Sessions list loads, then that session is skipped and every other one is listed', async () => {
    const dataRoot = copyFixtureRoot();
    const store = new SessionStore(dataRoot, tempDir('cc-r20-guard-'));
    const good = store.create({ mode: 'devchat', policyClass: 'devchat', target: { type: 'none', value: null }, model: null });
    store.setStatus(good.id, 'done');
    const bad = store.create({ mode: 'devchat', policyClass: 'devchat', target: { type: 'none', value: null }, model: null });
    fs.writeFileSync(path.join(sessionsDir(dataRoot), bad.id, 'meta.json'), '');
    const app = await makeTestApp({ dataRoot });
    try {
      const res = await call(app, 'GET', '/api/sessions');
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as Array<{ id: string }>).map((m) => m.id)).toEqual([good.id]);
    } finally {
      await app.close();
    }
  });
});
