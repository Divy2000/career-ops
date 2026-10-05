import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { containedPath } from '../../server/routes/read.js';
import { formatSse } from '../../server/watch/bus.js';
import { domainFor } from '../../server/watch/watcher.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });

describe('read endpoints', () => {
  it('GET /api/tracker returns joined rows', async () => {
    const res = await get('/api/tracker');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('ok');
    expect(body.rows).toHaveLength(6);
    expect(body.rows[0]).toMatchObject({ num: 1, company: 'Acme Robotics', score: 4.3, lastContact: '2026-09-28' });
  });

  it('GET /api/tracker/:n returns row, report, timeline, company history and sponsorship', async () => {
    const res = await get('/api/tracker/1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.row.company).toBe('Acme Robotics');
    expect(body.report.kind).toBe('ok');
    expect(body.report.report.sections.length).toBeGreaterThan(3);
    expect(body.timeline.statusLog).toHaveLength(2);
    expect(body.timeline.followups).toHaveLength(1);
    expect(body.timeline.pin).toMatchObject({ date: '2026-10-10' });
    expect(body.sponsorship.companyFile).toMatchObject({ slug: 'acme-robotics', name: 'Acme Robotics', verdict: 'sponsoring' });
    expect(body.companyHistory).toEqual([]);
  });

  it('GET /api/tracker/:n distinguishes a row without a report and rejects bad numbers', async () => {
    expect((await get('/api/tracker/5')).json().report).toEqual({ kind: 'none' });
    expect((await get('/api/tracker/99')).statusCode).toBe(404);
    expect((await get('/api/tracker/abc')).statusCode).toBe(400);
  });

  it('GET /api/pipeline, /api/shortlist and /api/whats-new read the fixtures', async () => {
    expect((await get('/api/pipeline')).json().rows).toHaveLength(6);
    expect((await get('/api/shortlist')).json().rows).toHaveLength(3);
  });

  it('GET /api/whats-new lists the scanner\'s added, not yet evaluated rows inside the day window, newest first, up to the limit', async () => {
    // vitest runs in America/Los_Angeles; the fixture's scan history was written as of 2026-10-05.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 5, 12, 0));
      const week = (await get('/api/whats-new?days=7&limit=5')).json();
      // Northwind and Acme are in the tracker, Hooli was skipped, and not-a-url is no posting.
      expect(week.count).toBe(2);
      expect(week.offers.map((o: { company: string; firstSeen: string; postedAt: string }) => [o.company, o.firstSeen, o.postedAt])).toEqual([
        ['Pied Piper', '2026-10-03', ''],
        ['Soylent Foods', '2026-10-02', '2026-10-02'],
      ]);
      expect((await get('/api/whats-new?days=7&limit=1')).json()).toMatchObject({ count: 2, offers: [{ company: 'Pied Piper' }] });
      expect((await get('/api/whats-new?days=3')).json().offers.map((o: { company: string }) => o.company)).toEqual(['Pied Piper']);
      expect((await get('/api/whats-new?days=2')).json()).toEqual({ offers: [], count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET /api/immigration/overview and a company file with its freshness verdict', async () => {
    const o = (await get('/api/immigration/overview')).json();
    expect(o.digest.kind).toBe('ok');
    expect(o.companies.map((c: { slug: string }) => c.slug)).toEqual(['acme-robotics', 'globex-payments', 'initech-cloud']);
    const c = await get('/api/immigration/companies/acme-robotics');
    expect(c.statusCode).toBe(200);
    expect(c.json().company.slug).toBe('acme-robotics');
    expect(c.json().markdown).toContain('checked_at');
    expect(c.json().freshness).toMatchObject({ company: 'Acme Robotics' });
    expect((await get('/api/immigration/companies/nope')).statusCode).toBe(404);
    expect((await get('/api/immigration/companies/Not%20A%20Slug')).statusCode).toBe(400);
  });

  it('GET /api/followups runs the core cadence script against the fixture root', async () => {
    const res = await get('/api/followups');
    expect(res.statusCode).toBe(200);
    expect(res.json().metadata.totalTracked).toBe(6);
    expect(res.json().entries.length).toBeGreaterThan(0);
  });

  it('GET /api/insights/dashboard and the schedule logs', async () => {
    const d = (await get('/api/insights/dashboard')).json();
    expect(d.kind).toBe('ok');
    expect(d.dashboard.totals.applications).toBe(6);
    const logs = (await get('/api/schedule/logs')).json();
    expect(logs.dates).toEqual(['2026-10-03']);
    expect(logs.latest.status).toBe('failed');
    const one = await get('/api/schedule/logs/2026-10-03');
    expect(one.json().raw).toContain('=== ');
    expect((await get('/api/schedule/logs/2020-01-01')).statusCode).toBe(404);
  });

  it('GET /api/modes lists derived and virtual modes with policies', async () => {
    const modes = (await get('/api/modes')).json();
    expect(modes.find((m: { id: string }) => m.id === 'oferta').policyClass).toBe('evaluate');
    expect(modes.find((m: { id: string }) => m.id === 'advisor')).toBeTruthy();
  });

  it('GET /api/modes and the engine mode list offer only modes a session can run: batch (refused as a session) is left out', async () => {
    const modes = ((await get('/api/modes')).json() as Array<{ id: string }>).map((m) => m.id);
    expect(modes).toContain('oferta');
    expect(modes).toContain('pipeline');
    expect(modes).not.toContain('batch');
    const engine = (await get('/api/sessions/engine')).json() as { modes: string[] };
    expect(engine.modes).toContain('oferta');
    expect(engine.modes).not.toContain('batch');
  });

  it('a missing tracker file is reported as missing, not as an error', async () => {
    const t2 = await makeTestApp();
    fs.rmSync(path.join(t2.cfg.dataRoot, 'data', 'applications.md'));
    const res = await t2.app.inject({ method: 'GET', url: '/api/tracker', headers: t2.authed });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('missing');
    expect((await t2.app.inject({ method: 'GET', url: '/api/insights/dashboard', headers: t2.authed })).json().kind).toBe('missing');
    await t2.close();
  });
});

describe('GET /api/followups on an empty tracker', () => {
  const HEADER_ONLY = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n';
  const cases: Array<[string, (dataRoot: string) => void]> = [
    ['no tracker file', (root) => fs.rmSync(path.join(root, 'data', 'applications.md'))],
    ['a header-only tracker', (root) => fs.writeFileSync(path.join(root, 'data', 'applications.md'), HEADER_ONLY)],
  ];

  it.each(cases)('returns 200 with an empty cadence the client understands for %s', async (_name, arrange) => {
    const t2 = await makeTestApp();
    arrange(t2.cfg.dataRoot);
    const res = await t2.app.inject({ method: 'GET', url: '/api/followups', headers: t2.authed });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([]);
    expect(body.metadata).toMatchObject({ totalTracked: 0, actionable: 0, overdue: 0, urgent: 0, cold: 0, waiting: 0, retired: 0 });
    expect(body.metadata.analysisDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.cadenceDefaults).toMatchObject({ applied_first: 7, applied_max_followups: 2 });
    expect(body.error).toBeUndefined();
    await t2.close();
  });

  it('dates an empty cadence by the local day, not the UTC one', async () => {
    const t2 = await makeTestApp();
    fs.rmSync(path.join(t2.cfg.dataRoot, 'data', 'applications.md'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 19:00 on 2026-10-05 in Los Angeles (vitest's pinned zone) is already 2026-10-06 in UTC.
      vi.setSystemTime(new Date(2026, 9, 5, 19, 0));
      const body = (await t2.app.inject({ method: 'GET', url: '/api/followups', headers: t2.authed })).json();
      expect(body.metadata.analysisDate).toBe('2026-10-05');
    } finally {
      vi.useRealTimers();
      await t2.close();
    }
  });

  it('counts a status by its states.yml label: any case and the aliases set-status.mjs accepts (R8-17)', async () => {
    const t2 = await makeTestApp();
    try {
      const rows = [
        '| 1 | 2026-09-20 | Acme | - | Engineer | 4.0/5 | interview | - | - | |',
        '| 2 | 2026-09-21 | Beta | - | Engineer | 4.0/5 | aplicado | - | - | |',
        '| 3 | 2026-09-22 | Gamma | - | Engineer | 4.0/5 | Applied | - | - | |',
        '| 4 | 2026-09-23 | Delta | - | Engineer | 4.0/5 | **OFFER** | - | - | |',
      ];
      fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'applications.md'), `${HEADER_ONLY}${rows.join('\n')}\n`);
      fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'status-log.tsv'), '3\t2026-09-25\tapplied\tentrevista\tweb\t\n');
      const dash = (await t2.app.inject({ method: 'GET', url: '/api/insights/dashboard', headers: t2.authed })).json();
      expect(dash.dashboard.totals.byStatus).toEqual({ Interview: 1, Applied: 2, Offer: 1 });
      const funnel = Object.fromEntries((dash.dashboard.funnel as Array<{ stage: string; count: number }>).map((f) => [f.stage, f.count]));
      expect(funnel).toMatchObject({ Evaluated: 4, Applied: 4, Responded: 3, Interview: 3, Offer: 1 });
    } finally {
      await t2.close();
    }
  });

  it('reports a header-only tracker and its dashboard as ok and empty', async () => {
    const t2 = await makeTestApp();
    fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'applications.md'), HEADER_ONLY);
    const tracker = (await t2.app.inject({ method: 'GET', url: '/api/tracker', headers: t2.authed })).json();
    expect(tracker).toMatchObject({ kind: 'ok', rows: [] });
    const dash = (await t2.app.inject({ method: 'GET', url: '/api/insights/dashboard', headers: t2.authed })).json();
    expect(dash).toMatchObject({ kind: 'ok', dashboard: { totals: { applications: 0 } } });
    await t2.close();
  });

  it('does not hide a tracker whose rows all fail to parse behind an empty cadence', async () => {
    const t2 = await makeTestApp();
    fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'applications.md'), `${HEADER_ONLY}| x | y |\n`);
    expect((await t2.app.inject({ method: 'GET', url: '/api/tracker', headers: t2.authed })).json().kind).toBe('malformed');
    const res = await t2.app.inject({ method: 'GET', url: '/api/followups', headers: t2.authed });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/malformed/);
    await t2.close();
  });

  it('returns 502 when the script claims no applications but the tracker has rows', async () => {
    const t2 = await makeTestApp({}, { exec: async () => ({ code: 1, stdout: JSON.stringify({ error: 'No applications found in tracker.' }), stderr: '' }) });
    const res = await t2.app.inject({ method: 'GET', url: '/api/followups', headers: t2.authed });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/tracker has rows/);
    await t2.close();
  });

  const failing: Array<[string, { code: number; stdout: string; stderr: string }]> = [
    ['non-JSON output with exit 0', { code: 0, stdout: 'not json at all', stderr: '' }],
    ['an unrelated JSON error with exit 1', { code: 1, stdout: JSON.stringify({ error: 'templates/states.yml is unreadable' }), stderr: '' }],
    ['a crash with no stdout', { code: 2, stdout: '', stderr: 'Cannot find package js-yaml' }],
    ['non-JSON output with exit 1', { code: 1, stdout: 'No applications found in tracker.', stderr: '' }],
  ];

  it.each(failing)('still returns 502 for %s', async (_name, result) => {
    const t2 = await makeTestApp({}, { exec: async () => result });
    const res = await t2.app.inject({ method: 'GET', url: '/api/followups', headers: t2.authed });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/followup-cadence/);
    await t2.close();
  });
});

describe('insight scripts on an empty tracker', () => {
  const HEADER_ONLY = '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n';
  const arrange: Array<[string, (root: string) => void]> = [
    ['no tracker file', (root) => fs.rmSync(path.join(root, 'data', 'applications.md'))],
    ['a header-only tracker', (root) => fs.writeFileSync(path.join(root, 'data', 'applications.md'), HEADER_ONLY)],
  ];

  it.each(arrange)('every cached insight script reads as ok, not failed, for %s', async (_name, prepare) => {
    const t2 = await makeTestApp();
    prepare(t2.cfg.dataRoot);
    fs.rmSync(path.join(t2.cfg.dataRoot, 'data', 'follow-ups.md'));
    fs.rmSync(path.join(t2.cfg.dataRoot, 'data', 'status-log.tsv'));
    const ids = ((await t2.app.inject({ method: 'GET', url: '/api/insights/scripts', headers: t2.authed })).json() as Array<{ id: string }>).map((s) => s.id);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const res = await t2.app.inject({ method: 'GET', url: `/api/insights/${id}?recompute=1`, headers: t2.authed });
      expect(res.statusCode, id).toBe(200);
      const body = res.json();
      expect({ id, kind: body.kind, exit: body.exit, text: body.text }, `${id} output`).toMatchObject({ kind: 'ok', exit: 0 });
    }
    await t2.close();
  });
});

describe('file serving', () => {
  it('serves reports under the data root with the right content type', async () => {
    const res = await get('/api/files/serve?path=reports/001-acme-robotics.md');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('# Evaluation');
  });

  it('refuses traversal, absolute paths, other roots and unknown types', async () => {
    expect((await get('/api/files/serve?path=../cv.md')).statusCode).toBe(403);
    expect((await get('/api/files/serve?path=reports/../cv.md')).statusCode).toBe(403);
    expect((await get(`/api/files/serve?path=${encodeURIComponent(path.join(t.cfg.dataRoot, 'cv.md'))}`)).statusCode).toBe(403);
    expect((await get('/api/files/serve?path=data/pipeline.md')).statusCode).toBe(403);
    expect((await get('/api/files/serve?path=reports/nope.md')).statusCode).toBe(403);
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'reports', 'x.exe'), 'x');
    expect((await get('/api/files/serve?path=reports/x.exe')).statusCode).toBe(415);
  });

  it('containedPath follows symlinks and rejects escapes', () => {
    const outside = path.join(t.cfg.dataRoot, 'cv.md');
    fs.symlinkSync(outside, path.join(t.cfg.dataRoot, 'reports', 'link.md'));
    expect(containedPath(t.cfg.dataRoot, 'reports/link.md')).toBeNull();
    expect(containedPath(t.cfg.dataRoot, 'reports/001-acme-robotics.md')?.root).toBe('reports');
  });

  it('containedPath refuses every file when a serve root is symlinked to the filesystem root', () => {
    const dataRoot = tempDir('cc-slash-root-');
    try {
      fs.symlinkSync('/', path.join(dataRoot, 'output'));
      const file = path.join(fs.realpathSync(dataRoot), 'target.md');
      fs.writeFileSync(file, 'hi');
      expect(containedPath(dataRoot, `output${file}`)).toBeNull();
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('containedPath rejects a parent-directory escape out of a serve root', () => {
    expect(containedPath(t.cfg.dataRoot, 'reports/../cv.md')).toBeNull();
    expect(containedPath(t.cfg.dataRoot, 'reports/../../etc/hosts')).toBeNull();
  });

  it('html is served sandboxed', async () => {
    fs.mkdirSync(path.join(t.cfg.dataRoot, 'output'), { recursive: true });
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'cv.html'), '<p>hi</p>');
    const res = await get('/api/files/serve?path=output/cv.html');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });
});

describe('events', () => {
  it('formats SSE frames with the sequence as the event id', () => {
    expect(formatSse({ seq: 7, type: 'data.changed', payload: { domain: 'tracker' }, ts: 't' })).toBe('id: 7\nevent: data.changed\ndata: {"domain":"tracker","ts":"t"}\n\n');
  });
  it('maps changed files to domains', () => {
    expect(domainFor('data/applications.md')).toBe('tracker');
    expect(domainFor('data/status-log.tsv')).toBe('tracker');
    expect(domainFor('data/pipeline.md')).toBe('pipeline');
    expect(domainFor('reports/001-x.md')).toBe('reports');
    expect(domainFor('data/immigration/companies/a.md')).toBe('immigration');
    expect(domainFor('data/follow-ups.md')).toBe('followups');
    expect(domainFor('data/shortlist.md')).toBe('shortlist');
    expect(domainFor('portals.yml')).toBe('config');
    expect(domainFor('modes/_custom.md')).toBe('config');
    expect(domainFor('data/control-center/runs/x/meta.json')).toBeNull();
    expect(domainFor('random.txt')).toBeNull();
  });
  it('the SSE endpoint requires the cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/events', headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('status log next to the tracker (R7-14)', () => {
  // set-status.mjs appends the ledger beside the tracker it wrote: join(dirname(APPS_FILE), 'status-log.tsv').
  it('a root-layout tracker (applications.md at the top) shows the change set-status.mjs logged beside it, on the Timeline and the dashboard', async () => {
    const t2 = await makeTestApp();
    const root = t2.cfg.dataRoot;
    try {
      fs.renameSync(path.join(root, 'data', 'applications.md'), path.join(root, 'applications.md'));
      fs.rmSync(path.join(root, 'data', 'status-log.tsv'));
      const res = await t2.app.inject({ method: 'POST', url: '/api/actions/tracker.setStatus', headers: t2.authedWrite, payload: { params: { row: 2, state: 'Applied' } } });
      expect(res.statusCode, res.body).toBe(200);
      expect(fs.existsSync(path.join(root, 'status-log.tsv'))).toBe(true);
      const row = (await t2.app.inject({ method: 'GET', url: '/api/tracker/2', headers: t2.authed })).json();
      expect(row.timeline.statusLog).toMatchObject([{ num: 2, from: 'Evaluated', to: 'Applied', source: 'web' }]);
      const dash = (await t2.app.inject({ method: 'GET', url: '/api/insights/dashboard', headers: t2.authed })).json();
      expect(dash.dashboard.weeklyActivity.reduce((a: number, w: { transitions: number }) => a + w.transitions, 0)).toBe(1);
    } finally {
      await t2.close();
    }
  });

  it('the watcher maps the root-layout ledger to the tracker domain', () => {
    expect(domainFor('status-log.tsv')).toBe('tracker');
  });
});

describe('the Timeline pin follows the cadence (R7-17)', () => {
  const FOLLOWUPS = (logged: string) =>
    `# Follow-ups\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | ${logged} | Acme Robotics | Senior Backend Engineer | Email | Pat Example | nudged |\n\n- next #1 2026-10-10 (set 2026-10-01)\n`;
  const pinFor = async (logged: string) => {
    const t2 = await makeTestApp();
    try {
      fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'follow-ups.md'), FOLLOWUPS(logged));
      return (await t2.app.inject({ method: 'GET', url: '/api/tracker/1', headers: t2.authed })).json().timeline.pin;
    } finally {
      await t2.close();
    }
  };

  it('drops a pin once a follow-up is logged after the day it was set', async () => {
    expect(await pinFor('2026-10-02')).toBeNull();
  });

  it('drops it too when the later follow-up is a legacy bullet line (`- date · #N Company <dash> note`)', async () => {
    const t2 = await makeTestApp();
    try {
      const legacy = `# Follow-ups\n\n- 2026-10-02 \u00b7 #1 Acme Robotics ${String.fromCharCode(0x2014)} nudged\n\n- next #1 2026-10-10 (set 2026-10-01)\n`;
      fs.writeFileSync(path.join(t2.cfg.dataRoot, 'data', 'follow-ups.md'), legacy);
      const body = (await t2.app.inject({ method: 'GET', url: '/api/tracker/1', headers: t2.authed })).json();
      expect(body.timeline.followups).toMatchObject([{ num: null, appNum: 1, date: '2026-10-02', company: 'Acme Robotics', notes: 'nudged' }]);
      expect(body.timeline.pin).toBeNull();
    } finally {
      await t2.close();
    }
  });

  it('keeps a pin set the same day as the last follow-up, or after it', async () => {
    expect(await pinFor('2026-10-01')).toMatchObject({ date: '2026-10-10', setOn: '2026-10-01' });
    expect(await pinFor('2026-09-28')).toMatchObject({ date: '2026-10-10', setOn: '2026-10-01' });
  });
});
