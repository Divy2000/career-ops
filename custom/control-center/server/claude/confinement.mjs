// Read confinement shared by the session invocation builder (invocation.ts, modes.ts) and the daily job's headless
// policy pass (custom/immigration/run-daily.sh), which runs outside the app. Plain .mjs with no dependencies, so
// that script can import it with nothing but node. Dev Chat cannot edit it (server/claude/** is protected).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret files no session may read, relative to each root and matched case-insensitively (an over-deny on
 * case-sensitive volumes, by design). Enforced as Read deny rules in the per-turn settings file (under each
 * root's given and real path) and by the guard hook. File-name based: a secret under another name is readable.
 */
export const READ_DENY = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/*.ppk',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.git-credentials',
  '**/.git/config',
  '**/credentials*.json',
  '**/client_secret*.json',
  '**/service-account*.json',
  '**/*.token',
];

/** Credential stores in the home directory, denied as Read rules (they are outside every root anyway). */
export const HOME_READ_DENY = [
  '~/.ssh/**',
  '~/.aws/**',
  '~/.gnupg/**',
  '~/.azure/**',
  '~/.kube/**',
  '~/.config/gh/**',
  '~/.config/gcloud/**',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/.claude.json',
  '~/.claude/.credentials.json',
  '~/Library/Keychains/**',
  '~/Library/Cookies/**',
  '~/Library/Safari/**',
  '~/Library/Application Support/Google/Chrome/**',
  '~/Library/Application Support/Firefox/**',
];

/** `//abs/path` permission-rule spelling of an absolute path. */
export function absRule(p) {
  return `//${p.replace(/^\/+/, '')}`;
}

/** A path and its real path when they differ (a root reached through a symlink), so rules hold for either spelling. */
export function spellings(p) {
  let real = p;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    /* not on disk (unit tests): the given spelling only */
  }
  return [...new Set([p, real])];
}

/** Read deny rules: the home credential stores, the guard root when there is one, and READ_DENY under every root. */
export function buildReadDenyRules(roots, guardRoot) {
  const out = HOME_READ_DENY.map((p) => `Read(${p})`);
  if (guardRoot !== undefined) for (const g of spellings(guardRoot)) out.push(`Read(${absRule(g)}/**)`);
  for (const root of [...new Set(roots)]) for (const spelled of spellings(root)) for (const glob of READ_DENY) out.push(`Read(${absRule(spelled)}/${glob})`);
  return [...new Set(out)];
}

/**
 * Refuses roots a session could not be confined to: the filesystem root, the home directory, or a parent of it,
 * compared by real path (the on-disk case on macOS). A root that cannot be resolved is refused too.
 */
export function assertRootsConfinable(codeRoot, dataRoot, home) {
  const real = (label, p) => {
    try {
      return fs.realpathSync.native(p);
    } catch (err) {
      throw new Error(`the ${label} ${p} cannot be resolved (${err.message}); sessions are refused`, { cause: err });
    }
  };
  const homeReal = real('home directory', home);
  for (const [label, p] of [['repo root', codeRoot], ['data root', dataRoot]]) {
    const r = real(label, p);
    if (r === path.parse(r).root) throw new Error(`the ${label} is the filesystem root, so a session could read every file; sessions are refused`);
    const rel = path.relative(r, homeReal);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
      throw new Error(`the ${label} ${r} is or contains your home directory (${homeReal}), so a session could read all of it; sessions are refused. Point CAREER_OPS_ROOT at a dedicated folder.`);
    }
  }
}
