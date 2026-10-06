/** Removes every CAREER_OPS_* variable from `env` (path-resolver.mjs and scan.mjs put them ahead of the data root) and returns their names. */
export function dropCareerOpsOverrides(env: NodeJS.ProcessEnv): string[] {
  const names = Object.keys(env).filter((k) => k.startsWith('CAREER_OPS_'));
  for (const k of names) delete env[k];
  return names;
}

/** What a Claude session turn sets for its process (manager.ts): its guard hook writes snapshots into CC_TURN_DIR. */
const SESSION_ENV = ['CC_TURN_DIR', 'CC_SESSION_DIR', 'CC_POLICY_FILE', 'CC_POLICY_SHA256', 'CC_MODE'];

/**
 * Removes a session turn's variables from `env` and returns the names it removed: a suite Dev Chat runs inherits them,
 * and a guard hook a test spawns would otherwise snapshot into that live turn and read its policy.
 */
export function dropSessionEnv(env: NodeJS.ProcessEnv): string[] {
  const names = SESSION_ENV.filter((k) => k in env);
  for (const k of names) delete env[k];
  return names;
}
