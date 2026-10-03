import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

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

describe('config saves are serialized per file and never clobber a newer file', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** The real validators, slowed down so saves and outside edits overlap the validation window. */
  const slowValidators = (onValidate?: () => void): Exec => async (cmd, args, opts) => {
    if (args.some((a) => /validate-(portals|profile)\.mjs$/.test(a))) {
      onValidate?.();
      await wait(250);
    }
    return execNoShell(cmd, args, opts);
  };

  it('two saves with the same ETag: the first is written, the second gets 409 and nothing is lost', async () => {
    const app = await makeTestApp({}, { exec: slowValidators() });
    try {
      const put = (raw: string, etag: string) => app.app.inject({ method: 'PUT', url: '/api/config/portals', headers: { ...app.authedWrite, 'if-match': etag }, payload: { raw } });
      const before = (await app.app.inject({ method: 'GET', url: '/api/config/portals', headers: app.authed })).json();
      const [a, b] = await Promise.all([put(`# tab A\n${before.raw}`, before.etag), put(`# tab B\n${before.raw}`, before.etag)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? '# tab A' : '# tab B';
      expect(fs.readFileSync(path.join(app.cfg.dataRoot, 'portals.yml'), 'utf8')).toBe(`${winner}\n${before.raw}`);
      expect((a.statusCode === 409 ? a : b).json().current.raw.startsWith(winner)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('an edit that lands on disk while the validator runs wins: the save returns 409 and writes nothing', async () => {
    let dataRoot = '';
    const app = await makeTestApp({}, { exec: slowValidators(() => setTimeout(() => fs.appendFileSync(path.join(dataRoot, 'portals.yml'), '# edited by a fix-portal session\n'), 50)) });
    dataRoot = app.cfg.dataRoot;
    try {
      const before = (await app.app.inject({ method: 'GET', url: '/api/config/portals', headers: app.authed })).json();
      const res = await app.app.inject({ method: 'PUT', url: '/api/config/portals', headers: { ...app.authedWrite, 'if-match': before.etag }, payload: { raw: `# from the editor\n${before.raw}` } });
      expect(res.statusCode).toBe(409);
      const onDisk = fs.readFileSync(path.join(dataRoot, 'portals.yml'), 'utf8');
      expect(onDisk).toBe(`${before.raw}# edited by a fix-portal session\n`);
      expect(res.json().current.raw).toBe(onDisk);
    } finally {
      await app.close();
    }
  });
});

describe('config/profile.yml is written only when validate-profile exits 0', () => {
  for (const [label, result] of [
    ['a crash (exit 1)', { code: 1, stdout: '', stderr: 'TypeError: cannot read properties of undefined' }],
    ['a timeout (killed, reported as exit 1)', { code: 1, stdout: '', stderr: '' }],
    ['an unknown exit code', { code: 3, stdout: '', stderr: 'unexpected' }],
  ] as const) {
    it(`${label} rejects the save with 422 and writes nothing`, async () => {
      const exec: Exec = async (cmd, args, opts) => (args.some((a) => a.endsWith('validate-profile.mjs')) ? { ...result } : execNoShell(cmd, args, opts));
      const app = await makeTestApp({}, { exec });
      try {
        const res = await app.app.inject({ method: 'PUT', url: '/api/config/profile', headers: app.authedWrite, payload: { raw: 'language:\n  output: en\n' } });
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ exit: result.code, error: expect.stringMatching(/nothing was written/) });
        expect(fs.existsSync(path.join(app.cfg.dataRoot, 'config', 'profile.yml'))).toBe(false);
      } finally {
        await app.close();
      }
    });
  }

  it('exit 0 with findings writes the file and returns the findings as warnings', async () => {
    const findings = { profile: 'x', findings: [{ level: 'warning', code: 'unknown-key', message: 'styel is not a known key' }] };
    const exec: Exec = async (cmd, args, opts) => (args.some((a) => a.endsWith('validate-profile.mjs')) ? { code: 0, stdout: JSON.stringify(findings), stderr: '' } : execNoShell(cmd, args, opts));
    const app = await makeTestApp({}, { exec });
    try {
      const res = await app.app.inject({ method: 'PUT', url: '/api/config/profile', headers: app.authedWrite, payload: { raw: 'styel:\n  x: 1\n' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, validatorExit: 0, warnings: findings });
      expect(fs.readFileSync(path.join(app.cfg.dataRoot, 'config', 'profile.yml'), 'utf8')).toBe('styel:\n  x: 1\n');
    } finally {
      await app.close();
    }
  });
});
