import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { importCore } from '../../server/core/adapter.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('user files', () => {
  it('reads an allowlisted file with its ETag and distinguishes a missing one', async () => {
    const cv = await t.app.inject({ method: 'GET', url: '/api/files/user/cv', headers: t.authed });
    expect(cv.statusCode).toBe(200);
    expect(cv.json()).toMatchObject({ key: 'cv', path: 'cv.md', kind: 'ok' });
    expect(cv.json().etag).toMatch(/^[0-9a-f]{64}$/);
    const brief = await t.app.inject({ method: 'GET', url: '/api/files/user/briefMd', headers: t.authed });
    expect(brief.json()).toMatchObject({ kind: 'missing', text: '', etag: null });
    expect((await t.app.inject({ method: 'GET', url: '/api/files/user/passwd', headers: t.authed })).statusCode).toBe(404);
  });

  it('writes with a matching If-Match, returns 409 with the current text on a mismatch, and creates missing files without a header', async () => {
    const before = (await t.app.inject({ method: 'GET', url: '/api/files/user/cv', headers: t.authed })).json();
    const stale = await t.app.inject({ method: 'PUT', url: '/api/files/user/cv', headers: { ...t.authedWrite, 'if-match': 'deadbeef' }, payload: { text: '# clobber' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().current.text).toBe(before.text);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'cv.md'), 'utf8')).toBe(before.text);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/files/user/cv', headers: { ...t.authedWrite, 'if-match': before.etag }, payload: { text: '# New CV\n' } });
    expect(ok.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'cv.md'), 'utf8')).toBe('# New CV\n');
    expect((await t.app.inject({ method: 'PUT', url: '/api/files/user/cv', headers: t.authedWrite, payload: { text: 'no header' } })).statusCode).toBe(409);
    const created = await t.app.inject({ method: 'PUT', url: '/api/files/user/briefMd', headers: t.authedWrite, payload: { text: '# Brief\n' } });
    expect(created.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'modes', '_brief.md'), 'utf8')).toBe('# Brief\n');
  });

  it('saves a symlinked cv.md through the link when its target is inside the data root: the target is updated and the link stays', async () => {
    const synced = path.join(t.cfg.dataRoot, 'synced');
    fs.mkdirSync(synced);
    const target = path.join(synced, 'cv.md');
    const link = path.join(t.cfg.dataRoot, 'cv.md');
    fs.renameSync(link, target);
    fs.symlinkSync(target, link);
    const before = (await t.app.inject({ method: 'GET', url: '/api/files/user/cv', headers: t.authed })).json();
    const res = await t.app.inject({ method: 'PUT', url: '/api/files/user/cv', headers: { ...t.authedWrite, 'if-match': before.etag }, payload: { text: '# Synced CV\n' } });
    expect(res.statusCode).toBe(200);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('# Synced CV\n');
  });

  it('accepts a PDF upload into the data root and rejects other types', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/cv/upload?name=My%20CV.pdf', headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4 fake') });
    expect(res.statusCode).toBe(200);
    const saved = res.json().path as string;
    expect(saved.startsWith(path.join(t.cfg.dataRoot, 'data', 'control-center', 'uploads'))).toBe(true);
    expect(saved.endsWith('-My_CV.pdf')).toBe(true);
    expect(fs.readFileSync(saved, 'utf8')).toBe('%PDF-1.4 fake');
    expect((await t.app.inject({ method: 'POST', url: '/api/cv/upload', headers: { ...t.authedWrite, 'content-type': 'text/plain' }, payload: 'nope' })).statusCode).toBe(415);
  });

  it('refuses DOCX and DOC, which the read-only parser session cannot read, with a 415 that says what to do, and stores nothing', async () => {
    const uploads = path.join(t.cfg.dataRoot, 'data', 'control-center', 'uploads');
    const stored = () => (fs.existsSync(uploads) ? fs.readdirSync(uploads) : []);
    const before = stored();
    for (const type of ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword']) {
      const res = await t.app.inject({ method: 'POST', url: '/api/cv/upload?name=cv.docx', headers: { ...t.authedWrite, 'content-type': type }, payload: Buffer.from('PK fake zip') });
      expect(res.statusCode).toBe(415);
      expect(res.json().error).toMatch(/export it to PDF/);
    }
    expect(stored()).toEqual(before);
  });

  it('while an import or project save holds the article-digest.md lock, a Files editor PUT of articleDigest answers 503 busy with retry-after and writes nothing, then saves once it is free (R25-FU-01)', async () => {
    const { acquirePipelineLock } = await importCore<{ acquirePipelineLock: (p: string, o?: { timeoutMs?: number }) => Promise<{ release(): void }> }>(t.cfg.codeRoot, 'pipeline-lock.mjs');
    const file = path.join(t.cfg.dataRoot, 'article-digest.md');
    const before = (await t.app.inject({ method: 'GET', url: '/api/files/user/articleDigest', headers: t.authed })).json();
    const text = before.text;
    const ifMatch = before.etag ?? '*';
    const prior = process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
    process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS = '300';
    const lock = await acquirePipelineLock(file, { timeoutMs: 60_000 });
    let released = false;
    const put = () => t.app.inject({ method: 'PUT', url: '/api/files/user/articleDigest', headers: { ...t.authedWrite, 'if-match': ifMatch }, payload: { text: '# Digest from the editor\n' } });
    try {
      const busy = await put();
      expect(busy.statusCode, busy.body).toBe(503);
      expect(busy.headers['retry-after']).toBe('1');
      expect(busy.json().error).toMatch(/busy.*try again/);
      expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe(text);
      lock.release();
      released = true;
      const free = await put();
      expect(free.statusCode, free.body).toBe(200);
      expect(fs.readFileSync(file, 'utf8')).toBe('# Digest from the editor\n');
    } finally {
      if (!released) lock.release();
      if (prior === undefined) delete process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS;
      else process.env.CAREER_OPS_PIPELINE_LOCK_MAX_WAIT_MS = prior;
    }
  });
});
