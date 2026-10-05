// The vitest twin of custom/test-support/tmp.mjs's runSuiteInFreshTmp: the run gets a fresh TMPDIR
// (TEMP and TMP too, which os.tmpdir() reads first on Windows) and fails if anything is left there.
import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

export function startTmpGuard(env: NodeJS.ProcessEnv, base: string): { dir: string; finish: () => void } {
  const dir = fs.mkdtempSync(path.join(base, 'cc-vitest-'));
  const saved = KEYS.map((k) => [k, env[k]] as const);
  for (const k of KEYS) env[k] = dir;
  return {
    dir,
    finish: () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      const left = fs.readdirSync(dir).sort();
      fs.rmSync(dir, { recursive: true, force: true });
      if (left.length) throw new Error(`the test run left ${left.length} entries in TMPDIR: ${left.join(', ')}`);
    },
  };
}
