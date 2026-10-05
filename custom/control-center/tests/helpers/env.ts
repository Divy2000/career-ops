/** Removes every CAREER_OPS_* variable from `env` (path-resolver.mjs and scan.mjs put them ahead of the data root) and returns their names. */
export function dropCareerOpsOverrides(env: NodeJS.ProcessEnv): string[] {
  const names = Object.keys(env).filter((k) => k.startsWith('CAREER_OPS_'));
  for (const k of names) delete env[k];
  return names;
}
