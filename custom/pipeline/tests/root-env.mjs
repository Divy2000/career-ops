// The environment for a script under test: the caller's, minus every CAREER_OPS_* override (path-resolver.mjs and
// scan.mjs put CAREER_OPS_TRACKER, _PIPELINE, _PORTALS and the rest ahead of the data root), with `root` as the data root.
export function rootEnv(root, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CAREER_OPS_')));
  return { ...env, CAREER_OPS_ROOT: root, NO_COLOR: '1', ...extra };
}
