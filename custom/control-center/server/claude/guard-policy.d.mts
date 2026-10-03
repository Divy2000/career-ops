// Types for guard-policy.mjs (plain JS so the guard hook runs without a build step).
export interface PathPolicy {
  codeRoot: string;
  dataRoot?: string;
}

export interface BashPolicy extends PathPolicy {
  allow: string[];
  deny: string[];
  bash?: string[][];
}

export function globToRegExp(glob: string): RegExp;
export function matches(rel: string, globs: string[]): boolean;
export function resolveReal(p: string): string;
export function relativeToRoot(codeRoot: string, target: string): string | null;
export function locate(policy: PathPolicy, target: string): { rel: string; abs: string; root: 'code' | 'data' } | null;
export function tokenize(command: string): string[] | null;
export function checkBash(command: string, policy: BashPolicy, cwd?: string): string | null;
export function snapshotKey(sessionDir: string, abs: string): string;
