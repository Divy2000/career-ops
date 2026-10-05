// Types for confinement.mjs (plain JS so the daily job's policy pass can import it without a build step).
export const READ_DENY: string[];
export const HOME_READ_DENY: string[];
export function absRule(p: string): string;
export function spellings(p: string): string[];
export function buildReadDenyRules(roots: string[], guardRoot?: string): string[];
export function assertRootsConfinable(codeRoot: string, dataRoot: string, home: string): void;
