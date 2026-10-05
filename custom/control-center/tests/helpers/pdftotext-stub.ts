import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Whether Poppler's pdftotext is installed (it is optional; CI may not have it). */
export function hasRealPdftotext(): boolean {
  const r = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

/**
 * Puts a stub pdftotext first on PATH: it answers the version probe and, for `pdftotext -layout <file> -`,
 * prints the text that tests/helpers/pdf.ts writes (one `(...) Tj` per line), then a form feed as Poppler
 * does. A page with no text prints only the form feed. Call restore() to put PATH back.
 */
export function installPdftotextStub(): { bin: string; restore: () => void } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pdftotext-stub-'));
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "-v" ]; then echo "pdftotext version 0 (stub)"; exit 0; fi',
    // $2 is the PDF: keep the string of each "BT ... (text) Tj ET" line and undo pdf.ts's backslash escapes.
    `sed -n 's/^BT [^(]*(\\(.*\\)) Tj ET$/\\1/p' "$2" | sed 's/\\\\\\(.\\)/\\1/g'`,
    "printf '\\f'",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'pdftotext'), script, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${old ?? ''}`;
  return {
    bin,
    restore: () => {
      process.env.PATH = old;
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
}
