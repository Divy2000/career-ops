// Types for confinement.mjs (plain JS so the daily job's policy pass can import it without a build step).
export const READ_DENY: string[];
export const HOME_READ_DENY: string[];
export function absRule(p: string): string;
export function spellings(p: string): string[];
export function buildReadDenyRules(roots: string[], guardRoot?: string): string[];
export function assertRootsConfinable(codeRoot: string, dataRoot: string, home: string): void;
export const GUARD_HOOK_PATH: string;
export const ALWAYS_DENIED_WRITES: string[];
export function shellQuote(s: string): string;
export function guardHookCommand(nodePath?: string, hookPath?: string): string;
export const PRE_TOOL_MATCHER: string;
export const PLAYWRIGHT_TOOL_MATCHER: string;
export const HOOK_TIMEOUT_S: number;
export interface GuardHook {
  type: 'command';
  command: string;
  timeout: number;
}
export function guardHooks(command?: string): { PreToolUse: Array<{ matcher: string; hooks: GuardHook[] }>; PostToolUse: Array<{ matcher: string; hooks: GuardHook[] }> };
export function writeGuardPolicy(dir: string, policy: object): { file: string; sha256: string };
export function parseClaudeVersion(out: string): string | null;
export function contractApprovedVersions(contractFile?: string): string[];
export function claudeVersionGate(bin: string, approved?: string[]): { version: string; identity: string; problem: string | null };
