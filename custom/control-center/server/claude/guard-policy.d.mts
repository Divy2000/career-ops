// Types for guard-policy.mjs (plain JS so the guard hook runs without a build step).
export interface PathPolicy {
  codeRoot: string;
  dataRoot?: string;
}

export interface ReadPolicy extends PathPolicy {
  /** Secret-file globs no read may reach; a policy without the list refuses every read. */
  readDeny?: string[];
  /** Roots readable but never writable (the session's own oversized tool results). */
  readOnlyRoots?: string[];
  /** Glob and Grep are granted. */
  search?: boolean;
}

export interface BashPolicy extends PathPolicy {
  allow: string[];
  deny: string[];
  readDeny?: string[];
  bash?: string[][];
}

export type DnsLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export function globToRegExp(glob: string): RegExp;
export function matches(rel: string, globs: string[]): boolean;
export function resolveReal(p: string): string;
export function relativeToRoot(codeRoot: string, target: string): string | null;
export function locate(policy: PathPolicy, target: string): { rel: string; abs: string; root: 'code' | 'data' } | null;
export function locateRead(policy: ReadPolicy, target: string): { rel: string; abs: string; root: 'code' | 'data' | 'readonly' } | null;
export function checkRead(policy: ReadPolicy, input: { file_path?: unknown }, cwd?: string, label?: string): string | null;
export function checkSearch(policy: ReadPolicy, tool: string, input: Record<string, unknown>, cwd?: string): string | null;
export function isPublicAddress(ip: string): boolean;
export function checkUrlLiteral(raw: string, label?: string): string | null;
export const DNS_BUDGET_MS: number;
export const MAX_URL_HOSTS: number;
export const MAX_URL_DESTINATIONS: number;
export function checkFetchUrls(urls: string[], lookup?: DnsLookup, opts?: { label?: string; budgetMs?: number; timeoutMs?: number; maxHosts?: number }): Promise<string | null>;
export function checkFetchUrl(raw: string, lookup?: DnsLookup, opts?: { label?: string; budgetMs?: number; timeoutMs?: number; maxHosts?: number }): Promise<string | null>;
export function httpUrlsIn(command: string): string[];
export const URL_LIST_MAX_BYTES: number;
export function urlListFilesIn(command: string): Array<{ file: string; format: 'lines' | 'text' }>;
export function readUrlList(policy: ReadPolicy, file: string, cwd: string | undefined, format: 'lines' | 'text', label?: string): { urls: string[]; reason?: undefined } | { reason: string; urls?: undefined };
export function tokenize(command: string): string[] | null;
/** Scripts no session may run, whatever its policy lists: they start agent CLIs outside the session guard. */
export const AGENT_SPAWNING_SCRIPTS: readonly string[];
/** Scripts modelled on their own parsers because their arguments choose files they write. */
export const WRITER_SCRIPT_NAMES: readonly string[];
export function checkBash(command: string, policy: BashPolicy, cwd?: string): string | null;
export function snapshotKey(sessionDir: string, abs: string): string;
