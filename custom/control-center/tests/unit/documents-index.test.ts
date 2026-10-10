import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { importCore } from '../../server/core/adapter.js';
import { pdfIndexPath, readApplyDocuments, readDocuments, readPdfIndex } from '../../server/domains/documents.js';
import { copyFixtureRoot } from '../helpers/app.js';

const ENV_KEYS = ['CAREER_OPS_TRACKER', 'CAREER_OPS_PDF_INDEX'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('the PDF index is read where generate-pdf.mjs writes it (R12-srv-dom-a-L2-02)', () => {
  it('resolves the same manifest path as tracker-utils.mjs resolvePdfIndexPath(rawTrackerPath(root))', async () => {
    const root = copyFixtureRoot();
    const { resolvePdfIndexPath } = await importCore<{ resolvePdfIndexPath: (tracker: string) => string }>(DEFAULT_CODE_ROOT, 'tracker-utils.mjs');
    const { rawTrackerPath } = await importCore<{ rawTrackerPath: (root: string) => string }>(DEFAULT_CODE_ROOT, 'path-resolver.mjs');
    const cases: Partial<Record<(typeof ENV_KEYS)[number], string>>[] = [
      {},
      { CAREER_OPS_TRACKER: path.join(root, 'ws', 'data', 'applications.md') },
      { CAREER_OPS_TRACKER: path.join(root, 'flat', 'applications.md') },
      { CAREER_OPS_TRACKER: path.join(root, 'ws', 'data', 'applications.md'), CAREER_OPS_PDF_INDEX: path.join(root, 'elsewhere', 'index.tsv') },
    ];
    for (const env of cases) {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, env);
      expect(pdfIndexPath(root), JSON.stringify(env)).toBe(path.resolve(resolvePdfIndexPath(rawTrackerPath(root))));
    }
    for (const k of ENV_KEYS) delete process.env[k];
    fs.rmSync(path.join(root, 'data', 'applications.md'));
    expect(pdfIndexPath(root)).toBe(path.resolve(resolvePdfIndexPath(rawTrackerPath(root))));
  });

  it('lists, suggests and guards with an index named by CAREER_OPS_PDF_INDEX', () => {
    const root = copyFixtureRoot();
    const moved = path.join(root, 'elsewhere', 'pdf-index.tsv');
    write(moved, fs.readFileSync(path.join(root, 'data', 'pdf-index.tsv'), 'utf8'));
    fs.rmSync(path.join(root, 'data', 'pdf-index.tsv'));
    process.env.CAREER_OPS_PDF_INDEX = moved;
    const docs = readDocuments(root, 1, 'Acme Robotics');
    expect(docs.indexPresent).toBe(true);
    expect(docs.files.find((f) => f.path === 'output/acme-robotics-cv.pdf')?.source).toBe('index');
    expect(readPdfIndex(root).map((r) => r.report)).toEqual([1, 3]);
  });

  it('reads the index of a CAREER_OPS_TRACKER workspace, with its rows made relative to the data root', () => {
    const root = copyFixtureRoot();
    process.env.CAREER_OPS_TRACKER = path.join(root, 'ws', 'data', 'applications.md');
    write(path.join(root, 'ws', 'output', 'cv-acme-robotics-v2.pdf'), '%PDF-1.4\n');
    write(path.join(root, 'ws', 'data', 'pdf-index.tsv'), '12\toutput/cv-acme-robotics-v2.pdf\toutput/cv-acme-robotics-v2.html\tletter\t2026-10-01\tcv\n');
    expect(readPdfIndex(root)).toMatchObject([{ report: 12, pdf: 'ws/output/cv-acme-robotics-v2.pdf', html: 'ws/output/cv-acme-robotics-v2.html' }]);
    // The re-render guard sees the row; Documents offers only what /api/files/serve can open (the data root's output/).
    const docs = readDocuments(root, 12, 'Nobody');
    expect(docs.indexPresent).toBe(true);
    expect(docs.files).toEqual([]);
  });

  it('offers an indexed PDF of a flat-layout tracker workspace, which is the data root', () => {
    const root = copyFixtureRoot();
    const index = fs.readFileSync(path.join(root, 'data', 'pdf-index.tsv'), 'utf8');
    fs.rmSync(path.join(root, 'data'), { recursive: true });
    write(path.join(root, 'applications.md'), '# Applications\n');
    write(path.join(root, 'data', 'pdf-index.tsv'), index);
    process.env.CAREER_OPS_TRACKER = path.join(root, 'applications.md');
    expect(readDocuments(root, 1, 'Acme Robotics').files.find((f) => f.path === 'output/acme-robotics-cv.pdf')?.source).toBe('index');
  });
});

describe('index rows whose PDF is gone (R12-srv-dom-a-01)', () => {
  it('are not offered as documents once outcome cleanup removed the PDF', () => {
    const root = copyFixtureRoot();
    fs.rmSync(path.join(root, 'output', 'acme-robotics-cv.pdf'));
    const docs = readDocuments(root, 1, 'Acme Robotics');
    expect(docs.files.map((f) => f.path)).not.toContain('output/acme-robotics-cv.pdf');
    fs.mkdirSync(path.join(root, 'output', 'acme-robotics-cv.pdf'));
    expect(readDocuments(root, 1, 'Acme Robotics').files.map((f) => f.path)).not.toContain('output/acme-robotics-cv.pdf');
    expect(readApplyDocuments(root, { report: 1, company: 'Acme Robotics' }).suggestedPdf).not.toBe('output/acme-robotics-cv.pdf');
  });
});
