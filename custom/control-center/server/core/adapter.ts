// The only module that knows core script names, paths and export names.
// Everything is driven by contract.json, which the contract test verifies
// against the installed checkout on every run.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from './contract.json' with { type: 'json' };

export interface CliContract {
  id: string;
  script: string;
  helpArgs: string[];
  expectExit: number | null;
  flags: string[];
  exitCodes?: Record<string, number>;
  /** false: existence-only in the contract test (help run is not side-effect free). */
  probe?: boolean;
}

export interface ExportContract {
  module: string;
  names: string[];
}

export type CliId = (typeof contract.clis)[number]['id'];
export type CoreModule = (typeof contract.exports)[number]['module'];

export const CONTRACT = contract;

export function cliContract(id: CliId): CliContract {
  const entry = contract.clis.find((c) => c.id === id);
  if (!entry) throw new Error(`no CLI contract for ${id}`);
  return entry as CliContract;
}

/** Absolute path of a core script for spawn(); never a shell string. */
export function cliScriptPath(codeRoot: string, id: CliId): string {
  return path.join(codeRoot, cliContract(id).script);
}

export function cliExitCodes(id: CliId): Record<string, number> {
  return cliContract(id).exitCodes ?? { ok: 0 };
}

const moduleCache = new Map<string, { mtime: number; promise: Promise<Record<string, unknown>> }>();
const attempted = new Set<string>();
let reloads = 0;

/** Dynamic import of a pure core module listed in the contract (no writers). */
/** Absolute path of a contracted core module, for code that must load it outside this process (a worker thread). */
export function coreModulePath(codeRoot: string, module: CoreModule): string {
  if (!contract.exports.some((e) => e.module === module)) throw new Error(`${module} is not a contracted core module`);
  return path.join(codeRoot, module);
}

export function importCore<T extends object>(codeRoot: string, module: CoreModule): Promise<T> {
  if (!contract.exports.some((e) => e.module === module)) {
    return Promise.reject(new Error(`${module} is not a contracted core module`));
  }
  const key = `${codeRoot}::${module}`;
  const file = path.join(codeRoot, module);
  // Keyed by mtime too: Dev Chat or the weekly sync may edit a module (custom/projects/lib.mjs) while the
  // server runs, and the API must not keep answering from the old copy. The query string makes Node load it anew.
  const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? -1;
  const cached = moduleCache.get(key);
  if (cached && cached.mtime === mtime) return cached.promise as Promise<T>;
  const url = pathToFileURL(file);
  // Node keeps a URL's first result, a failure included, so every load after the first gets a fresh URL.
  if (attempted.has(key)) url.search = `v=${++reloads}`;
  attempted.add(key);
  const promise = import(url.href) as Promise<Record<string, unknown>>;
  moduleCache.set(key, { mtime, promise });
  // A failed import (a file mid-write during a sync) is not remembered, so the next call tries again.
  promise.catch(() => {
    if (moduleCache.get(key)?.promise === promise) moduleCache.delete(key);
  });
  return promise as Promise<T>;
}
