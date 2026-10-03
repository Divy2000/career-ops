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

describe('daily job awareness', () => {
  it('reports whether run-daily.sh is running from pgrep', async () => {
    expect((await get('/api/system/daily')).json()).toMatchObject({ running: false });
    pgrepRunning = true;
    await new Promise((r) => setTimeout(r, 200));
    expect((await get('/api/system/daily')).json()).toMatchObject({ running: true });
    pgrepRunning = false;
  });
});
