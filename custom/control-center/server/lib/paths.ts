import path from 'node:path';

/** True when `p` is a strict descendant of `root`; `root + sep` is not used as a prefix because that breaks for the filesystem root. */
export function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
