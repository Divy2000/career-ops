// Temp dirs for the custom/*/tests specs. tempDir() tracks every dir it makes and a file-level after()
// hook removes them all, so a test run leaves nothing in TMPDIR. assertSuiteLeavesNoTemp() is the guard:
// it runs a suite in a child process with a fresh TMPDIR and lists whatever is left there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';

const made = [];
// Registered when the module loads, so it hangs off the file's root, not off whichever test calls tempDir first.
after(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/**
 * The environment for a guard child: `tmp` as TMPDIR, TEMP and TMP (os.tmpdir() reads TEMP or TMP before
 * TMPDIR on Windows), and no NODE_TEST_CONTEXT, which, inherited from this test process, makes the child
 * skip every file.
 */
export function suiteEnv(base, tmp) {
  const { NODE_TEST_CONTEXT: _ctx, ...env } = base;
  return { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
}

/** Runs every *.spec.mjs in `testsDir` except `exclude` with the temp dir pointing at a fresh one; returns the run and what it left behind. */
export function runSuiteInFreshTmp(testsDir, exclude) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-guard-'));
  try {
    const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.mjs') && f !== exclude).map((f) => path.join(testsDir, f));
    const r = spawnSync(process.execPath, ['--test', ...files], { env: suiteEnv(process.env, tmp), encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    if (files.length && !/ℹ tests [1-9]/.test(`${r.stdout}`)) throw new Error(`the suite did not run in the child:\n${r.stdout}\n${r.stderr}`.slice(-4000));
    return { status: r.status, output: `${r.stdout}\n${r.stderr}`, leftovers: fs.readdirSync(tmp).sort() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
