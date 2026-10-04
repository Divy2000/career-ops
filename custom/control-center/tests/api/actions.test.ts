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

const post = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = (await get(`/api/runs/${id}`)).json().meta;
    if (!['queued', 'running'].includes(meta.status)) return meta;
    if (Date.now() > deadline) throw new Error(`run ${id} still ${meta.status}`);
    await wait(100);
  }
}

describe('action registry', () => {
  it('lists actions with cost, resources and a JSON schema for params', async () => {
    const res = await get('/api/actions');
    expect(res.statusCode).toBe(200);
    const setStatus = res.json().find((a: { id: string }) => a.id === 'tracker.setStatus');
    expect(setStatus).toMatchObject({ cost: 'free', resources: ['tracker'], sync: true });
    expect(setStatus.params.properties.state.enum).toContain('Applied');
    expect(res.json().find((a: { id: string }) => a.id === 'daily.runNow').confirm).toMatch(/Continue/);
  });

  it('rejects unknown actions and invalid params before anything runs', async () => {
    expect((await post('/api/actions/nope', { params: {} })).statusCode).toBe(404);
    const bad = await post('/api/actions/tracker.setStatus', { params: { row: 'x', state: 'Nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);
  });

  it('tracker.setStatus runs the core CLI with --source web and appends to status-log', async () => {
    const res = await post('/api/actions/tracker.setStatus', { params: { row: 2, state: 'Applied' } });
    expect(res.statusCode, res.body).toBe(200);
    const tracker = (await get('/api/tracker')).json();
    expect(tracker.rows.find((r: { num: number }) => r.num === 2).status).toBe('Applied');
    const log = fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'status-log.tsv'), 'utf8').trim().split('\n');
    expect(log.at(-1)).toMatch(/^2\t\d{4}-\d{2}-\d{2}\tEvaluated\tApplied\tweb/);
  });

  it('maps set-status exit codes to HTTP statuses', async () => {
    const missing = await post('/api/actions/tracker.setStatus', { params: { row: 99, state: 'Applied' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().exit).toBe(2);
  });

  it('system.doctor returns the JSON report synchronously', async () => {
    const res = await post('/api/actions/system.doctor', { params: {} });
    expect([200, 500]).toContain(res.statusCode);
    expect(res.json().result).toBeTypeOf('object');
  });

  it('an async action returns a run id, the run finishes and its log is readable', async () => {
    const res = await post('/api/actions/pipeline.prioritize', { params: {} });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    const meta = await waitForRun(runId);
    expect(meta).toMatchObject({ actionId: 'pipeline.prioritize', status: 'done', exitCode: 0 });
    const detail = (await get(`/api/runs/${runId}`)).json();
    expect(Array.isArray(detail.lines)).toBe(true);
    const list = (await get('/api/runs')).json();
    expect(list.map((r: { id: string }) => r.id)).toContain(runId);
    expect((await get('/api/runs/does-not-exist')).statusCode).toBe(404);
  });

  it('actions need the write headers like every other mutation', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/actions/system.doctor', headers: t.authed, payload: { params: {} } });
    expect(res.statusCode).toBe(403);
  });
});

describe('docs.prepareApplication (zero-token prefill)', () => {
  const GREENHOUSE = 'https://boards.greenhouse.io/acmerobotics/jobs/12345';

  it('the Apply page request with only a posting URL is refused with a readable reason, never the script usage text', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: 'https://www.builtinaustin.com/job/associate-software-engineer-python-ai/10931484' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).not.toMatch(/Usage:/);
  });

  it('runs the script with --url and --pdf and returns the prefill summary inline', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toContain('Greenhouse');
    expect(res.json().result).toMatch(/resume\s+acme-robotics-cv\.pdf/);
  });

  it('passes a cover letter text file with --cover when one is chosen', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.txt'), 'Dear team, three short words.\n');
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/acme-robotics-cover.txt' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatch(/Cover\s+output\/acme-robotics-cover\.txt \(5 words\)/);
  });

  it('accepts a tailored CV inside an application bundle under output/', async () => {
    const dir = path.join(t.cfg.dataRoot, 'output', '001-acme-robotics-senior-backend-engineer', 'cv', 'tailored', 'v001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cv.pdf'), '%PDF-1.4\n');
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/001-acme-robotics-senior-backend-engineer/cv/tailored/v001/cv.pdf' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatch(/resume\s+cv\.pdf/);
  });

  it('explains that a job-board listing is not an ATS apply link before running anything', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: 'https://www.builtinaustin.com/job/associate-software-engineer-python-ai/10931484', pdf: 'output/acme-robotics-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/Greenhouse, Ashby and Lever/);
    expect(res.json().error).toContain('www.builtinaustin.com');
  });

  it('refuses a CV PDF that does not exist with a readable reason', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/nope.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('The CV PDF output/nope.pdf does not exist. Generate the tailored CV first or choose another PDF.');
  });

  it('refuses a missing cover letter file with a readable reason', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/missing-cover.txt' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe('The cover letter output/missing-cover.txt does not exist. Choose another or leave it out.');
  });

  it.each([
    ['a file outside output/', 'cv.md'],
    ['a parent-directory escape', 'output/../cv.md'],
    ['a non-PDF file', 'output/acme-robotics-cv.html'],
    ['an absolute path', '/etc/hosts.pdf'],
  ])('rejects %s as the CV', async (_label, pdf) => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf } });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('rejects a PDF symlinked from output/ to a file outside it', async () => {
    const outside = path.join(t.cfg.dataRoot, 'outside.pdf');
    fs.writeFileSync(outside, '%PDF-1.4\n');
    fs.symlinkSync(outside, path.join(t.cfg.dataRoot, 'output', 'linked.pdf'));
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/linked.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/does not exist/);
  });

  it('rejects a cover letter that is not a text file', async () => {
    const res = await post('/api/actions/docs.prepareApplication', { params: { url: GREENHOUSE, pdf: 'output/acme-robotics-cv.pdf', cover: 'output/globex-payments-cv.pdf' } });
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe('Apply documents', () => {
  it('suggests the indexed tailored CV for a tracker row and lists every CV PDF and text cover letter under output/', async () => {
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.txt'), 'Dear team.\n');
    fs.writeFileSync(path.join(t.cfg.dataRoot, 'output', 'acme-robotics-cover.pdf'), '%PDF-1.4\n');
    const res = await get('/api/apply/documents?n=1');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.suggestedPdf).toBe('output/acme-robotics-cv.pdf');
    expect(body.suggestedCover).toBe('output/acme-robotics-cover.txt');
    expect(body.pdfs).toEqual(expect.arrayContaining(['output/acme-robotics-cv.pdf', 'output/acme-robotics-extra.pdf', 'output/globex-payments-cv.pdf']));
    expect(body.pdfs).not.toContain('output/acme-robotics-cover.pdf');
    expect(body.covers).toEqual(['output/acme-robotics-cover.txt']);
  });

  it('suggests nothing for a row without a tailored CV', async () => {
    const body = (await get('/api/apply/documents?n=2')).json();
    expect(body.suggestedPdf).toBeNull();
    expect(body.suggestedCover).toBeNull();
    expect(body.pdfs.length).toBeGreaterThan(0);
  });

  it('suggests nothing without a row and rejects a bad row number', async () => {
    const body = (await get('/api/apply/documents')).json();
    expect(body.suggestedPdf).toBeNull();
    expect(body.pdfs).toContain('output/globex-payments-cv.pdf');
    expect((await get('/api/apply/documents?n=abc')).statusCode).toBe(400);
    expect((await get('/api/apply/documents?n=99')).statusCode).toBe(404);
  });
});
