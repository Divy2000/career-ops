import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import type { Exec } from '../../server/routes/system.js';

let t: TestApp;
let pgrepRunning = false;
const fakeExec: Exec = async (cmd, args, opts) => {
  if (cmd === 'pgrep') return { code: pgrepRunning ? 0 : 1, stdout: pgrepRunning ? '4242\n' : '', stderr: '' };
  const { execNoShell } = await import('../../server/routes/system.js');
  return execNoShell(cmd, args, opts);
};
beforeAll(async () => {
  t = await makeTestApp({}, { exec: fakeExec, dailyPollMs: 50 });
});
afterAll(async () => {
  await t.close();
});
const post = (url: string, payload?: unknown) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload: payload as Record<string, unknown> });
const del = (url: string, payload?: unknown) => t.app.inject({ method: 'DELETE', url, headers: t.authedWrite, payload: payload as Record<string, unknown> });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const readData = (rel: string) => fs.readFileSync(path.join(t.cfg.dataRoot, rel), 'utf8');

describe('pipeline writes', () => {
  it('skip flips the Pending checkbox under the pipeline lock and undo flips it back', async () => {
    const url = 'https://jobs.example.com/acme/123';
    const r = await post('/api/pipeline/skip', { url, done: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ matched: 1, changed: 1 });
    expect(readData('data/pipeline.md')).toContain(`- [x] ${url}`);
    const undo = await post('/api/pipeline/skip', { url, done: false });
    expect(undo.statusCode).toBe(200);
    expect(readData('data/pipeline.md')).toContain(`- [ ] ${url}`);
  });
  it('skip rejects unknown and invalid URLs without touching the file', async () => {
    const before = readData('data/pipeline.md');
    expect((await post('/api/pipeline/skip', { url: 'https://nowhere.example/x', done: true })).statusCode).toBe(404);
    expect((await post('/api/pipeline/skip', { url: 'file:///etc/passwd', done: true })).statusCode).toBe(400);
    expect(readData('data/pipeline.md')).toBe(before);
  });
  it('adds URLs through the core writer child and they show up in the inbox', async () => {
    const r = await post('/api/pipeline/urls', { urls: ['https://jobs.example.com/newco/5'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ added: 1 });
    const pipeline = (await get('/api/pipeline')).json();
    expect(pipeline.rows.some((row: { url: string }) => row.url === 'https://jobs.example.com/newco/5')).toBe(true);
    expect((await post('/api/pipeline/urls', { urls: ['not-a-url'] })).statusCode).toBe(400);
  });
  it('adds structured offers and records them in scan-history', async () => {
    const r = await post('/api/pipeline/add', { offers: [{ url: 'https://jobs.example.com/offerco/7', company: 'Offer Co', title: 'Backend Engineer', location: 'Remote', portal: 'greenhouse' }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(readData('data/pipeline.md')).toContain('https://jobs.example.com/offerco/7');
    expect(readData('data/scan-history.tsv')).toContain('https://jobs.example.com/offerco/7');
  });
});

describe('follow-up writes', () => {
  it('logs a follow-up, shows it on the application timeline and deletes it again', async () => {
    const r = await post('/api/followups/log', { appNum: 6, date: '2026-10-03', channel: 'Email', contact: 'HM', notes: 'sent deck' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ num: 3 });
    const detail = (await get('/api/tracker/6')).json();
    expect(detail.timeline.followups.map((f: { num: number }) => f.num)).toContain(3);
    const d = await del('/api/followups/log', { num: 3 });
    expect(d.statusCode, d.body).toBe(200);
    expect((await get('/api/tracker/6')).json().timeline.followups.map((f: { num: number }) => f.num)).not.toContain(3);
    expect((await del('/api/followups/log', { num: 99 })).statusCode).toBe(404);
  });
  it('pins and clears the next follow-up date', async () => {
    const r = await post('/api/followups/override', { appNum: 6, date: '2026-10-21' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await get('/api/tracker/6')).json().timeline.pin).toMatchObject({ appNum: 6, date: '2026-10-21' });
    expect((await del('/api/followups/override', { appNum: 6 })).statusCode).toBe(200);
    expect((await get('/api/tracker/6')).json().timeline.pin).toBeNull();
    expect((await post('/api/followups/override', { appNum: 6, date: 'soon' })).statusCode).toBe(400);
  });
});

describe('tracker delete', () => {
  it('dry-run previews without changing the tracker, then the real delete removes the row', async () => {
    const preview = await post('/api/actions/tracker.delete', { params: { n: 4, dryRun: true } });
    expect(preview.statusCode, preview.body).toBe(200);
    // tracker.mjs narrates the preview on stderr; the body carries both streams.
    expect(preview.body).toMatch(/dry|would/i);
    expect((await get('/api/tracker')).json().rows.some((r: { num: number }) => r.num === 4)).toBe(true);
    const real = await post('/api/actions/tracker.delete', { params: { n: 4, dryRun: false } });
    expect(real.statusCode, real.body).toBe(200);
    expect((await get('/api/tracker')).json().rows.some((r: { num: number }) => r.num === 4)).toBe(false);
  });
});

describe('documents', () => {
  it('lists PDFs and HTML twins for an application from pdf-index.tsv and the output folder', async () => {
    const docs = (await get('/api/tracker/1/documents')).json();
    expect(docs.files.some((f: { path: string }) => f.path === 'output/acme-robotics-cv.pdf')).toBe(true);
    expect(docs.files.find((f: { path: string }) => f.path === 'output/acme-robotics-cv.pdf')).toMatchObject({ kind: 'cv', html: 'output/acme-robotics-cv.html', source: 'index' });
    expect(docs.files.some((f: { path: string }) => f.path === 'output/acme-robotics-extra.pdf')).toBe(true);
  });
});

describe('documents for a row whose number differs from its report', () => {
  let d: TestApp;
  beforeAll(async () => {
    d = await makeTestApp();
    // Row 9 is a second Acme role filed under report 1, so its row number and report number differ.
    fs.appendFileSync(path.join(d.cfg.dataRoot, 'data', 'applications.md'), '| 9 | 2026-10-01 | Acme Robotics | - | Platform Engineer | 4.0/5 | Evaluated | ✅ | [1](../reports/001-acme-robotics.md) | second role |\n');
  });
  afterAll(async () => {
    await d.close();
  });
  const write = (rel: string, text = '%PDF-1.4\n') => {
    const file = path.join(d.cfg.dataRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const appendIndex = (line: string) => fs.appendFileSync(path.join(d.cfg.dataRoot, 'data', 'pdf-index.tsv'), `${line}\n`);
  const docsOf = async (n: number) => (await d.app.inject({ method: 'GET', url: `/api/tracker/${n}/documents`, headers: d.authed })).json();

  it('reads pdf-index.tsv and the jds/ prefix by the row report number, not by the tracker row number', async () => {
    appendIndex('9\toutput/globex-payments-cv.pdf\t\tletter\t2026-10-01\tcv');
    write('jds/001-2026-09-20_acme-robotics_backend.pdf');
    write('jds/009-2026-10-01_globex-payments_staff.pdf');
    const docs = await docsOf(9);
    expect(docs.files.find((f: { path: string }) => f.path === 'output/acme-robotics-cv.pdf')).toMatchObject({ source: 'index', kind: 'cv' });
    expect(docs.files.map((f: { path: string }) => f.path)).not.toContain('output/globex-payments-cv.pdf');
    expect(docs.jds).toContain('jds/001-2026-09-20_acme-robotics_backend.pdf');
    expect(docs.jds).not.toContain('jds/009-2026-10-01_globex-payments_staff.pdf');
  });

  it('says which report the row is filed under', async () => {
    expect((await docsOf(9)).report).toBe(1);
    expect((await docsOf(5)).report).toBeNull();
  });

  it('matches JDs by the report prefix only when the row has a report', async () => {
    write('jds/099-2026-01-01_acme-robotics_old-role.pdf');
    write('jds/acme-robotics-scan-capture.md');
    const jds = (await docsOf(9)).jds;
    expect(jds).not.toContain('jds/099-2026-01-01_acme-robotics_old-role.pdf');
    expect(jds).not.toContain('jds/acme-robotics-scan-capture.md');
  });

  it('falls back to the company match for JDs when the row has no report', async () => {
    write('jds/umbrella-corp-security-analyst.md');
    expect((await docsOf(5)).jds).toEqual(['jds/umbrella-corp-security-analyst.md']);
  });

  const rerender = (params: Record<string, unknown>) => d.app.inject({ method: 'POST', url: '/api/actions/docs.renderPdf', headers: d.authedWrite, payload: { params: { html: 'output/acme-robotics-cv.html', pdf: 'output/acme-robotics-cv.pdf', format: 'letter', ...params } } });

  it('refuses a re-render filed under a report the row is not linked to', async () => {
    const res = await rerender({ row: 9, report: 9 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('Row #9 is filed under report 1, not report 9. Reload the Documents tab and try again.');
  });

  it('refuses a re-render for a row without a report or for a missing row', async () => {
    const none = await rerender({ row: 5, report: 5 });
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json().error).toBe('Row #5 has no evaluation report, so a re-rendered PDF has nowhere to be filed.');
    const missing = await rerender({ row: 99, report: 1 });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error).toBe('There is no tracker row #99.');
  });

  it('takes nothing keyed by the row number when the row has no report', async () => {
    appendIndex('5\toutput/globex-payments-cv.pdf\t\tletter\t2026-10-01\tcv');
    write('jds/005-2026-09-28_globex-payments_analyst.pdf');
    const docs = await docsOf(5);
    expect(docs.files).toEqual([]);
    expect(docs.jds).not.toContain('jds/005-2026-09-28_globex-payments_analyst.pdf');
  });

  it('classifies cover letters like the generator: manifest kind, else only an anchored cover name', async () => {
    write('output/cv-acme-robotics-recovery-2026-10-04.pdf');
    write('output/acme-robotics-staff-cover.pdf');
    write('output/acme-robotics-senior-cover.pdf');
    appendIndex('1\toutput/acme-robotics-senior-cover.pdf\t\tletter\t2026-09-21');
    const kinds = Object.fromEntries((await docsOf(1)).files.map((f: { path: string; kind: string }) => [f.path, f.kind]));
    expect(kinds['output/cv-acme-robotics-recovery-2026-10-04.pdf']).toBe('cv');
    expect(kinds['output/acme-robotics-staff-cover.pdf']).toBe('cover');
    expect(kinds['output/acme-robotics-senior-cover.pdf']).toBe('cover');
  });
});

describe('daily job awareness', () => {
  it('reports whether run-daily.sh is running from pgrep', async () => {
    expect((await get('/api/system/daily')).json()).toMatchObject({ running: false });
    pgrepRunning = true;
    await new Promise((r) => setTimeout(r, 200));
    expect((await get('/api/system/daily')).json()).toMatchObject({ running: true });
    pgrepRunning = false;
  });
});
