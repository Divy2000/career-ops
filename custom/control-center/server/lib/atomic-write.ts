import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveReal } from '../claude/guard-policy.mjs';
import { inside } from './paths.js';

/** A write refused because the path leads outside the roots it may write in (a symlink to /tmp, say). Fastify answers 403. */
export class OutsideRootsError extends Error {
  readonly statusCode = 403;
}

const UNRESOLVABLE: Record<string, string> = { ELOOP: 'too many symbolic links, likely a loop', ENAMETOOLONG: 'the path is too long' };

/**
 * A 403 OutsideRootsError for a path whose target cannot be worked out (a symlink loop, a name too long), or null for
 * any other error. Such a path cannot be shown to stay inside the roots, so it is refused like one that leaves them.
 */
export function unresolvablePath(shown: string, err: unknown): OutsideRootsError | null {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (!code || !(code in UNRESOLVABLE)) return null;
  return new OutsideRootsError(`cannot tell where ${shown} leads (${code}: ${UNRESOLVABLE[code]}); nothing was read or written`);
}

/**
 * The real path `abs` writes to: symlinks followed in every component, a dangling final link included. Each hop
 * first resolves the folder the name sits in, so a relative link is read against its real folder, not the linked
 * path it was reached by (modes -> /tmp/out holding _profile.md -> ../secret.md is /tmp/secret.md).
 */
function realTarget(abs: string): string {
  let p = path.resolve(abs);
  for (let hops = 0; hops < 40; hops++) {
    p = path.join(resolveReal(path.dirname(p)), path.basename(p));
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st?.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
  throw Object.assign(new Error(`${abs}: too many levels of symbolic links`), { code: 'ELOOP' });
}

/**
 * Replaces the file at `abs` atomically: a temp file next to it, then one rename. The real path (symlinks followed,
 * a cv.md linked to a synced copy included) must stay inside one of the `within` roots, or the write is refused
 * with OutsideRootsError and nothing changes, neither the link nor its target. Inside, the temp file goes next to
 * the real target, which is replaced and keeps its mode, so a link stays a link.
 */
export function writeFileAtomic(abs: string, text: string, opts: { within: Array<{ root: string; name: string }> }): void {
  const shown = path.relative(path.resolve(opts.within[0]!.root), path.resolve(abs)) || abs;
  let real: string;
  try {
    real = realTarget(abs);
  } catch (err) {
    throw unresolvablePath(shown, err) ?? err;
  }
  const roots = opts.within.map((w) => ({ ...w, real: resolveReal(path.resolve(w.root)) }));
  const home = roots.find((r) => inside(r.real, real));
  if (!home) {
    const name = roots.map((r) => r.name).join(' and ');
    throw new OutsideRootsError(`${shown} leads to ${real}, outside the ${name}; nothing was written. Point the link inside the ${name}, or replace it with the file itself.`);
  }
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

/** The roots a user-layer file may be written in: the data root only. */
export const dataRootOnly = (dataRoot: string) => ({ within: [{ root: dataRoot, name: 'data root' }] });
