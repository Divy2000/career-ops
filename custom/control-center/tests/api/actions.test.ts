import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

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

  it('deletes the input file a sync action wrote (pasted text) once the run returns, success or failure', async () => {
    const tmp = path.join(t.cfg.dataRoot, 'data', 'control-center', 'tmp');
    const left = () => (fs.existsSync(tmp) ? fs.readdirSync(tmp) : []);
    const ok = await post('/api/actions/projects.rank', { params: { text: 'We need Python and Kafka experience.' } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(left()).toEqual([]);
    const library = path.join(t.cfg.dataRoot, 'article-digest.md');
    const before = fs.readFileSync(library, 'utf8');
    fs.writeFileSync(library, '## Empty\nTags: go\n');
    try {
      const failing = await post('/api/actions/projects.rank', { params: { text: 'Python.' } });
      expect(failing.statusCode).toBe(422);
      expect(left()).toEqual([]);
    } finally {
      fs.writeFileSync(library, before);
    }
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

describe('docs.prepareApplication when the script itself fails', () => {
  // Only the prefill script is replaced; every other child process runs for real.
  const failing = (stderr: string, code = 1): Exec => (cmd, args, opts) => (args[0]?.endsWith('prepare-application.mjs') ? Promise.resolve({ code, stdout: '', stderr }) : execNoShell(cmd, args, opts));
  const prefill = async (exec: Exec) => {
    const app = await makeTestApp({}, { exec });
    try {
      return await app.app.inject({ method: 'POST', url: '/api/actions/docs.prepareApplication', headers: app.authedWrite, payload: { params: { url: 'https://boards.greenhouse.io/acme/jobs/1', pdf: 'output/acme-robotics-cv.pdf' } } });
    } finally {
      await app.close();
    }
  };

  it('turns the script error lines into a readable 422', async () => {
    const res = await prefill(failing('Error: URL not recognized as Greenhouse, Ashby, or Lever.\n  URL: https://boards.greenhouse.io/acme/jobs/1\n'));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe('Prefill could not run: URL not recognized as Greenhouse, Ashby, or Lever.');
    expect(res.json().stderr).toBeUndefined();
  });

  it('still says what happened when the script fails without an error line', async () => {
    const res = await prefill(failing('TypeError: boom\n    at main (prepare-application.mjs:9:1)\n', 2));
    expect(res.statusCode, res.body).toBe(502);
    expect(res.json().error).toBe('Prefill failed: prepare-application.mjs exited 2 (last output: at main (prepare-application.mjs:9:1)).');
  });
});

describe('Apply documents classification and suggestion', () => {
  let a: TestApp;
  beforeAll(async () => {
    a = await makeTestApp();
  });
  afterAll(async () => {
    await a.close();
  });
  const out = (rel: string) => {
    const file = path.join(a.cfg.dataRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '%PDF-1.4\n');
  };
  const docs = async (n?: number) => (await a.app.inject({ method: 'GET', url: `/api/apply/documents${n ? `?n=${n}` : ''}`, headers: a.authed })).json();

  it('keeps a CV whose company or role merely contains the word cover, and one the PDF manifest marks cv', async () => {
    out('output/cv-jane-cover-genius-2026-10-04.pdf');
    out('output/cover-genius-staff-engineer-2026-10-04.pdf');
    out('output/cv-jane-cover-genius-2026-10-04.md');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '4\toutput/cover-genius-staff-engineer-2026-10-04.pdf\t\tletter\t2026-10-04\tcv\n');
    const body = await docs();
    expect(body.pdfs).toContain('output/cv-jane-cover-genius-2026-10-04.pdf');
    expect(body.pdfs).toContain('output/cover-genius-staff-engineer-2026-10-04.pdf');
    expect(body.covers).not.toContain('output/cv-jane-cover-genius-2026-10-04.md');
  });

  it('drops cover letters named the way the cover flow names them, or marked cover in the PDF manifest', async () => {
    out('output/globex-payments-staff-software-engineer-cover.pdf');
    out('output/cover_globex.pdf');
    out('output/globex-letter.pdf');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '3\toutput/globex-letter.pdf\t\tletter\t2026-09-26\tcover\n');
    const body = await docs();
    expect(body.pdfs).not.toContain('output/globex-payments-staff-software-engineer-cover.pdf');
    expect(body.pdfs).not.toContain('output/cover_globex.pdf');
    expect(body.pdfs).not.toContain('output/globex-letter.pdf');
  });

  it('suggests the CV indexed under the row report number, not under the tracker row number', async () => {
    const tracker = path.join(a.cfg.dataRoot, 'data', 'applications.md');
    fs.appendFileSync(tracker, '| 9 | 2026-10-01 | Acme Robotics | - | Platform Engineer | 4.0/5 | Evaluated | ✅ | [1](../reports/001-acme-robotics.md) | second role |\n');
    fs.appendFileSync(path.join(a.cfg.dataRoot, 'data', 'pdf-index.tsv'), '9\toutput/globex-payments-cv.pdf\t\tletter\t2026-10-01\tcv\n');
    expect((await docs(9)).suggestedPdf).toBe('output/acme-robotics-cv.pdf');
  });

  it('suggests the newest tailored CV in the report application bundle when the manifest has none', async () => {
    out('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v002/cv.pdf');
    out('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v010/cv.pdf');
    out('output/006-vandelay-systems-senior-python-engineer/cv/source/original.pdf');
    expect((await docs(6)).suggestedPdf).toBe('output/006-vandelay-systems-senior-python-engineer/cv/tailored/v010/cv.pdf');
  });
});

describe('stale action inputs', () => {
  it('are swept at startup: input files and CV uploads older than a day go, newer ones stay', async () => {
    const dataRoot = copyFixtureRoot();
    const dir = (name: string) => path.join(dataRoot, 'data', 'control-center', name);
    const files = { oldInput: path.join(dir('tmp'), 'old.txt'), newInput: path.join(dir('tmp'), 'new.txt'), oldUpload: path.join(dir('uploads'), '1-cv.pdf') };
    for (const f of Object.values(files)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
    }
    const past = new Date(Date.now() - 2 * 24 * 3_600_000);
    for (const f of [files.oldInput, files.oldUpload]) fs.utimesSync(f, past, past);
    const app = await makeTestApp({ dataRoot });
    try {
      expect(Object.values(files).map((f) => fs.existsSync(f))).toEqual([false, true, false]);
    } finally {
      await app.close();
    }
  });
});
