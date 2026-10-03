import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { fakeLaunchdExec } from '../../server/system/fake-launchd.js';

let t: TestApp;
let fake: ReturnType<typeof fakeLaunchdExec>;
let usageDir: string;
beforeAll(async () => {
  usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-api-'));
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
          { op: 'insert', path: ['tracked_companies'], value: { name: 'Umbrella Corp', ats: 'greenhouse', slug: 'umbrella', enabled: true } },
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
    expect(raw).toMatch(/slug: northwind\n\s+enabled: false/);
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
    const created = await send('PUT', '/api/config/profile', { raw: 'language:\n  output: en\n# keep this comment\nfollowup_cadence:\n  applied_first_days: 7\n' });
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
    expect(res.json().rows).toEqual([{ company: 'Spam Staffing Ltd', since: '2026-09-01', scope: 'company', reason: 'body-shop reposting the same role weekly' }]);
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
    expect(raw).toContain('| ibm.com | 2026-10-03 | domain | avoid IBM-owned ATS hosts |');
    expect(raw).toContain('| Spam Staffing Ltd | 2026-09-01 | company |');
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
      expect(current.rows.map((r: { since: string }) => r.since)).toEqual(['Sept 2025', '']);
      const rows = [...current.rows, { company: 'Initech', since: '2026-10-03', scope: 'company', reason: 'ghosted twice' }];
      const saved = await req('PUT', { confirm: true, rows }, { 'if-match': current.etag, ...EXPLICIT });
      expect(saved.statusCode, saved.body).toBe(200);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('| Old Corp | Sept 2025 | company | reposts |');
      expect(raw).toContain('| Undated Ltd |  | company | spam |');
      expect(raw).toContain('| Initech | 2026-10-03 | company | ghosted twice |');
      expect(raw.endsWith(tail)).toBe(true);
      const bad = await req('PUT', { confirm: true, rows: [...rows, { company: 'Globex', since: 'yesterday', scope: 'company', reason: '' }] }, { 'if-match': saved.json().etag, ...EXPLICIT });
      expect(bad.statusCode).toBe(400);
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
    expect(fake.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
      `plutil -lint ${plist}`,
      `launchctl bootout gui/${uid}/com.career-ops.upstream-sync`,
      `launchctl bootstrap gui/${uid} ${plist}`,
      `plutil -convert json -o - ${plist}`,
      `launchctl print gui/${uid}/com.career-ops.upstream-sync`,
    ]);
    expect(res.json()).toMatchObject({ label: 'com.career-ops.upstream-sync', plist: 'ok', loaded: true, hour: 4, minute: 30, weekday: 0, programArgumentsOk: true, lastExit: 0 });
    expect(typeof res.json().nextFire).toBe('string');
  });
  it('disabling writes the plist and boots out without bootstrapping', async () => {
    fake.calls.length = 0;
    const res = await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 8, minute: 0, enabled: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(fake.calls.some((c) => c.args[0] === 'bootstrap')).toBe(false);
    expect(fake.calls.some((c) => c.args[0] === 'bootout')).toBe(true);
    expect(res.json()).toMatchObject({ plist: 'ok', loaded: false, hour: 8, minute: 0, weekday: null });
    const all = (await get('/api/schedule')).json().jobs;
    expect(all[0]).toMatchObject({ loaded: false });
    expect(all[1]).toMatchObject({ loaded: true });
  });
  it('validates the label and the body', async () => {
    expect((await send('PUT', '/api/schedule/com.evil', { hour: 1, minute: 1, enabled: true })).statusCode).toBe(404);
    expect((await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 25, minute: 0, enabled: true })).statusCode).toBe(400);
    expect((await send('PUT', '/api/schedule/com.career-ops.immigration-watch', { hour: 1, minute: 0, weekday: 2, enabled: true })).statusCode).toBe(400);
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
