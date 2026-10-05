import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasRealPdftotext } from '../helpers/pdftotext-stub.js';
import { tempDir } from '../helpers/tmp.js';

const oldPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = oldPath;
});

/** PATH holding only a pdftotext with this body (and /bin for sh). */
function onlyPdftotext(body: string | null): void {
  const bin = tempDir('cc-probe-');
  if (body !== null) fs.writeFileSync(path.join(bin, 'pdftotext'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}/bin`;
}

describe('hasRealPdftotext agrees with intake.mjs probeRan', () => {
  it('counts a pdftotext that runs as installed whatever its exit code (Xpdf exits 99 for -v)', () => {
    onlyPdftotext('exit 99');
    expect(hasRealPdftotext()).toBe(true);
    onlyPdftotext('exit 0');
    expect(hasRealPdftotext()).toBe(true);
  });

  it('counts a missing pdftotext as not installed', () => {
    onlyPdftotext(null);
    expect(hasRealPdftotext()).toBe(false);
  });

  it('gives up on a probe that hangs and counts it as not installed', () => {
    onlyPdftotext('exec sleep 30');
    const started = Date.now();
    expect(hasRealPdftotext(300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
