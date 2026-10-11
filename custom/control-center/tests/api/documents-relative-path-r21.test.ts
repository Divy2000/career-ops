import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, testConfig, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

/**
 * generate-pdf.mjs runs with the code root as its cwd, so a relative CAREER_OPS_TRACKER or CAREER_OPS_PDF_INDEX names a
 * file under the code root. The server's own cwd (custom/control-center) is a different folder, so the Documents and
 * Apply tabs resolving against it look for a pdf-index.tsv the scripts never write.
 */
describe('relative CAREER_OPS_TRACKER and CAREER_OPS_PDF_INDEX are read from the code root (FU-docs-rel-01)', () => {
  const KEYS = ['CAREER_OPS_TRACKER', 'CAREER_OPS_PDF_INDEX'] as const;
  let saved: Record<string, string | undefined>;
  let t: TestApp | null = null;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(async () => {
    await t?.close();
    t = null;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const start = async (env: (cfg: ReturnType<typeof testConfig>) => Partial<Record<(typeof KEYS)[number], string>>) => {
    const cfg = testConfig();
    expect(path.resolve(cfg.codeRoot)).not.toBe(process.cwd());
    Object.assign(process.env, env(cfg));
    t = await makeTestApp(cfg);
    return t;
  };
  const get = (app: TestApp, url: string) => app.app.inject({ method: 'GET', url, headers: app.authed });
  const rerender = (app: TestApp, params: Record<string, unknown>) =>
    app.app.inject({ method: 'POST', url: '/api/actions/docs.renderPdf', headers: app.authedWrite, payload: { params: { row: 1, report: 1, format: 'letter', ...params } } });

  it('Documents, Apply and the re-render guard read a CAREER_OPS_PDF_INDEX given relative to the code root', async () => {
    const app = await start((cfg) => {
      const moved = path.join(tempDir('cc-pdf-index-relative-'), 'pdf-index.tsv');
      const index = path.join(cfg.dataRoot, 'data', 'pdf-index.tsv');
      fs.writeFileSync(moved, `${fs.readFileSync(index, 'utf8')}99\toutput/acme-robotics-extra.pdf\t\tletter\t2026-10-02\tcv\n`);
      fs.rmSync(index);
      return { CAREER_OPS_PDF_INDEX: path.relative(cfg.codeRoot, moved) };
    });
    const docs = (await get(app, '/api/tracker/1/documents')).json();
    expect(docs.indexPresent).toBe(true);
    expect(docs.files.find((f: { path: string }) => f.path === 'output/acme-robotics-cv.pdf')?.source).toBe('index');
    expect((await get(app, '/api/apply/documents?n=3')).json().suggestedPdf).toBe('output/globex-payments-cv.pdf');
    const res = await rerender(app, { html: 'output/acme-robotics-cv.html', pdf: 'output/acme-robotics-extra.pdf' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/belongs to report 99/);
  });

  it('Documents reads the index of a CAREER_OPS_TRACKER workspace given relative to the code root', async () => {
    const app = await start((cfg) => ({ CAREER_OPS_TRACKER: path.relative(cfg.codeRoot, path.join(cfg.dataRoot, 'data', 'applications.md')) }));
    const docs = (await get(app, '/api/tracker/1/documents')).json();
    expect(docs.indexPresent).toBe(true);
    expect(docs.files.find((f: { path: string }) => f.path === 'output/acme-robotics-cv.pdf')?.source).toBe('index');
  });
});
