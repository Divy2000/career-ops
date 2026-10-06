import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importCore } from '../../server/core/adapter.js';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import type { Exec } from '../../server/routes/system.js';
import { pipelineAddBatches, type ScanPostingInput } from '../../shared/pipeline-add.js';
import { dailyPidfile } from '../../server/system/daily.js';

let t: TestApp;
let jobRunning = false;
const fakeExec: Exec = async (cmd, args, opts) => {
  // The daily probe asks ps about the pid in the job's pidfile.
  if (cmd === 'ps') return jobRunning ? { code: 0, stdout: '/bin/bash /checkout/custom/immigration/run-daily.sh\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
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
  it('skip while another writer holds the pipeline lock answers 409 with retry-after and leaves the file alone, then works once it is free (SW4-tests-18)', async () => {
    const url = 'https://jobs.example.com/acme/123';
    const pipeline = path.join(t.cfg.dataRoot, 'data', 'pipeline.md');
    const { acquirePipelineLock } = await importCore<{ acquirePipelineLock: (p: string, o?: { timeoutMs?: number }) => Promise<{ release(): void }> }>(t.cfg.codeRoot, 'pipeline-lock.mjs');
    const before = readData('data/pipeline.md');
    const prior = process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
    process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS = '300';
    const lock = await acquirePipelineLock(pipeline, { timeoutMs: 60_000 });
    let released = false;
    try {
      const busy = await post('/api/pipeline/skip', { url, done: true });
      expect(busy.statusCode, busy.body).toBe(409);
      expect(busy.headers['retry-after']).toBe('1');
      expect(readData('data/pipeline.md')).toBe(before);
      lock.release();
      released = true;
      const free = await post('/api/pipeline/skip', { url, done: true });
      expect(free.statusCode, free.body).toBe(200);
      expect(readData('data/pipeline.md')).toContain(`- [x] ${url}`);
      expect((await post('/api/pipeline/skip', { url, done: false })).statusCode).toBe(200);
    } finally {
      if (!released) lock.release();
      if (prior === undefined) delete process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
      else process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS = prior;
    }
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
  it('a Network scan result keeps its posted date and its ATS through scan.mjs: the pipeline row and scan-history carry both (R8-08)', async () => {
    const url = 'https://boards.example.com/posted/1';
    const [body] = pipelineAddBatches([{ url, company: 'Posted Co', title: 'Platform Engineer', location: 'Remote', postedAt: '2026-09-30', source: 'ashby' }]);
    expect(body!.offers[0]).toMatchObject({ postedAt: '2026-09-30', portal: 'ashby' });
    const r = await post('/api/pipeline/add', body);
    expect(r.statusCode, r.body).toBe(200);
    expect(readData('data/pipeline.md')).toContain(`- [ ] ${url} | Posted Co | Platform Engineer | Remote | posted: 2026-09-30`);
    const row = (await get('/api/pipeline')).json().rows.find((x: { url: string }) => x.url === url);
    expect(row.postedAt).toBe('2026-09-30');
    const history = readData('data/scan-history.tsv').split('\n').find((l) => l.startsWith(`${url}\t`))!.split('\t');
    // url, first_seen, portal, title, company, status, location, fingerprint, posted_at
    expect([history[2], history[5], history[8]]).toEqual(['ashby', 'added', '2026-09-30']);
  });
  it('refuses a posted date that is not a calendar day', async () => {
    for (const postedAt of ['2026-02-30', 'yesterday', '2026-9-1']) {
      const r = await post('/api/pipeline/add', { offers: [{ url: 'https://boards.example.com/posted/bad', company: 'Bad', title: 'Eng', postedAt }] });
      expect(r.statusCode, postedAt).toBe(400);
    }
    expect(pipelineAddBatches([{ url: 'https://boards.example.com/posted/2', postedAt: 'n/a' }])[0]!.offers[0]).not.toHaveProperty('postedAt');
  });
  it('adding is idempotent: URLs already in the pipeline (pending or processed, however spelled) and repeats within the request are skipped and counted', async () => {
    const fresh = 'https://boards.example.com/idem/1';
    const other = 'https://boards.example.com/idem/2';
    const offer = (url: string) => ({ url, company: 'Idem Co', title: 'Platform Engineer' });
    const body = {
      offers: [
        offer(fresh),
        // The same posting with a tracking parameter and a trailing slash.
        offer(`${fresh}/?utm_source=x`),
        // Already pending, and already processed, in the fixture pipeline.
        offer('https://jobs.example.com/acme/123'),
        offer('https://jobs.example.com/oldcorp/1'),
        offer(other),
      ],
    };
    const first = await post('/api/pipeline/add', body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ added: 2, skipped: 3 });
    // A retry of the same request (an Add all that failed part way) adds nothing.
    const again = await post('/api/pipeline/add', body);
    expect(again.json()).toEqual({ added: 0, skipped: 5 });
    const pipeline = readData('data/pipeline.md');
    for (const url of [fresh, other, 'https://jobs.example.com/acme/123', 'https://jobs.example.com/oldcorp/1']) expect(pipeline.split(`${url} `).length - 1, url).toBe(1);
    expect(pipeline).not.toContain('utm_source');
    const history = readData('data/scan-history.tsv').split('\n').filter((l) => l.startsWith(`${fresh}\t`) || l.startsWith(`${other}\t`));
    expect(history).toHaveLength(2);
  });
  it('a retry after the history write failed records the missing history row once, and nothing for a URL history already has', async () => {
    // The state a failed add leaves: the pipeline write landed, appendToScanHistory did not (lock timeout, full disk).
    const halfway = 'https://boards.example.com/halfway/1';
    const pipelinePath = path.join(t.cfg.dataRoot, 'data', 'pipeline.md');
    fs.writeFileSync(pipelinePath, readData('data/pipeline.md').replace('## Pending\n\n', `## Pending\n\n- [ ] ${halfway} | Halfway Co | Backend Engineer\n`));
    const rowsFor = (url: string) => readData('data/scan-history.tsv').split('\n').filter((l) => l.startsWith(`${url}\t`));
    expect(rowsFor(halfway)).toEqual([]);
    const body = { offers: [{ url: halfway, company: 'Halfway Co', title: 'Backend Engineer' }, { url: 'https://jobs.example.com/acme/123', company: 'Acme Robotics', title: 'Senior Backend Engineer' }] };
    const retry = await post('/api/pipeline/add', body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual({ added: 0, skipped: 2 });
    expect(rowsFor(halfway)).toHaveLength(1);
    expect(rowsFor(halfway)[0]!.split('\t').slice(3, 6)).toEqual(['Backend Engineer', 'Halfway Co', 'added']);
    expect(rowsFor('https://jobs.example.com/acme/123')).toHaveLength(1);
    expect((await post('/api/pipeline/add', body)).json()).toEqual({ added: 0, skipped: 2 });
    expect(rowsFor(halfway)).toHaveLength(1);
    expect(readData('data/pipeline.md').split(`${halfway} `).length - 1).toBe(1);
  });
  it('a headerless scan-history (legacy) keeps its first row: a listed URL recorded there gets no second history row', async () => {
    const listed = 'https://boards.example.com/legacy/1';
    const historyPath = path.join(t.cfg.dataRoot, 'data', 'scan-history.tsv');
    const before = readData('data/scan-history.tsv');
    try {
      fs.writeFileSync(historyPath, `${listed}\t2026-09-01\tgreenhouse\tBackend Engineer\tLegacy Co\tadded\n`);
      fs.writeFileSync(path.join(t.cfg.dataRoot, 'data', 'pipeline.md'), readData('data/pipeline.md').replace('## Pending\n\n', `## Pending\n\n- [ ] ${listed} | Legacy Co | Backend Engineer\n`));
      const r = await post('/api/pipeline/add', { offers: [{ url: listed, company: 'Legacy Co', title: 'Backend Engineer' }] });
      expect(r.json()).toEqual({ added: 0, skipped: 1 });
      expect(readData('data/scan-history.tsv').split('\n').filter((l) => l.startsWith(`${listed}\t`))).toHaveLength(1);
    } finally {
      fs.writeFileSync(historyPath, before);
    }
  });
  it('Network scan results with no location, a very long location and more rows than one request takes are all added', async () => {
    const postings: ScanPostingInput[] = Array.from({ length: 205 }, (_, i) => ({ url: `https://boards.example.com/bulk/${i}`, company: `Bulk ${i}`, title: 'Platform Engineer', location: 'Remote', source: 'greenhouse' }));
    postings[0]!.location = null;
    postings[1]!.location = '';
    postings[2]!.location = Array.from({ length: 40 }, (_, i) => `Office ${i}`).join('; ');
    const batches = pipelineAddBatches(postings);
    expect(batches.map((b) => b.offers.length)).toEqual([200, 5]);
    for (const body of batches) {
      const r = await post('/api/pipeline/add', body);
      expect(r.statusCode, r.body).toBe(200);
    }
    const pipeline = readData('data/pipeline.md');
    expect(postings.filter((p) => !pipeline.includes(`${p.url} `)).map((p) => p.url)).toEqual([]);
  });
});

describe('pipeline adds while another writer holds the pipeline lock (SW2-tests-03)', () => {
  it('answer 409 "pipeline is busy" with retry-after for /add and /urls, write nothing, and add once the lock is free', async () => {
    const { acquirePipelineLock } = (await import(pathToFileURL(path.join(t.cfg.codeRoot, 'pipeline-lock.mjs')).href)) as { acquirePipelineLock: (p: string, o?: Record<string, number>) => Promise<{ release: () => void }> };
    const pipeline = path.join(t.cfg.dataRoot, 'data', 'pipeline.md');
    const before = fs.readFileSync(pipeline, 'utf8');
    const lock = await acquirePipelineLock(pipeline);
    // The writer child waits this long for one holder (scan.mjs's own override), so a held lock times out quickly.
    const saved = process.env.CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS;
    process.env.CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS = '300';
    process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS = '600';
    try {
      for (const res of [await post('/api/pipeline/add', { offers: [{ url: 'https://jobs.example.com/busy/1', company: 'Busy Co', title: 'Engineer' }] }), await post('/api/pipeline/urls', { urls: ['https://jobs.example.com/busy/2'] })]) {
        expect(res.statusCode, res.body).toBe(409);
        expect(res.headers['retry-after']).toBe('1');
        expect(res.json()).toEqual({ error: 'pipeline is busy, try again in a moment' });
      }
      expect(fs.readFileSync(pipeline, 'utf8')).toBe(before);
    } finally {
      lock.release();
      if (saved === undefined) delete process.env.CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS;
      else process.env.CAREER_OPS_PIPELINE_LOCK_TIMEOUT_MS = saved;
      delete process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
    }
    const after = await post('/api/pipeline/add', { offers: [{ url: 'https://jobs.example.com/busy/1', company: 'Busy Co', title: 'Engineer' }] });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toEqual({ added: 1, skipped: 0 });
  });
});

describe('follow-up edits that cannot write (SW2-tests-23)', () => {
  it('while another writer holds the follow-ups lock, answers 409 busy with retry-after and writes nothing', async () => {
    const { withFollowupsLock } = (await import(pathToFileURL(path.join(t.cfg.codeRoot, 'followup-seed.mjs')).href)) as { withFollowupsLock: <T>(p: string, fn: () => Promise<T>) => Promise<T> };
    const file = path.join(t.cfg.dataRoot, 'data', 'follow-ups.md');
    const before = fs.readFileSync(file, 'utf8');
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = withFollowupsLock(file, () => new Promise<void>((r) => ((release = r), held())));
    await holding;
    try {
      const res = await post('/api/followups/override', { appNum: 1, date: '2026-10-20' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.json().error).toMatch(/follow-ups file is busy/);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      release();
      await holder;
    }
  }, 30_000);

  // chmod 000 does not stop root, so as root the write succeeds and there is no EACCES to provoke (SW4-tests-25).
  it.skipIf(process.getuid?.() === 0)('a write error whose message happens to contain "lock" (a data root under a folder named clock) is a 500 with the real error, not "busy"', async () => {
    const dataRoot = path.join(tempDir('cc-clock-'), 'root');
    fs.cpSync(path.join(t.cfg.dataRoot), dataRoot, { recursive: true });
    const own = await makeTestApp({ dataRoot });
    const file = path.join(dataRoot, 'data', 'follow-ups.md');
    fs.chmodSync(file, 0o000);
    try {
      const res = await own.app.inject({ method: 'POST', url: '/api/followups/override', headers: own.authedWrite, payload: { appNum: 1, date: '2026-10-20' } });
      expect(res.statusCode, res.body).toBe(500);
      expect(res.body).toMatch(/EACCES/);
      expect(res.body).not.toMatch(/busy/);
    } finally {
      fs.chmodSync(file, 0o644);
      await own.close();
    }
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

describe('dates the app writes are local dates (vitest runs in America/Los_Angeles)', () => {
  // 19:00 on 2026-10-05 in Los Angeles is already 2026-10-06 in UTC.
  const usEvening = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 5, 19, 0));
  };
  afterEach(() => vi.useRealTimers());

  it('a follow-up pin records the local day it was set on', async () => {
    usEvening();
    const r = await post('/api/followups/override', { appNum: 6, date: '2026-10-12' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await get('/api/tracker/6')).json().timeline.pin).toMatchObject({ appNum: 6, date: '2026-10-12', setOn: '2026-10-05' });
    expect((await del('/api/followups/override', { appNum: 6 })).statusCode).toBe(200);
  });

  it('a posting added to the pipeline is first seen on the local day, as scan.mjs stamps it', async () => {
    usEvening();
    const url = 'https://jobs.example.com/evening/1';
    const r = await post('/api/pipeline/add', { offers: [{ url, company: 'Evening Co', title: 'Backend Engineer' }] });
    expect(r.statusCode, r.body).toBe(200);
    const row = readData('data/scan-history.tsv').split('\n').find((l) => l.startsWith(`${url}\t`));
    expect(row?.split('\t')[1]).toBe('2026-10-05');
  });
});

describe('tracker delete', () => {
  it('dry-run previews without changing the tracker, then the real delete removes the row', async () => {
    const preview = await post('/api/actions/tracker.delete', { params: { n: 4, dryRun: true } });
    expect(preview.statusCode, preview.body).toBe(200);
    // tracker.mjs narrates the preview on stderr; the body carries both streams.
    expect(preview.body).toMatch(/dry|would/i);
    expect((await get('/api/tracker')).json().rows.some((r: { num: number }) => r.num === 4)).toBe(true);
    // The real delete is a confirm action: refused without the page's explicit confirmation, done with it.
    const unconfirmed = await post('/api/actions/tracker.delete', { params: { n: 4, dryRun: false } });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(428);
    expect(unconfirmed.json()).toMatchObject({ error: expect.stringMatching(/Delete tracker row needs confirmation/), confirm: expect.stringMatching(/Removes the row/) });
    expect((await get('/api/tracker')).json().rows.some((r: { num: number }) => r.num === 4)).toBe(true);
    const real = await post('/api/actions/tracker.delete', { params: { n: 4, dryRun: false }, confirmed: true });
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

  it('lists a JD capture whose report prefix is not padded to three digits, as jd-capture.mjs resolves it, and never another report\'s (SW2-server-04)', async () => {
    const files = ['jds/1-acme-hand-named.md', 'jds/0001-acme-four-digits.md', 'jds/10-other-report.md', 'jds/100-other-report.md'];
    for (const f of files) write(f);
    try {
      const jds = (await docsOf(9)).jds as string[];
      expect(jds).toEqual(expect.arrayContaining(['jds/1-acme-hand-named.md', 'jds/0001-acme-four-digits.md']));
      expect(jds).not.toContain('jds/10-other-report.md');
      expect(jds).not.toContain('jds/100-other-report.md');
    } finally {
      for (const f of files) fs.rmSync(path.join(d.cfg.dataRoot, f), { force: true });
    }
  });

  it('falls back to the company match for JDs when the row has no report', async () => {
    write('jds/umbrella-corp-security-analyst.md');
    expect((await docsOf(5)).jds).toEqual(['jds/umbrella-corp-security-analyst.md']);
  });

  it('matches the company as a whole word in a file name, so another company whose name contains it is not listed (SW-server-03)', async () => {
    const files = ['output/cv-jane-umbrella-corp-2026-10-01.pdf', 'output/cv-jane-umbrella-corporate-travel.pdf', 'output/cv-jane-umbrella-corporate-travel.html', 'jds/umbrella-corporate-travel-sales.md'];
    for (const f of files) write(f);
    try {
      const docs = await docsOf(5);
      expect(docs.files.map((f: { path: string }) => f.path)).toContain('output/cv-jane-umbrella-corp-2026-10-01.pdf');
      expect(docs.files.map((f: { path: string }) => f.path)).not.toContain('output/cv-jane-umbrella-corporate-travel.pdf');
      expect(docs.jds).not.toContain('jds/umbrella-corporate-travel-sales.md');
    } finally {
      for (const f of files) fs.rmSync(path.join(d.cfg.dataRoot, f), { force: true });
    }
  });

  const rerender = (params: Record<string, unknown>) => d.app.inject({ method: 'POST', url: '/api/actions/docs.renderPdf', headers: d.authedWrite, payload: { params: { html: 'output/acme-robotics-cv.html', pdf: 'output/acme-robotics-cv.pdf', format: 'letter', ...params } } });

  it('refuses a re-render filed under a report the row is not linked to', async () => {
    const res = await rerender({ row: 9, report: 9 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('Row #9 is filed under report 1, not report 9. Reload the Documents tab and try again.');
  });

  it('offers Re-render only for files the row report owns and refuses another report CV server-side', async () => {
    write('output/acme-robotics-platform-cv.pdf');
    write('output/acme-robotics-platform-cv.html', '<html></html>');
    appendIndex('99\toutput/acme-robotics-platform-cv.pdf\toutput/acme-robotics-platform-cv.html\tletter\t2026-10-02\tcv');
    const files = (await docsOf(1)).files as { path: string; rerenderBlock: string | null }[];
    expect(files.find((f) => f.path === 'output/acme-robotics-cv.pdf')?.rerenderBlock).toBeNull();
    expect(files.find((f) => f.path === 'output/acme-robotics-platform-cv.pdf')?.rerenderBlock).toMatch(/belongs to report 99/);
    const res = await rerender({ row: 1, report: 1, html: 'output/acme-robotics-platform-cv.html', pdf: 'output/acme-robotics-platform-cv.pdf' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('output/acme-robotics-platform-cv.pdf belongs to report 99, so re-rendering it here would file it under report 1. Re-render it from that application instead.');
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
  it('reports whether run-daily.sh is running from its pidfile', async () => {
    expect((await get('/api/system/daily')).json()).toMatchObject({ running: false });
    const pidfile = dailyPidfile(t.cfg.dataRoot);
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    fs.writeFileSync(pidfile, '4242\n');
    jobRunning = true;
    try {
      // The answer of a watcher poll that started after the pidfile was written: the first poll to finish after now may
      // have started before it, the one after that did not (SW2-tests-21).
      const since = Date.now();
      let first: string | null = null;
      let status: { running: boolean; checkedAt: string | null } | null = null;
      for (let i = 0; i < 400 && !status; i++) {
        const s = (await get('/api/system/daily')).json() as { running: boolean; checkedAt: string | null };
        if (s.checkedAt && Date.parse(s.checkedAt) > since) {
          if (first === null) first = s.checkedAt;
          else if (s.checkedAt !== first) status = s;
        }
        if (!status) await new Promise((r) => setTimeout(r, 15));
      }
      expect(status, 'the daily watcher polled twice after the pidfile was written').not.toBeNull();
      expect(status).toMatchObject({ running: true });
    } finally {
      jobRunning = false;
      fs.rmSync(pidfile);
    }
  });
});
