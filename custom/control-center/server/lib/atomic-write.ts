import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveReal } from '../claude/guard-policy.mjs';

/**
 * Replaces the file at `abs` atomically: a temp file next to it, then one rename. A symlink is followed
 * (a cv.md linked to a synced copy): the temp file goes next to the link's target, which is replaced and
 * keeps its mode, so the link stays a link.
 */
export function writeFileAtomic(abs: string, text: string): void {
  const real = resolveReal(abs);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  try {
    const mode = fs.statSync(real, { throwIfNoEntry: false })?.mode;
    if (mode !== undefined) fs.chmodSync(tmp, mode & 0o7777);
    fs.renameSync(tmp, real);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
