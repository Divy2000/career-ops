import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { artifactKindFromName, rerenderProblem, type PdfIndexRow } from '../../server/domains/documents.js';
import { copyFixtureRoot } from '../helpers/app.js';

const NAMES = [
  'output/cv-jane-cover-genius-2026-10-04.pdf',
  'output/cover-genius-staff-engineer-2026-10-04.pdf',
  'output/globex-payments-staff-software-engineer-cover.pdf',
  'output/cover_globex.pdf',
  'output/cover.pdf',
  'output/acme-robotics-cover.txt',
  'output/acme-recovery-cv.pdf',
  'output/001-acme/cv/tailored/v001/cv.pdf',
  'output/acme_cover.md',
];

describe('artifactKindFromName', () => {
  it('reads a cover letter only from the anchored cover-letter naming', () => {
    expect(NAMES.filter((n) => artifactKindFromName(n) === 'cover')).toEqual([
      'output/cover-genius-staff-engineer-2026-10-04.pdf',
      'output/globex-payments-staff-software-engineer-cover.pdf',
      'output/cover_globex.pdf',
      'output/cover.pdf',
      'output/acme-robotics-cover.txt',
      'output/acme_cover.md',
    ]);
  });

  it('agrees with resolveArtifactKind in generate-pdf.mjs', async () => {
    // Importing the generator creates output/ under the data root, so point it at a throwaway copy.
    process.env.CAREER_OPS_ROOT = copyFixtureRoot();
    const mod = (await import(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'generate-pdf.mjs')).href)) as { resolveArtifactKind: (explicit: undefined, file: string) => { kind: string } };
    for (const n of NAMES) expect(artifactKindFromName(n), n).toBe(mod.resolveArtifactKind(undefined, n).kind);
  });
});

describe('rerenderProblem', () => {
  const row = (report: number, pdf: string, html = ''): PdfIndexRow => ({ report, pdf, html, format: 'letter', date: '2026-10-01', kind: 'cv' });
  const index = [row(1, 'output/acme-cv.pdf', 'output/acme-cv.html'), row(99, 'output/acme-platform-cv.pdf', 'output/acme-platform-cv.html'), row(1, 'output/shared.pdf')];
  // generate-pdf.mjs keeps one row per PDF path (applyManifestRow), so the index never files a PDF under two reports.

  it('allows a pair the PDF index files under the same report', () => {
    expect(rerenderProblem(index, 1, 'output/acme-cv.html', 'output/acme-cv.pdf')).toBeNull();
    expect(rerenderProblem(index, 1, 'output/shared.html', 'output/shared.pdf')).toBeNull();
  });

  it('allows a pair in the report own application folder', () => {
    expect(rerenderProblem(index, 1, 'output/001-acme-robotics-backend/cv/tailored/v002/cv.html', 'output/001-acme-robotics-backend/cv/tailored/v002/cv.pdf')).toBeNull();
  });

  it('allows a pair no report claims', () => {
    expect(rerenderProblem(index, 1, 'output/acme-new.html', 'output/acme-new.pdf')).toBeNull();
  });

  it('refuses a PDF or HTML the index files under another report', () => {
    const msg = 'output/acme-platform-cv.pdf belongs to report 99, so re-rendering it here would file it under report 1. Re-render it from that application instead.';
    expect(rerenderProblem(index, 1, 'output/acme-platform-cv.html', 'output/acme-platform-cv.pdf')).toBe(msg);
    expect(rerenderProblem(index, 1, 'output/acme-platform-cv.html', 'output/acme-new.pdf')).toBe(msg.replace('output/acme-platform-cv.pdf', 'output/acme-platform-cv.html'));
  });

  it('refuses a pair from another report application folder', () => {
    expect(rerenderProblem(index, 1, 'output/099-acme-robotics-platform/cv/tailored/v001/cv.html', 'output/099-acme-robotics-platform/cv/tailored/v001/cv.pdf')).toBe(
      'output/099-acme-robotics-platform/cv/tailored/v001/cv.pdf belongs to report 99, so re-rendering it here would file it under report 1. Re-render it from that application instead.',
    );
  });
});
