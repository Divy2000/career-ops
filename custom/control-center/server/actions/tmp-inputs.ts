// Input files the app writes for one action run (pasted job descriptions, recruiter emails, URL lists)
// and CV uploads for the parser session. They hold personal data, so they live under the data root. An
// input file is removed once its run is over; a CV upload once the last session that names it is deleted
// (any of them may read it again). A sweep at startup removes either kind left behind for over a day.
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

/** Removes every path that names a file directly inside the tmp input dir (arguments or recorded inputs); anything else is left alone. */
export function removeTmpInputs(dataRoot: string, paths: readonly string[]): void {
  const dir = tmpInputDir(dataRoot);
  for (const p of paths) {
    if (path.isAbsolute(p) && path.dirname(path.resolve(p)) === dir) fs.rmSync(p, { force: true });
  }
}

export type UploadTarget = { kind: 'other' } | { kind: 'upload'; path: string } | { kind: 'refused'; reason: string };

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/**
 * What a session's text target is to the uploads folder. An entry directly inside it, however spelled (./, //, another
 * case on a case-insensitive disk, a linked data root), is an upload in one canonical form: its real path in the
 * disk's own case, so every session naming it compares equal. A path spelled into the folder that does not resolve to
 * an entry there (missing, or a link out of it) is refused. Anything else is not an upload.
 */
export function uploadTarget(dataRoot: string, p: string): UploadTarget {
  if (!path.isAbsolute(p)) return { kind: 'other' };
  const dir = uploadsDir(dataRoot);
  const realDir = realOrNull(dir);
  const real = realOrNull(p);
  if (real && realDir && path.dirname(real) === realDir) return { kind: 'upload', path: real };
  const spelledDir = path.dirname(path.resolve(p));
  if (spelledDir === dir || (realDir !== null && spelledDir === realDir)) {
    return { kind: 'refused', reason: `${p} is in the uploads folder but does not resolve to an upload there (missing, or a link out of it); upload the CV again` };
  }
  return { kind: 'other' };
}

/** Removes the upload `p` names when it is a regular file in the uploads folder; a folder, a link or anything else is left alone. */
export function removeUpload(dataRoot: string, p: string): void {
  const target = uploadTarget(dataRoot, p);
  if (target.kind !== 'upload') return;
  if (fs.lstatSync(target.path, { throwIfNoEntry: false })?.isFile()) fs.rmSync(target.path, { force: true });
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
