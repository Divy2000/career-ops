/**
 * True when the data root was chosen by CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR, trimmed and non-blank like
 * path-resolver.mjs reads them. A root that came from the .career-ops-data marker (or the checkout) is not pinned
 * into launchd plists: the jobs resolve it themselves at run time. custom/launchd/install.sh applies the same rule.
 */
export function dataRootFromEnv(env: NodeJS.ProcessEnv): boolean {
  return [env.CAREER_OPS_ROOT, env.CAREER_OPS_DATA_DIR].some((v) => (v ?? '').trim() !== '');
}
