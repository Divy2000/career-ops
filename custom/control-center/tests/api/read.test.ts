import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { containedPath } from '../../server/routes/read.js';
import { formatSse } from '../../server/watch/bus.js';
import { domainFor } from '../../server/watch/watcher.js';

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
    expect(body.sponsorship.companyFile).toMatchObject({ slug: 'acme-robotics', verdict: 'strong' });
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
    const fresh = (await get('/api/whats-new?days=30&limit=5')).json();
    expect(fresh.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(fresh.offers)).toBe(true);
  });

  it('GET /api/immigration/overview and a company file with its freshness verdict', async () => {
    const o = (await get('/api/immigration/overview')).json();
    expect(o.digest.kind).toBe('ok');
    expect(o.companies).toHaveLength(2);
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
