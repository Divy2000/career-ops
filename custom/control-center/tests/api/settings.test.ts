import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import { pinnedNodeBin } from '../../server/system/schedule.js';
import { fakeLaunchdExec } from '../../server/system/fake-launchd.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
let fake: ReturnType<typeof fakeLaunchdExec>;
let usageDir: string;
beforeAll(async () => {
  usageDir = tempDir('cc-usage-api-');
  fake = fakeLaunchdExec();
  t = await makeTestApp({ claudeProjectsDir: usageDir }, { exec: fake.exec });
});
afterAll(async () => {
  await t.close();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const send = (method: 'PUT' | 'POST', url: string, payload: unknown, extra: Record<string, string> = {}) =>
  t.app.inject({ method, url, headers: { ...t.authedWrite, ...extra }, payload: payload as Record<string, unknown> });
const readData = (rel: string) => fs.readFileSync(path.join(t.cfg.dataRoot, rel), 'utf8');

describe('structured portals editor (ops through the yaml Document API)', () => {
  it('applies set and insert ops, keeps comments, validates and bumps the ETag', async () => {
    const before = (await get('/api/config/portals')).json();
    const res = await send(
      'PUT',
      '/api/config/portals',
      {
        ops: [
          { op: 'set', path: ['tracked_companies', 1, 'enabled'], value: false },
          { op: 'insert', path: ['tracked_companies'], value: { name: 'Umbrella Corp', careers_url: 'https://job-boards.greenhouse.io/umbrella', provider: 'greenhouse', enabled: true } },
          { op: 'set', path: ['max_posting_age_days'], value: 14 },
          { op: 'set', path: ['location_filter', 'strict'], value: true },
        ],
      },
      { 'if-match': before.etag },
    );
    expect(res.statusCode, res.body).toBe(200);
    const raw = readData('portals.yml');
    expect(raw.startsWith('# Synthetic portals config for tests')).toBe(true);
    expect(raw).toContain('name: Umbrella Corp');
    expect(raw).toContain('max_posting_age_days: 14');
    expect(raw).toContain('strict: true');
    // Northwind has no enabled key (upstream defaults it on): the op adds it.
    expect(raw).toMatch(/provider: lever\n\s+enabled: false/);
    expect(res.json().etag).not.toBe(before.etag);
    const after = (await get('/api/config/portals')).json();
    expect(after.etag).toBe(res.json().etag);
    expect(after.doc.tracked_companies[2].name).toBe('Umbrella Corp');
  });
  it('rejects malformed ops and an insert into a scalar without writing', async () => {
    const before = (await get('/api/config/portals')).json();
    expect((await send('PUT', '/api/config/portals', { ops: [{ op: 'explode', path: ['x'] }] }, { 'if-match': before.etag })).statusCode).toBe(400);
    const bad = await send('PUT', '/api/config/portals', { ops: [{ op: 'insert', path: ['max_posting_age_days'], value: 1 }] }, { 'if-match': before.etag });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/not a list/);
    expect(readData('portals.yml')).toBe(before.raw);
  });
});

describe('follow-up cadence form (PUT /api/followups/cadence)', () => {
  it('writes only the followup_cadence keys through comment-preserving ops and validates the profile', async () => {
    const current = (await get('/api/config/profile')).json();
    const created = await send('PUT', '/api/config/profile', { raw: 'language:\n  output: en\n# keep this comment\nfollowup_cadence:\n  applied_first_days: 7\n' }, { 'if-match': current.etag });
    expect(created.statusCode, created.body).toBe(200);
    const res = await send('PUT', '/api/followups/cadence', { cadence: { applied_first_days: 10, responded_initial_days: 2 } }, { 'if-match': created.json().etag });
    expect(res.statusCode, res.body).toBe(200);
    const raw = readData('config/profile.yml');
    expect(raw).toContain('# keep this comment');
    expect(raw).toContain('applied_first_days: 10');
    expect(raw).toContain('responded_initial_days: 2');
    expect(raw).toContain('output: en');
    const read = (await get('/api/followups/cadence')).json();
    expect(read.cadence).toMatchObject({ applied_first_days: 10, responded_initial_days: 2 });
    expect(read.etag).toBe(res.json().etag);
    expect((await send('PUT', '/api/followups/cadence', { cadence: { applied_first_days: -1 } }, { 'if-match': res.json().etag })).statusCode).toBe(400);
  });
});

describe('blacklist (explicit confirm gate)', () => {
  const EXPLICIT = { 'x-cc-explicit': 'blacklist' };
  it('reads the legacy fixture table into rows', async () => {
    const res = await get('/api/blacklist');
    expect(res.statusCode).toBe(200);
    // By position, as scan.mjs reads it (SW8 review 3): the legacy Reason column is Since, and Added is kept as its own column.
    expect(res.json().rows).toEqual([{ company: 'Spam Staffing Ltd', since: 'body-shop reposting the same role weekly', scope: 'company', reason: '', extra: ['2026-09-01'] }]);
    expect(res.json().columnWarning).toContain('Company | Reason | Added');
  });
  it('returns 403 without the X-CC-Explicit header or without confirm:true and writes nothing', async () => {
    const before = readData('data/blacklist.md');
    const current = (await get('/api/blacklist')).json();
    const rows = [...current.rows, { company: 'Evil Corp', since: '2026-10-03', scope: 'company', reason: 'test' }];
    expect((await send('PUT', '/api/blacklist', { confirm: true, rows }, { 'if-match': current.etag })).statusCode).toBe(403);
    expect((await send('PUT', '/api/blacklist', { confirm: false, rows }, { 'if-match': current.etag, ...EXPLICIT })).statusCode).toBe(403);
    expect(readData('data/blacklist.md')).toBe(before);
  });
  it('writes the template format with confirm and header, then conflicts on a stale ETag', async () => {
    const current = (await get('/api/blacklist')).json();
    const rows = [...current.rows, { company: 'ibm.com', since: '2026-10-03', scope: 'domain', reason: 'avoid IBM-owned ATS hosts' }];
    const res = await send('PUT', '/api/blacklist', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT });
    expect(res.statusCode, res.body).toBe(200);
    const raw = readData('data/blacklist.md');
    expect(raw).toContain('| Company | Since | Scope | Reason |');
    expect(raw).toContain('| ibm.com | 2026-10-03 | domain | avoid IBM-owned ATS hosts |  |');
    expect(raw).toContain('| Spam Staffing Ltd | body-shop reposting the same role weekly | company |  | 2026-09-01 |');
    expect((await send('PUT', '/api/blacklist', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT })).statusCode).toBe(409);
    const invalid = await send('PUT', '/api/blacklist', { confirm: true, rows: [{ company: 'a|b', since: '2026-10-03', scope: 'company', reason: '' }] }, { 'if-match': res.json().etag, ...EXPLICIT });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('blacklist saves keep what the editor does not manage', () => {
  const EXPLICIT = { 'x-cc-explicit': 'blacklist' };
  it('a save keeps the notes after the table verbatim and tolerates legacy date cells, but new rows still need YYYY-MM-DD', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      const tail = '\n## Notes\n\nRecruiters from these firms reposted the same role.\n';
      fs.writeFileSync(file, `# Blacklist\n\n| Company | Reason | Added |\n|---|---|---|\n| Old Corp | reposts | Sept 2025 |\n| Undated Ltd | spam |  |\n${tail}`);
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      // By position, as scan.mjs reads it (SW8 review 3): the legacy Reason cells are the Since cells.
      expect(current.rows.map((r: { since: string }) => r.since)).toEqual(['reposts', 'spam']);
      const rows = [...current.rows, { company: 'Initech', since: '2026-10-03', scope: 'company', reason: 'ghosted twice' }];
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT });
      expect(saved.statusCode, saved.body).toBe(200);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('| Old Corp | reposts | company |  | Sept 2025 |');
      expect(raw).toContain('| Undated Ltd | spam | company |  |  |');
      expect(raw).toContain('| Initech | 2026-10-03 | company | ghosted twice |  |');
      expect(raw.endsWith(tail)).toBe(true);
      const bad = await req('PUT', { confirm: true, rows: [...rows, { company: 'Globex', since: 'yesterday', scope: 'company', reason: '' }] }, { 'if-match': saved.json().etag, ...EXPLICIT });
      expect(bad.statusCode).toBe(400);
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    } finally {
      await app.close();
    }
  });
});

describe('the blacklist editor shows exactly the entries the scanner blocks (SW5-tests-03)', () => {
  // scan.mjs is a writer and never loads into the app, so its parser runs in a child.
  function scannerEntries(file: string): Array<{ company: string; since: string; scope: string; reason: string }> {
    const code = `const { loadBlacklist } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, '..', '..', 'scan.mjs')).href)}); process.stdout.write(JSON.stringify([...loadBlacklist(${JSON.stringify(file)}).values()]));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(PACKAGE_ROOT, '..', '..'), env: { ...process.env, CAREER_OPS_ROOT: tempDir('cc-blacklist-scan-'), NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }
  it('rows after a blank line in the table and in a second table are listed, and a save that removes one stops the scanner blocking it', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      fs.writeFileSync(file, [
        '# Blacklist', '', 'Intro.', '',
        '| Company | Since | Scope | Reason |', '|---------|-------|-------|--------|', '| Acme Corp | 2026-01-15 | company | ghosted |', '',
        '| Spam Staffing Ltd | 2026-02-01 | company | body-shop |', '',
        '## Added by hand', '', 'Keep this paragraph.', '',
        '| Company | Since | Scope | Reason |', '|---|---|---|---|', '| ibm.com | 2026-03-01 | domain | IBM-owned ATS hosts |', '| Initech | 2026-04-01 | company | reposts |', '',
      ].join('\n'));
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      const blocked = scannerEntries(file);
      expect(blocked.map((e) => e.company)).toEqual(['Acme Corp', 'Spam Staffing Ltd', 'ibm.com', 'Initech']);
      expect(current.rows).toEqual(blocked);
      const rows = current.rows.filter((r: { company: string }) => r.company !== 'Initech');
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, 'x-cc-explicit': 'blacklist' });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(scannerEntries(file).map((e) => e.company)).toEqual(['Acme Corp', 'Spam Staffing Ltd', 'ibm.com']);
      expect((await req('GET')).json().rows).toEqual(scannerEntries(file));
      expect(fs.readFileSync(file, 'utf8')).toContain('## Added by hand\n\nKeep this paragraph.\n');
    } finally {
      await app.close();
    }
  });
});

describe('the blacklist editor reads the table by position, as the scanner does (SW8 review 3)', () => {
  function scannerEntries(file: string): Array<{ company: string; since: string; scope: string; reason: string }> {
    const code = `const { loadBlacklist } = await import(${JSON.stringify(pathToFileURL(path.join(PACKAGE_ROOT, '..', '..', 'scan.mjs')).href)}); process.stdout.write(JSON.stringify([...loadBlacklist(${JSON.stringify(file)}).values()]));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(PACKAGE_ROOT, '..', '..'), env: { ...process.env, CAREER_OPS_ROOT: tempDir('cc-blacklist-scan-'), NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }
  const fields = (rows: Array<{ company: string; since: string; scope: string; reason: string }>) => rows.map(({ company, since, scope, reason }) => ({ company, since, scope, reason }));
  it('a reordered header is read by position, with a warning, and a save keeps every cell while the scanner goes on blocking the same entries', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      fs.writeFileSync(file, '# Blacklist\n\n| Company | Scope | Since | Reason |\n|---|---|---|---|\n| ibm.com | domain | 2026-01-15 | IBM-owned ATS hosts |\n| Initech | company | 2026-02-01 | reposts |\n');
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      const blocked = scannerEntries(file);
      // The scanner reads the third column as the scope: ibm.com is matched as a company name, never as a domain.
      expect(blocked).toEqual([
        { company: 'ibm.com', since: 'domain', scope: 'company', reason: 'IBM-owned ATS hosts' },
        { company: 'Initech', since: 'company', scope: 'company', reason: 'reposts' },
      ]);
      expect(fields(current.rows)).toEqual(blocked);
      expect(current.columnWarning).toMatch(/Company, Since, Scope, Reason/);
      expect(current.columnWarning).toContain('Company | Scope | Since | Reason');
      const saved = await req('PUT', { confirm: true, rows: current.rows }, { 'if-match': current.etag, 'x-cc-explicit': 'blacklist' });
      expect(saved.statusCode, saved.body).toBe(200);
      const raw = fs.readFileSync(file, 'utf8');
      // The cells the scanner read as a scope are kept in a column of their own.
      expect(raw).toContain('2026-01-15');
      expect(raw).toContain('2026-02-01');
      expect(fields(scannerEntries(file))).toEqual(blocked);
      const after = (await req('GET')).json();
      expect(fields(after.rows)).toEqual(blocked);
      expect(after.columnWarning).toBeNull();
    } finally {
      await app.close();
    }
  });
  it('a header in the scanner order has no warning', async () => {
    const app = await makeTestApp();
    try {
      fs.writeFileSync(path.join(app.cfg.dataRoot, 'data', 'blacklist.md'), '# Blacklist\n\n| Company | Since | Scope | Reason | Contact |\n|---|---|---|---|---|\n| Acme | 2026-01-15 | company | x | a@b.example |\n');
      const current = (await app.app.inject({ method: 'GET', url: '/api/blacklist', headers: app.authed })).json();
      expect(current.columnWarning).toBeNull();
      expect(current.rows).toEqual([{ company: 'Acme', since: '2026-01-15', scope: 'company', reason: 'x', extra: ['a@b.example'] }]);
    } finally {
      await app.close();
    }
  });
});

describe('blacklist saves keep columns the editor does not show', () => {
  it('an extra column survives a save for every existing row, and a row cannot smuggle in more cells than the file has columns', async () => {
    const app = await makeTestApp();
    try {
      const file = path.join(app.cfg.dataRoot, 'data', 'blacklist.md');
      fs.writeFileSync(file, '# Blacklist\n\n| Company | Reason | Added | Contact |\n|---|---|---|---|\n| Old Corp | reposts | 2025-09-01 | jane@old.example |\n');
      const req = (method: 'GET' | 'PUT', payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.app.inject({ method, url: '/api/blacklist', headers: { ...(method === 'GET' ? app.authed : app.authedWrite), ...extra }, payload });
      const current = (await req('GET')).json();
      // By position, as scan.mjs reads it (SW8 review 3): Contact is the Reason column, Added is kept as its own.
      expect(current.extraColumns).toEqual(['Added']);
      const rows = [...current.rows, { company: 'Initech', since: '2026-10-03', scope: 'company', reason: 'ghosted' }];
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, 'x-cc-explicit': 'blacklist' });
      expect(saved.statusCode, saved.body).toBe(200);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('| Company | Since | Scope | Reason | Added |');
      expect(raw).toContain('| Old Corp | reposts | company | jane@old.example | 2025-09-01 |');
      expect(raw).toContain('| Initech | 2026-10-03 | company | ghosted |  |');
      const smuggled = await req('PUT', { confirm: true, rows: [{ ...rows[0], extra: ['a', 'b'] }] }, { 'if-match': saved.json().etag, 'x-cc-explicit': 'blacklist' });
      expect(smuggled.statusCode).toBe(400);
      expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    } finally {
      await app.close();
    }
  });
});

describe('plugins', () => {
  it('lists bundled plugins with their enabled state from config/plugins.yml', async () => {
    const res = await get('/api/plugins');
    expect(res.statusCode).toBe(200);
    const gmail = res.json().plugins.find((p: { id: string }) => p.id === 'gmail');
    expect(gmail).toMatchObject({ enabled: false, hooks: ['ingest'], hasSkill: true });
    expect(gmail.requiredEnv).toContain('GMAIL_CLIENT_ID');
    expect(res.json().plugins.some((p: { id: string }) => p.id === '_template')).toBe(false);
    expect(res.json().config.kind).toBe('missing');
  });
  it('finds plugins the way plugins.mjs does: a symlinked plugins.local checkout is listed, an invalid manifest or a shadowed id is not (SW2-server-02)', async () => {
    const local = tempDir('cc-plugins-local-');
    const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, description: `${id} plugin`, hooks: ['ingest'], humanInTheLoop: true, ...extra });
    const put = (dir: string, json: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), json);
      fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const hooks = {};\n');
    };
    // A plugin developed in its own checkout and linked in, as plugins.local/ is meant to be used.
    const checkout = path.join(tempDir('cc-plugin-checkout-'), 'my-plugin');
    put(checkout, manifest('my-plugin'));
    fs.symlinkSync(checkout, path.join(local, 'my-plugin'));
    put(path.join(local, 'no-id'), manifest('no-id', { id: undefined }));
    put(path.join(local, 'wrong-dir'), manifest('another-id'));
    put(path.join(local, 'gmail'), manifest('gmail'));
    const own = await makeTestApp({ pluginsLocalDir: local });
    try {
      const plugins = (await own.app.inject({ method: 'GET', url: '/api/plugins', headers: own.authed })).json().plugins as Array<{ id: string; source: string }>;
      const ids = plugins.map((p) => p.id);
      expect(plugins.find((p) => p.id === 'my-plugin')).toMatchObject({ source: 'local' });
      expect(ids).not.toContain('no-id');
      expect(ids).not.toContain('another-id');
      expect(ids).not.toContain('wrong-dir');
      expect(plugins.filter((p) => p.id === 'gmail')).toEqual([expect.objectContaining({ source: 'bundled' })]);
      const toggle = await own.app.inject({ method: 'PUT', url: '/api/config/plugins/my-plugin', headers: own.authedWrite, payload: { enabled: true } });
      expect(toggle.statusCode, toggle.body).toBe(200);
    } finally {
      await own.close();
    }
  });

  it('refuses a plugin toggle sent with a stale ETag: 409 with the current version, and config/plugins.yml unchanged (SW2-tests-22)', async () => {
    const stale = (await get('/api/plugins')).json().config.etag as string | null;
    const file = path.join(t.cfg.dataRoot, 'config', 'plugins.yml');
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // Another writer (the CLI's plugins.mjs enable, a session) changes the file after the page loaded it.
      fs.writeFileSync(file, 'plugins:\n  gmail:\n    enabled: true\n');
      const before = fs.readFileSync(file, 'utf8');
      const res = await send('PUT', '/api/config/plugins/gmail', { enabled: false }, stale === null ? { 'if-match': '"stale"' } : { 'if-match': stale });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ error: 'config/plugins.yml changed since you loaded it', current: { raw: before } });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      if (original === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, original);
    }
  });

  it('enables a plugin by writing config/plugins.yml and rejects unknown ids', async () => {
    const res = await send('PUT', '/api/config/plugins/gmail', { enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const raw = readData('config/plugins.yml');
    expect(raw).toMatch(/plugins:\n\s+gmail:\n\s+enabled: true/);
    const list = (await get('/api/plugins')).json();
    expect(list.plugins.find((p: { id: string }) => p.id === 'gmail').enabled).toBe(true);
    expect(list.config.kind).toBe('ok');
    const off = await send('PUT', '/api/config/plugins/gmail', { enabled: false }, { 'if-match': list.config.etag });
    expect(off.statusCode, off.body).toBe(200);
    expect(readData('config/plugins.yml')).toContain('enabled: false');
    expect((await send('PUT', '/api/config/plugins/nope', { enabled: true })).statusCode).toBe(404);
    expect((await send('PUT', '/api/config/plugins/gmail', { enabled: 'yes' })).statusCode).toBe(400);
  });
  it('returns the skill document as untrusted markdown', async () => {
    const res = await get('/api/plugins/gmail/skill');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: 'gmail', untrusted: true });
    expect(res.json().markdown.length).toBeGreaterThan(20);
    expect((await get('/api/plugins/nope/skill')).statusCode).toBe(404);
  });
});

describe('launchd schedule through the injectable executor (never the real launchd)', () => {
  it('reports both jobs as not installed before any write', async () => {
    const res = await get('/api/schedule');
    expect(res.statusCode).toBe(200);
    const labels = res.json().jobs.map((j: { label: string }) => j.label);
    expect(labels).toEqual(['com.career-ops.immigration-watch', 'com.career-ops.upstream-sync']);
    expect(res.json().jobs.every((j: { plist: string; loaded: boolean }) => j.plist === 'missing' && j.loaded === false)).toBe(true);
  });
  it('writes the weekly plist, lints it, boots it out and bootstraps it again', async () => {
    fake.calls.length = 0;
    const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const plist = path.join(t.cfg.launchAgentsDir, 'com.career-ops.upstream-sync.plist');
    const xml = fs.readFileSync(plist, 'utf8');
    expect(xml).toContain(path.join(t.cfg.codeRoot, 'custom/upstream-sync/sync.sh'));
    expect(xml).toContain('<key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>0</integer>');
    const uid = String(process.getuid?.() ?? 0);
    // The new plist is linted beside the installed one and only then moved over it (SW2-tests-19).
    expect(fake.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      // First a read: is launchd running the job right now (SW3-server-01)?
      `launchctl print gui/${uid}/com.career-ops.upstream-sync`,
      expect.stringMatching(new RegExp(`^plutil -lint ${plist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tmp-\\d+$`)),
      `launchctl enable gui/${uid}/com.career-ops.upstream-sync`,
      `launchctl bootout gui/${uid}/com.career-ops.upstream-sync`,
      `launchctl bootstrap gui/${uid} ${plist}`,
      `plutil -convert json -o - ${plist}`,
      `launchctl print gui/${uid}/com.career-ops.upstream-sync`,
      `launchctl print-disabled gui/${uid}`,
    ]);
    // A job launchd just loaded has never run: print says "not running", runs 0 and "(never exited)" (print-idle.txt).
    expect(res.json()).toMatchObject({ label: 'com.career-ops.upstream-sync', plist: 'ok', loaded: true, disabled: false, hour: 4, minute: 30, weekday: 0, programArgumentsOk: true, state: 'not running', lastExit: null, runs: 0 });
    expect(typeof res.json().nextFire).toBe('string');
  });
  it('after the job fires, the schedule reads the run count and exit the way launchctl print reports them (SW2-tests-10)', async () => {
    expect((await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true })).statusCode).toBe(200);
    fake.fire('com.career-ops.upstream-sync', 0);
    fake.fire('com.career-ops.upstream-sync', 1);
    const job = (await get('/api/schedule')).json().jobs[1];
    expect(job).toMatchObject({ loaded: true, state: 'not running', runs: 2, lastExit: 1 });
  });
  it('a plist that fails the lint never replaces the installed one, which stays byte for byte, and launchd is not touched (SW2-tests-19)', async () => {
    expect((await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true })).statusCode).toBe(200);
    const plist = path.join(t.cfg.launchAgentsDir, 'com.career-ops.upstream-sync.plist');
    const installed = fs.readFileSync(plist, 'utf8');
    fake.calls.length = 0;
    fake.fail.add('plutil -lint');
    try {
      const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 6, minute: 0, weekday: 0, enabled: true });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatch(/plutil -lint rejected the plist/);
    } finally {
      fake.fail.clear();
    }
    expect(fs.readFileSync(plist, 'utf8')).toBe(installed);
    expect(fs.readdirSync(t.cfg.launchAgentsDir).filter((n) => n.includes('.tmp-'))).toEqual([]);
    // Only the read-only running check reached launchctl: nothing was enabled, disabled, booted out or in.
    expect(fake.calls.filter((c) => c.cmd === 'launchctl' && c.args[0] !== 'print')).toEqual([]);
  });
  for (const [step, status, error] of [
    ['launchctl enable', 502, /launchctl enable failed/],
    ['launchctl bootstrap', 502, /launchctl bootstrap failed/],
  ] as const) {
    it(`a failing ${step} on Install and enable answers ${status} with the reason (SW2-tests-19)`, async () => {
      fake.fail.add(step);
      try {
        const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true });
        expect(res.statusCode).toBe(status);
        expect(res.json().error).toMatch(error);
      } finally {
        fake.fail.clear();
      }
    });
  }
  it('a failing launchctl disable answers 502 and says the job would load again at login (SW2-tests-19)', async () => {
    fake.fail.add('launchctl disable');
    try {
      const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: false });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatch(/launchctl disable failed .*would load again at the next login/);
    } finally {
      fake.fail.clear();
    }
  });
  it('refuses to save or disable a schedule while launchd is running that job, since bootout would kill the run mid-step (SW3-server-01)', async () => {
    expect((await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true })).statusCode).toBe(200);
    const plist = path.join(t.cfg.launchAgentsDir, 'com.career-ops.upstream-sync.plist');
    const installed = fs.readFileSync(plist, 'utf8');
    fake.running.add('com.career-ops.upstream-sync');
    try {
      fake.calls.length = 0;
      for (const enabled of [true, false]) {
        const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 6, minute: 0, weekday: 0, enabled });
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toMatch(/Weekly upstream sync is running now.*would stop it.*Try again once it finishes/);
      }
      expect(fs.readFileSync(plist, 'utf8')).toBe(installed);
      expect(fake.calls.filter((c) => c.cmd === 'launchctl' && ['bootout', 'bootstrap', 'enable', 'disable'].includes(c.args[0]!))).toEqual([]);
      expect((await get('/api/schedule')).json().jobs[1]).toMatchObject({ loaded: true, state: 'running' });
    } finally {
      fake.running.delete('com.career-ops.upstream-sync');
    }
    expect((await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 6, minute: 0, weekday: 0, enabled: true })).statusCode).toBe(200);
  });
  it('disabling writes the plist and boots out without bootstrapping', async () => {
    // The weekly job installed and loaded, as the test above leaves it, so this test holds alone too.
    expect((await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true })).statusCode).toBe(200);
    fake.calls.length = 0;
    const res = await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 8, minute: 0, enabled: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(fake.calls.some((c) => c.args[0] === 'bootstrap')).toBe(false);
    expect(fake.calls.some((c) => c.args[0] === 'bootout')).toBe(true);
    const uid = String(process.getuid?.() ?? 0);
    expect(fake.calls.map((c) => [c.cmd, ...c.args].join(' '))).toContain(`launchctl disable gui/${uid}/com.career-ops.immigration-watch`);
    expect(res.json()).toMatchObject({ plist: 'ok', loaded: false, disabled: true, hour: 8, minute: 0, weekday: null });
    const all = (await get('/api/schedule')).json().jobs;
    expect(all[0]).toMatchObject({ loaded: false });
    expect(all[1]).toMatchObject({ loaded: true });
  });
  it('a disabled job stays off after a logout or reboot (launchd loads every plist that is not disabled), and enabling brings it back', async () => {
    const login = fakeLaunchdExec();
    const app = await makeTestApp({}, { exec: login.exec });
    try {
      const put = (enabled: boolean) => app.app.inject({ method: 'PUT', url: '/api/schedule/com.career-ops.immigration-watch', headers: app.authedWrite, payload: { hour: 7, minute: 15, enabled } });
      const daily = async () => (await app.app.inject({ method: 'GET', url: '/api/schedule', headers: app.authed })).json().jobs[0];
      expect((await put(true)).statusCode).toBe(200);
      expect((await put(false)).statusCode).toBe(200);
      login.login(app.cfg.launchAgentsDir);
      expect(await daily()).toMatchObject({ plist: 'ok', loaded: false, disabled: true, nextFire: null });
      expect((await put(true)).statusCode).toBe(200);
      login.login(app.cfg.launchAgentsDir);
      expect(await daily()).toMatchObject({ loaded: true, disabled: false });
    } finally {
      await app.close();
    }
  });

  it('the plist sends launchd logs to the data root and the log directory exists there', async () => {
    const res = await send('PUT', '/api/schedule/com.career-ops.upstream-sync', { hour: 4, minute: 30, weekday: 0, enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const xml = fs.readFileSync(path.join(t.cfg.launchAgentsDir, 'com.career-ops.upstream-sync.plist'), 'utf8');
    expect(t.cfg.dataRoot).not.toBe(t.cfg.codeRoot);
    expect(xml).toContain(`<key>StandardOutPath</key><string>${path.join(t.cfg.dataRoot, 'data', 'upstream-sync', 'launchd.out.log')}</string>`);
    expect(xml).toContain(`<key>StandardErrorPath</key><string>${path.join(t.cfg.dataRoot, 'data', 'upstream-sync', 'launchd.err.log')}</string>`);
    expect(fs.statSync(path.join(t.cfg.dataRoot, 'data', 'upstream-sync')).isDirectory()).toBe(true);
    expect(xml).toContain(`<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${t.cfg.dataRoot}</string><key>CC_NODE_BIN</key><string>${pinnedNodeBin()}</string></dict>`);
  });

  it('both plists pin the node the app runs on (CC_NODE_BIN): launchd\'s PATH never reaches an nvm or volta node (SW-scripts-03)', async () => {
    for (const [label, weekday] of [['com.career-ops.immigration-watch', undefined], ['com.career-ops.upstream-sync', 0]] as const) {
      const res = await send('PUT', `/api/schedule/${label}`, { hour: 3, minute: 0, weekday, enabled: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(fs.readFileSync(path.join(t.cfg.launchAgentsDir, `${label}.plist`), 'utf8')).toContain(`<key>CC_NODE_BIN</key><string>${pinnedNodeBin()}</string>`);
    }
  });

  it('the daily plist pins the claude the app runs (CC_CLAUDE_BIN), so launchd never picks another one on its own PATH', async () => {
    const res = await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 8, minute: 0, enabled: true });
    expect(res.statusCode, res.body).toBe(200);
    const xml = fs.readFileSync(path.join(t.cfg.launchAgentsDir, 'com.career-ops.immigration-watch.plist'), 'utf8');
    expect(path.isAbsolute(t.cfg.claudeBin)).toBe(true);
    expect(xml).toContain(`<key>CC_CLAUDE_BIN</key><string>${t.cfg.claudeBin}</string>`);
  });

  it('writes no CAREER_OPS_ROOT when the server root did not come from the environment, and keeps it when it did', async () => {
    for (const [fromEnv, expected] of [[false, false], [true, true]] as const) {
      const app = await makeTestApp({ dataRootFromEnv: fromEnv }, { exec: fakeLaunchdExec().exec });
      try {
        const res = await app.app.inject({ method: 'PUT', url: '/api/schedule/com.career-ops.immigration-watch', headers: app.authedWrite, payload: { hour: 8, minute: 0, enabled: true } });
        expect(res.statusCode, res.body).toBe(200);
        const xml = fs.readFileSync(path.join(app.cfg.launchAgentsDir, 'com.career-ops.immigration-watch.plist'), 'utf8');
        expect(xml.includes('<key>CAREER_OPS_ROOT</key>')).toBe(expected);
        expect(xml).toContain(path.join(app.cfg.dataRoot, 'data', 'immigration', 'logs', 'launchd.out.log'));
      } finally {
        await app.close();
      }
    }
  });

  it('validates the label and the body', async () => {
    expect((await send('PUT', '/api/schedule/com.evil', { hour: 1, minute: 1, enabled: true })).statusCode).toBe(404);
    expect((await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 25, minute: 0, enabled: true })).statusCode).toBe(400);
    expect((await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 1, minute: 0, weekday: 2, enabled: true })).statusCode).toBe(400);
  });
  it('answers for the weekly job of an install that never had it: an empty log list, not an error', async () => {
    const res = await get('/api/schedule/logs?job=upstream-sync');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ job: 'com.career-ops.upstream-sync', dates: [], latest: null });
  });
  it('lists logs per job, including the upstream-sync directory', async () => {
    fs.mkdirSync(path.join(t.cfg.dataRoot, 'data', 'upstream-sync'), { recursive: true });
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'data', 'upstream-sync', '2026-09-27.log'), '=== sync start\n--- fetch upstream\n!!! merge failed\n');
    const daily = (await get('/api/schedule/logs')).json();
    expect(daily.dates).toContain('2026-10-03');
    const weekly = (await get('/api/schedule/logs?job=upstream-sync')).json();
    expect(weekly.dates).toEqual(['2026-09-27']);
    const one = (await get('/api/schedule/logs/2026-09-27?job=upstream-sync')).json();
    expect(one.raw).toContain('merge failed');
    expect((await get('/api/schedule/logs/2026-01-01?job=upstream-sync')).statusCode).toBe(404);
    expect((await get('/api/schedule/logs?job=other')).statusCode).toBe(400);
  });
});

describe('job log names inherited from Object', () => {
  it('answers 400, not 500, for a job named after an Object property, on the list and on a dated log', async () => {
    for (const job of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      for (const url of [`/api/schedule/logs?job=${job}`, `/api/schedule/logs/2026-10-03?job=${job}`]) {
        const res = await get(url);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(400);
        expect(res.json().error).toBe('job must be immigration-watch or upstream-sync');
      }
    }
  });
});

describe('app settings and usage meter', () => {
  it('returns defaults, persists a partial patch, applies the Claude slot cap and validates', async () => {
    expect((await get('/api/settings/app')).json()).toMatchObject({ logos: false, retention: 500, claudeConcurrency: 2 });
    const res = await send('PUT', '/api/settings/app', { claudeConcurrency: 3, logos: true, modelDefault: 'claude-sonnet-4-5' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ claudeConcurrency: 3, logos: true, retention: 500, modelDefault: 'claude-sonnet-4-5' });
    expect(t.runner.claudeSlots).toBe(3);
    expect(JSON.parse(readData('data/control-center/settings.json'))).toMatchObject({ claudeConcurrency: 3 });
    expect((await send('PUT', '/api/settings/app', { claudeConcurrency: 9 })).statusCode).toBe(400);
    expect((await send('PUT', '/api/settings/app', { modelDefault: 'rm -rf' })).statusCode).toBe(400);
  });
  it('reads token usage from the configured projects dir and reports budgets', async () => {
    expect((await get('/api/usage')).json().kind).toBe('ok');
    const now = Date.now();
    fs.mkdirSync(path.join(usageDir, 'p'), { recursive: true });
    fs.writeFileSync(
      path.join(usageDir, 'p', 'a.jsonl'),
      JSON.stringify({ type: 'assistant', timestamp: new Date(now - 60_000).toISOString(), requestId: 'q1', message: { usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30 } } }) + '\n',
    );
    await send('PUT', '/api/settings/app', { usageBudgets: { fiveHourTokens: 1000, sevenDayTokens: null } });
    const res = await get('/api/usage?fresh=1');
    expect(res.statusCode).toBe(200);
    expect(res.json().fiveHour).toMatchObject({ tokens: 60 });
    expect(res.json().budgets).toEqual({ fiveHourTokens: 1000, sevenDayTokens: null });
  });
});

describe('raising Claude concurrency (SW2-server-03)', () => {
  it('starts a Claude run that was waiting for a slot as soon as the cap is raised, with no other run event', async () => {
    const own = await makeTestApp();
    try {
      const put = (claudeConcurrency: number) => own.app.inject({ method: 'PUT', url: '/api/settings/app', headers: own.authedWrite, payload: { claudeConcurrency } });
      expect((await put(1)).statusCode).toBe(200);
      const noisy = { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '4000'], cwd: PACKAGE_ROOT };
      const req = { actionId: 'test.claude', label: 'claude run', cost: 'tokens' as const, resources: [], claude: true, params: {}, cmd: noisy };
      const first = own.runner.start(req);
      const second = own.runner.start(req);
      const status = (id: string) => own.runner.store.read(id)?.status;
      expect(status(first.id)).toBe('running');
      expect(status(second.id)).toBe('queued');
      expect((await put(2)).statusCode).toBe(200);
      expect(status(second.id)).toBe('running');
      own.runner.cancel(first.id);
      own.runner.cancel(second.id);
    } finally {
      await own.close();
    }
  });
});

describe('cached insights scripts', () => {
  it('runs a script once, serves the cache until inputs change, and recomputes on demand', async () => {
    const first = await get('/api/insights/funnelVelocity');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ script: 'funnelVelocity', kind: 'ok', fromCache: false });
    expect(first.json().json).not.toBeNull();
    const second = await get('/api/insights/funnelVelocity');
    expect(second.json().fromCache).toBe(true);
    expect(second.json().computedAt).toBe(first.json().computedAt);
    const forced = await get('/api/insights/funnelVelocity?recompute=1');
    expect(forced.json().fromCache).toBe(false);
    expect((await get('/api/insights/notAScript')).statusCode).toBe(404);
    const reposts = await get('/api/insights/detectReposts');
    expect(reposts.statusCode, reposts.body).toBe(200);
  });

  it('answers 404 for names inherited from Object, which are not scripts', async () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const res = await get(`/api/insights/${name}`);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(404);
    }
  });
});

describe('contacts and interviews reads', () => {
  it('parses data/contacts.tsv rows and lists interview prep documents', async () => {
    const contacts = await get('/api/contacts');
    expect(contacts.statusCode).toBe(200);
    expect(contacts.json().kind).toBe('ok');
    expect(contacts.json().rows[0]).toMatchObject({ name: 'Pat Example', company: 'Acme Robotics' });
    const interviews = await get('/api/interviews');
    expect(interviews.statusCode).toBe(200);
    expect(interviews.json().active.kind).toBe('ok');
    expect(interviews.json().prepDocs.map((d: { name: string }) => d.name)).toContain('acme-robotics-prep.md');
  });
});
