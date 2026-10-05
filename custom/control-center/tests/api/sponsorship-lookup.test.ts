import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { configFromEnv } from '../../server/config.js';

const FAKE_CHECK = path.join(PACKAGE_ROOT, 'tests', 'fakes', 'h1b-check.mjs');
const INSTALL_COMMAND = 'node plugins/h1b-sponsor/install-h1b-index.mjs';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp({ h1bCheckScript: FAKE_CHECK });
});
afterAll(async () => {
  await t.close();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const lookup = (company: string) => get(`/api/sponsorship/lookup?company=${encodeURIComponent(company)}`);
const search = (q: string) => get(`/api/sponsorship/search?q=${encodeURIComponent(q)}`);

describe('GET /api/sponsorship/lookup', () => {
  it('Given a company the index knows, Then it returns the check, the saved company file, freshness and no alerts', async () => {
    const res = await lookup('Acme Robotics');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.state).toBe('found');
    expect(body.check).toMatchObject({
      found: true,
      displayName: 'Acme Robotics, Inc.',
      friendlinessTier: 'strong',
      totals: { n_lca: 412, n_certified: 398, n_pwd: 31, n_perm: 22, first_year: 2019, last_year: 2026, does_gc: true },
      source: 'h1b-index:fake-2026Q3',
      fetchedAt: '2026-10-03T12:00:00.000Z',
    });
    expect(body.check.redFlags.staffing_shop).toBeNull();
    expect(body.companyFile).toMatchObject({ slug: 'acme-robotics', name: 'Acme Robotics', verdict: 'sponsoring', dolTier: 'strong (120 LCAs FY2025)', checkedAt: '2026-09-28', path: 'data/immigration/companies/acme-robotics.md' });
    expect(body.markdown).toContain('120 approvals in the latest DOL disclosure');
    expect(body.freshness).toMatchObject({ slug: 'acme-robotics', checked_at: '2026-09-28' });
    expect(typeof body.freshness.refresh).toBe('boolean');
    expect(typeof body.freshness.reason).toBe('string');
    expect(body.alerts).toEqual([]);
  });

  it('Given an alert row for the company, Then the matching rows come back and others do not', async () => {
    const body = (await lookup('Globex Payments')).json();
    expect(body.state).toBe('found');
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ company: 'Globex Payments', status: 'resumed', date: '2026-09-25' });
  });

  it('Given an alert whose slug column was written by a different rule (AT&T as at-t), Then its company name still matches it (R8-05)', async () => {
    const file = path.join(t.cfg.dataRoot, 'data', 'immigration', 'company-alerts.tsv');
    const before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '2026-09-30\tAT&T\tat-t\tpaused\tAT&T pauses sponsorship\thttps://news.example/att\n');
    try {
      const body = (await lookup('AT&T')).json();
      expect(body.alerts).toHaveLength(1);
      expect(body.alerts[0]).toMatchObject({ company: 'AT&T', status: 'paused' });
    } finally {
      fs.writeFileSync(file, before);
    }
  });

  it('Given a staffing shop, Then the red flag and its share are passed through', async () => {
    const body = (await lookup('Vandelay Staffing Solutions LLC')).json();
    expect(body.check.friendlinessTier).toBe('staffing-shop');
    expect(body.check.redFlags.staffing_shop).toMatchObject({ value: true, share: 0.82 });
    expect(body.companyFile).toBeNull();
    expect(body.markdown).toBeNull();
  });

  it('Given a company the index does not know, Then the state is not_found, not an error', async () => {
    const res = await lookup('Zzz Nonexistent Holdings');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'not_found', check: { found: false, friendlinessTier: 'unknown' }, error: null });
  });

  it('Given a brand name that is not a legal name, Then it is not_found and search lists the legal entities', async () => {
    expect((await lookup('JPMorganChase')).json().state).toBe('not_found');
    const found = (await search('JPMorgan')).json();
    expect(found).toMatchObject({ state: 'ok', query: 'JPMorgan', total: 2, shown: 2 });
    expect(found.results.map((r: { name: string }) => r.name)).toEqual(['JPMorgan Chase & Co.', 'JPMorgan Chase Bank, N.A.']);
    expect((await lookup('JPMorgan Chase & Co.')).json().check.displayName).toBe('JPMorgan Chase & Co.');
  });

  it('Given a saved company file but no DOL record, Then the local data still comes back', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'data', 'immigration', 'companies', 'initech-cloud.md'), '# Initech Cloud\n\nchecked_at: 2026-09-01\nverdict: weak\n');
    const body = (await lookup('Initech Cloud')).json();
    expect(body.state).toBe('not_found');
    expect(body.companyFile).toMatchObject({ slug: 'initech-cloud', verdict: 'weak' });
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].status).toBe('paused');
  });

  it('Given no local index, Then the state is index_missing with the install command as text', async () => {
    const res = await lookup('Index Missing Probe');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'index_missing', installCommand: INSTALL_COMMAND, check: null });
    expect(res.json().error).toContain('no local H-1B index');
  });

  it('Given the backend fails or prints junk, Then the state is error with a message', async () => {
    expect((await lookup('Exploding Corp')).json()).toMatchObject({ state: 'error', error: 'H1B API returned 503', installCommand: null, check: null });
    const junk = (await lookup('Garbage Corp')).json();
    expect(junk.state).toBe('error');
    expect(junk.error).toMatch(/non-JSON/);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'a'.repeat(201)],
    ['newline', 'Acme\nRobotics'],
    ['escape character', 'Acme\u001b[31m'],
    ['NUL', 'Acme\u0000'],
    ['C1 control', 'Acme\u0085Robotics'],
    ['leading dash that check.mjs would read as a flag', '--cache-dir /tmp/x'],
  ])('rejects an invalid company (%s) with 400 and never starts the script', async (_label, company) => {
    const calls: string[][] = [];
    const spy = await makeTestApp({ h1bCheckScript: FAKE_CHECK }, { exec: async (cmd, args, opts) => (cmd === process.execPath && calls.push([cmd, ...args]), execNoShell(cmd, args, opts)) });
    const res = await spy.app.inject({ method: 'GET', url: `/api/sponsorship/lookup?company=${encodeURIComponent(company)}`, headers: spy.authed });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTypeOf('string');
    const searchRes = await spy.app.inject({ method: 'GET', url: `/api/sponsorship/search?q=${encodeURIComponent(company)}`, headers: spy.authed });
    expect(searchRes.statusCode).toBe(400);
    expect(calls).toEqual([]);
    await spy.close();
  });

  it('rejects a missing company parameter', async () => {
    expect((await get('/api/sponsorship/lookup')).statusCode).toBe(400);
    expect((await get('/api/sponsorship/search')).statusCode).toBe(400);
  });

  it('passes the company as one argv element with no shell, even with metacharacters', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args });
      return args[0] === FAKE_CHECK ? { code: 0, stdout: JSON.stringify({ found: false, displayName: args[1], totals: {}, redFlags: {}, friendlinessTier: 'unknown' }), stderr: '' } : execNoShell(cmd, args, opts);
    };
    const spy = await makeTestApp({ h1bCheckScript: FAKE_CHECK }, { exec });
    const name = 'Acme $(touch /tmp/pwned); `id` | & "x"';
    const res = await spy.app.inject({ method: 'GET', url: `/api/sponsorship/lookup?company=${encodeURIComponent(name)}`, headers: spy.authed });
    expect(res.statusCode).toBe(200);
    const check = calls.find((c) => c.args[0] === FAKE_CHECK)!;
    expect(check.cmd).toBe(process.execPath);
    expect(check.args).toEqual([FAKE_CHECK, name, '--json']);
    const sres = await spy.app.inject({ method: 'GET', url: `/api/sponsorship/search?q=${encodeURIComponent(name)}`, headers: spy.authed });
    expect(sres.statusCode).toBe(200);
    expect(calls.filter((c) => c.args[0] === FAKE_CHECK).at(-1)!.args).toEqual([FAKE_CHECK, '--search', name, '--json']);
    await spy.close();
  });

  it('requires the session cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sponsorship/lookup?company=Acme', headers: { host: t.authed.host } });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/sponsorship/search', () => {
  it('Given a query with no match, Then it returns an empty list', async () => {
    expect((await search('qqqq')).json()).toMatchObject({ state: 'ok', total: 0, shown: 0, results: [] });
  });

  it('Given no local index, Then it reports index_missing with the install command', async () => {
    expect((await search('Index Missing Probe')).json()).toMatchObject({ state: 'index_missing', installCommand: INSTALL_COMMAND, results: [] });
  });

  it('Given a backend failure, Then it reports error', async () => {
    expect((await search('Exploding Corp')).json()).toMatchObject({ state: 'error', error: 'H1B API returned 503' });
  });
});

describe('CC_H1B_CHECK_SCRIPT', () => {
  afterEach(() => vi.unstubAllEnvs());
  const env = (nodeEnv: string | undefined) => {
    // configFromEnv reads the required variables from process.env and the rest from its argument.
    for (const [k, v] of Object.entries({ CC_DATA_ROOT: '/x', CC_GUARD_DIR: '/y', CC_TOKEN: 't', CC_SESSION_SECRET: 's' })) vi.stubEnv(k, v);
    return { CC_PUBLIC_PORT: '4317', CC_H1B_CHECK_SCRIPT: '/fake/check.mjs', ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) };
  };

  it('is honored under NODE_ENV=test and ignored everywhere else', () => {
    expect(configFromEnv(env('test')).h1bCheckScript).toBe('/fake/check.mjs');
    expect(configFromEnv(env('production')).h1bCheckScript).toBeUndefined();
    expect(configFromEnv(env(undefined)).h1bCheckScript).toBeUndefined();
  });
});
