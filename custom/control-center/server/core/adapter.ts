// The only module that knows core script names, paths and export names.
// Everything is driven by contract.json, which the contract test verifies
// against the installed checkout on every run.
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

const moduleCache = new Map<string, Promise<Record<string, unknown>>>();

/** Dynamic import of a pure core module listed in the contract (no writers). */
export function importCore<T extends object>(codeRoot: string, module: CoreModule): Promise<T> {
  if (!contract.exports.some((e) => e.module === module)) {
    return Promise.reject(new Error(`${module} is not a contracted core module`));
  }
  const key = `${codeRoot}::${module}`;
  let p = moduleCache.get(key);
  if (!p) {
    p = import(pathToFileURL(path.join(codeRoot, module)).href) as Promise<Record<string, unknown>>;
    moduleCache.set(key, p);
  }
  return p as Promise<T>;
}
