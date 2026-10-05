// Types for claude-shim.mjs (plain JS so run-daily.sh can put it on PATH without a build step).
export const CLAUDE_SHIM_PATH: string;
export function confinedArgv(argv: string[]): { argv: string[]; reason?: undefined } | { reason: string; argv?: undefined };
