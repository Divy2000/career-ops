import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { childEnv } from '../../server/system/child-env.js';
import { LOCAL_FILE_GUARD_PATH } from '../../server/claude/confinement.mjs';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const CODE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GUARD_FLAG = `--import=${pathToFileURL(LOCAL_FILE_GUARD_PATH).href}`;
const SECRET = 'R23-CHILD-SECRET-9b2e41';
const noPdftotext = Boolean(spawnSync('pdftotext', ['-v']).error);

describe('local file guard for rendered HTML', () => {
  it('every child the app starts preloads the guard, after any NODE_OPTIONS of its own and only once', () => {
    expect(childEnv({}, { PATH: '/bin' }).NODE_OPTIONS).toBe(GUARD_FLAG);
    expect(childEnv({}, { PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS).toBe(`--max-old-space-size=4096 ${GUARD_FLAG}`);
    expect(childEnv({ NODE_OPTIONS: '--import=/tmp/stub.mjs' }, { PATH: '/bin' }).NODE_OPTIONS).toBe(`--import=/tmp/stub.mjs ${GUARD_FLAG}`);
    expect(childEnv({}, { PATH: '/bin', NODE_OPTIONS: GUARD_FLAG }).NODE_OPTIONS).toBe(GUARD_FLAG);
  });

  const framingPage = (root: string) => {
    const secret = path.join(root, 'id_rsa');
    fs.writeFileSync(secret, `${SECRET}\n`);
    const url = pathToFileURL(secret).href;
    const html = path.join(root, 'output', 'x.html');
    fs.writeFileSync(html, `<!DOCTYPE html><html lang="en"><body><h1>Visible Candidate</h1><iframe src="${url}"></iframe><object data="${url}" type="text/plain"></object><embed src="${url}" type="text/plain"></body></html>`);
    return html;
  };

  it('a script importing a Playwright subpath gets the guarded BrowserType too', () => {
    const probe = "const pw = await import('playwright/test'); process.stdout.write(String(Boolean(Object.getPrototypeOf(pw.chromium)[Symbol.for('career-ops.local-file-guard')])));";
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(LOCAL_FILE_GUARD_PATH).href, '--input-type=module', '-e', probe], { cwd: CODE_ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(r.stdout, r.stderr).toBe('true');
  });

  // The review of R23-claude-L3-01: the root package allows Node 18.17, which has no module.registerHooks.
  it('on a Node without module.registerHooks, a render still runs and still loads no other local file', () => {
    const root = fs.realpathSync(tempDir('cc-local-file-old-'));
    fs.mkdirSync(path.join(root, 'output'));
    const html = framingPage(root);
    const pdf = path.join(root, 'output', 'x.pdf');
    const noHooks = `data:text/javascript,${encodeURIComponent("import m from 'node:module'; delete m.registerHooks; m.syncBuiltinESMExports();")}`;
    const r = spawnSync(process.execPath, ['--import', noHooks, '--import', pathToFileURL(LOCAL_FILE_GUARD_PATH).href, path.join(CODE_ROOT, 'generate-pdf.mjs'), html, pdf, '--skip-fact-check', '--format=letter'], {
      cwd: CODE_ROOT, env: { ...childEnv({ CAREER_OPS_ROOT: root }), NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toMatch(/local-file-guard: blocked file:\/\/\S*id_rsa/);
    // Reading the PDF's text needs poppler; the blocked-load line above does not.
    if (noPdftotext) return;
    const text = spawnSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }).stdout;
    expect(text).toContain('Visible Candidate');
    expect(text).not.toContain(SECRET);
  }, 150_000);

  // The review trigger: a documents session writes output/x.html framing a local file and runs generate-pdf.mjs on it.
  it('generate-pdf.mjs started with the app\'s child environment prints the page, never a local file it frames or embeds', () => {
    const root = fs.realpathSync(tempDir('cc-local-file-'));
    fs.mkdirSync(path.join(root, 'output'));
    const html = framingPage(root);
    const pdf = path.join(root, 'output', 'x.pdf');
    const r = spawnSync(process.execPath, [path.join(CODE_ROOT, 'generate-pdf.mjs'), html, pdf, '--skip-fact-check', '--format=letter'], {
      cwd: CODE_ROOT, env: childEnv({ CAREER_OPS_ROOT: root }), encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toMatch(/local-file-guard: blocked file:\/\/\S*id_rsa/);
    // Reading the PDF's text needs poppler; the blocked-load line above does not.
    if (noPdftotext) return;
    const text = spawnSync('pdftotext', [pdf, '-'], { encoding: 'utf8' }).stdout;
    expect(text).toContain('Visible Candidate');
    expect(text).not.toContain(SECRET);
  }, 150_000);
});
