import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { makePdf } from '../helpers/pdf.js';
import { hasRealPdftotext, installPdftotextStub } from '../helpers/pdftotext-stub.js';
import { extractSourceText } from '../../server/domains/projects.js';

describe('PDF text extraction runs off the event loop and matches intake', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it.skipIf(!hasRealPdftotext())('with the real pdftotext (Poppler; skipped where it is not installed), gives the same text intake.mjs --text gives', async () => {
    const docs = path.join(t.cfg.dataRoot, 'documents', 'projects');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'kites.pdf'), makePdf(['Kite Tracker (2024)', 'Tracked 40 kites with Kafka.']));
    const ours = await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/kites.pdf');
    const intake = execFileSync(process.execPath, [path.join(t.cfg.codeRoot, 'intake.mjs'), '--text', 'projects/kites.pdf'], { env: { ...process.env, CAREER_OPS_ROOT: t.cfg.dataRoot }, encoding: 'utf8' });
    expect(ours).toEqual({ ok: true, rel: 'projects/kites.pdf', text: intake });
  });
});

describe('with a stub pdftotext (runs without Poppler)', () => {
  let t: TestApp;
  let restore: () => void;
  beforeAll(async () => {
    restore = installPdftotextStub().restore;
    t = await makeTestApp();
  });
  afterAll(async () => {
    restore();
    await t.close();
  });

  it('extracts through intake\'s extractor in the worker: the same text intake.mjs --text gives, the text intake --commit fingerprints', async () => {
    const docs = path.join(t.cfg.dataRoot, 'documents', 'projects');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'stub.pdf'), makePdf(['Kite Tracker', 'Tracked 40 kites with Kafka.']));
    const ours = await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/stub.pdf');
    const intake = execFileSync(process.execPath, [path.join(t.cfg.codeRoot, 'intake.mjs'), '--text', 'projects/stub.pdf'], { env: { ...process.env, CAREER_OPS_ROOT: t.cfg.dataRoot }, encoding: 'utf8' });
    expect(intake).toContain('Kite Tracker');
    expect(ours).toEqual({ ok: true, rel: 'projects/stub.pdf', text: intake });
  });
});

describe('a slow extractor does not block other requests', () => {
  let t: TestApp;
  let calls: string;
  const oldPath = process.env.PATH;
  beforeAll(async () => {
    // A pdftotext that answers the version probe at once and takes 1.5 s to extract.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-slow-pdftotext-'));
    calls = path.join(bin, 'calls.log');
    fs.writeFileSync(path.join(bin, 'pdftotext'), `#!/bin/sh\necho "$1" >> '${calls}'\nif [ "$1" = "-v" ]; then echo "pdftotext version 0"; exit 0; fi\nsleep 1.5\necho "Slow Kite"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    t = await makeTestApp();
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    await t.close();
  });

  it('answers a concurrent request while an upload is being extracted', async () => {
    const started = Date.now();
    const upload = t.app.inject({ method: 'POST', url: '/api/projects/upload?name=slow.pdf', headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: makePdf(['x']) });
    // Let the upload handler reach the extractor before the second request is made.
    await new Promise((r) => setTimeout(r, 200));
    const list = await t.app.inject({ method: 'GET', url: '/api/projects', headers: t.authed });
    const listDone = Date.now() - started;
    const res = await upload;
    const uploadDone = Date.now() - started;
    expect(list.statusCode).toBe(200);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().chars).toBe('Slow Kite\n'.length);
    expect(uploadDone).toBeGreaterThanOrEqual(1500);
    expect(listDone).toBeLessThan(1000);
  });

  it('probes for the extractor once and reuses it for later extractions', async () => {
    const vCalls = () => fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === '-v').length;
    const before = vCalls();
    const res = await t.app.inject({ method: 'POST', url: '/api/projects/upload?name=again.pdf', headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: makePdf(['y']) });
    expect(res.statusCode, res.body).toBe(200);
    expect(vCalls()).toBe(before);
    expect(fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === '-layout').length).toBe(2);
  });
});

describe('a source must really live under documents/', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses a symlink that leads outside documents/, wherever a source path is accepted', async () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outside-')), 'config');
    fs.writeFileSync(outside, 'Host secret\n  IdentityFile ~/.ssh/id_ed25519\n');
    const docs = path.join(t.cfg.dataRoot, 'documents', 'projects');
    fs.mkdirSync(docs, { recursive: true });
    fs.symlinkSync(outside, path.join(docs, 'notes.txt'));
    expect(await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/notes.txt')).toEqual({ ok: false, error: 'not a file under documents/: projects/notes.txt' });
    const convert = await t.app.inject({ method: 'POST', url: '/api/projects/convert', headers: t.authedWrite, payload: { format: 'markdown', text: '## A\n- b.\n', source: 'projects/notes.txt' } });
    expect(convert.statusCode).toBe(400);
    const session = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'projects-ingest', target: { type: 'text', value: 'projects/notes.txt' }, prompt: 'Extract.' } });
    expect(session.statusCode).toBe(422);
    expect(session.body).not.toContain('IdentityFile');
  });

  it('accepts a symlink that stays inside documents/ and names the source by its real path', async () => {
    const docs = path.join(t.cfg.dataRoot, 'documents');
    fs.mkdirSync(path.join(docs, 'cv'), { recursive: true });
    fs.mkdirSync(path.join(docs, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'cv', 'projects.md'), '## Kite Tracker\n- Tracked kites.\n');
    fs.symlinkSync(path.join(docs, 'cv', 'projects.md'), path.join(docs, 'projects', 'linked.md'));
    expect(await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/linked.md')).toEqual({ ok: true, rel: 'cv/projects.md', text: '## Kite Tracker\n- Tracked kites.\n' });
  });

  it('refuses a source swapped for a symlink, or moved under a swapped folder, after the containment check', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'race.md'), 'SECRET outside documents\n');
    const docs = path.join(t.cfg.dataRoot, 'documents');
    const projects = path.join(docs, 'projects');
    fs.mkdirSync(projects, { recursive: true });

    fs.writeFileSync(path.join(projects, 'race.md'), '## Fine\n- Inside.\n');
    const fileSwap = await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/race.md', {
      beforeOpen: () => {
        fs.rmSync(path.join(projects, 'race.md'));
        fs.symlinkSync(path.join(outsideDir, 'race.md'), path.join(projects, 'race.md'));
      },
    });
    expect(fileSwap.ok).toBe(false);
    expect(JSON.stringify(fileSwap)).not.toContain('SECRET');

    fs.rmSync(projects, { recursive: true, force: true });
    fs.mkdirSync(projects);
    fs.writeFileSync(path.join(projects, 'race.md'), '## Fine\n- Inside.\n');
    const dirSwap = await extractSourceText(t.cfg.codeRoot, t.cfg.dataRoot, 'projects/race.md', {
      beforeOpen: () => {
        fs.rmSync(projects, { recursive: true });
        fs.symlinkSync(outsideDir, projects);
      },
    });
    expect(dirSwap.ok).toBe(false);
    expect(JSON.stringify(dirSwap)).not.toContain('SECRET');
  });
});

