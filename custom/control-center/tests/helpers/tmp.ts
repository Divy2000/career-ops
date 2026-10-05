// Temp dirs for the vitest suites. tempDir() tracks every dir it makes; tests/setup-tmp.ts removes them
// after each test file (removeTempDirs), so a run leaves nothing in TMPDIR. The global setup
// (tests/global-setup.ts) checks that.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
