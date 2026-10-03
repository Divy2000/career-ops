import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const put = (url: string, payload: Record<string, unknown>, ifMatch?: string) => t.app.inject({ method: 'PUT', url, headers: { ...t.authedWrite, ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload });

describe('portals.yml editor', () => {
  it('reads the raw file with its ETag and rejects unknown keys', async () => {
    const res = await get('/api/config/portals');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'portals', path: 'portals.yml', kind: 'ok' });
    expect(res.json().raw).toContain('title_filter');
    expect((await get('/api/config/secrets')).statusCode).toBe(404);
  });

  it('an invalid portals file returns 422 from validate-portals and nothing is written', async () => {
    const before = (await get('/api/config/portals')).json();
    const res = await put('/api/config/portals', { raw: 'title_filter: [unclosed\n  nope' }, before.etag);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/validatePortals rejected/);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'portals.yml'), 'utf8')).toBe(before.raw);
    expect(fs.readdirSync(path.join(t.cfg.dataRoot, 'data', 'control-center', 'tmp')).filter((f) => f.startsWith('portals-'))).toEqual([]);
  });

  it('a valid edit with the current ETag is written verbatim (comments kept) and a stale ETag conflicts', async () => {
    const before = (await get('/api/config/portals')).json();
    const raw = `# edited by the Control Center test\n${before.raw}`;
    const ok = await put('/api/config/portals', { raw }, before.etag);
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(200);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'portals.yml'), 'utf8')).toBe(raw);
    const stale = await put('/api/config/portals', { raw: before.raw }, before.etag);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.raw).toBe(raw);
    expect((await put('/api/config/portals', { ops: [] }, ok.json().etag)).statusCode).toBe(400);
  });
});

describe('config/profile.yml editor', () => {
  it('reports a missing profile, refuses an unparseable one with 422, and creates a valid one', async () => {
    expect((await get('/api/config/profile')).json()).toMatchObject({ kind: 'missing', etag: null });
    const bad = await put('/api/config/profile', { raw: 'language: [\n  : :' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().exit).toBe(2);
    expect(fs.existsSync(path.join(t.cfg.dataRoot, 'config', 'profile.yml'))).toBe(false);
    const good = await put('/api/config/profile', { raw: 'language:\n  output: en\nfollowup_cadence:\n  first_followup_days: 7\n' });
    expect(good.statusCode, JSON.stringify(good.json())).toBe(200);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'config', 'profile.yml'), 'utf8')).toContain('first_followup_days: 7');
    expect((await get('/api/config/profile')).json().kind).toBe('ok');
  });
});
