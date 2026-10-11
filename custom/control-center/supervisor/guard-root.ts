// Where the per-turn session policy, the hook settings and the Dev Chat revert
// bookkeeping live: a per-user state directory outside both the code root and
// the data root, so no session's write scope (all of which are globs inside
// those roots) can reach them, and the CLI's own Edit(...) rules deny them even
// if the guard hook were bypassed.
import fs from 'node:fs';
import path from 'node:path';
import { resolveReal } from '../server/claude/guard-policy.mjs';

export function defaultGuardRoot(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'career-ops-control-center');
}

/**
 * An absolute path kept as given; a relative one resolved against the folder the user started from (INIT_CWD, which
 * npm sets), not npm's package cwd, so CC_DATA_ROOT and CC_GUARD_DIR mean the same folder wherever the user launched.
 */
export function resolveFromLaunchDir(raw: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const from = env.INIT_CWD;
  const base = from && path.isAbsolute(from) ? from : process.cwd();
  return path.resolve(base, raw);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** CC_GUARD_DIR or the default, canonicalized; refuses (before creating anything) a location inside either root. */
export function resolveGuardRoot(opts: { env: NodeJS.ProcessEnv; codeRoot: string; dataRoot: string; home: string; platform: NodeJS.Platform }): string {
  const wanted = resolveFromLaunchDir(opts.env.CC_GUARD_DIR?.trim() || defaultGuardRoot(opts.home, opts.platform, opts.env), opts.env);
  const canonical = resolveReal(wanted);
  for (const [label, root] of [
    ['code', opts.codeRoot],
    ['data', opts.dataRoot],
  ] as const) {
    if (isInside(canonical, fs.realpathSync.native(root))) {
      throw new Error(`The Control Center guard directory ${wanted} is inside the ${label} root (${root}), where sessions can write. Set CC_GUARD_DIR to a directory outside both the code root and the data root.`);
    }
  }
  fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  return canonical;
}
