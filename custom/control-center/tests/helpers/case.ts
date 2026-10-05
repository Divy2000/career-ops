import fs from 'node:fs';
import path from 'node:path';

/** Whether the volume holding `dir` folds case: create a probe file and stat its case-flipped name. */
export function foldsCase(dir: string): boolean {
  const probe = path.join(dir, `CaseProbe-${process.pid}`);
  fs.writeFileSync(probe, '');
  try {
    return fs.existsSync(path.join(dir, `caseprobe-${process.pid}`));
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
