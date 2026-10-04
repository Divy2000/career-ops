import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { artifactKindFromName } from '../../server/domains/documents.js';
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
