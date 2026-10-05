// Input files the app writes for one action run (pasted job descriptions, recruiter emails, URL lists)
// and CV uploads for the parser session. They hold personal data, so they live under the data root and
// are removed once the run that reads them is over; a sweep at startup removes any a crash left behind.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const tmpInputDir = (dataRoot: string) => path.join(dataRoot, 'data', 'control-center', 'tmp');
export const uploadsDir = (dataRoot: string) => path.join(dataRoot, 'data', 'control-center', 'uploads');

export function writeTmpInput(dataRoot: string, ext: string, content: string): string {
  const dir = tmpInputDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(file, content);
  return file;
}

/** Removes every argument that names a file directly inside the tmp input dir; anything else is left alone. */
export function removeTmpInputs(dataRoot: string, args: readonly string[]): void {
  const dir = tmpInputDir(dataRoot);
  for (const arg of args) {
    if (path.isAbsolute(arg) && path.dirname(path.resolve(arg)) === dir) fs.rmSync(arg, { force: true });
  }
}

/** Removes input files and uploads last modified more than `maxAgeMs` ago. */
export function sweepStaleInputs(dataRoot: string, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of [tmpInputDir(dataRoot), uploadsDir(dataRoot)]) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (st?.isFile() && st.mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }
}
