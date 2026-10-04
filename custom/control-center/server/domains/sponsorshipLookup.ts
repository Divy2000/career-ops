// Backs the Sponsorship > Lookup tab: runs the h1b-sponsor check (argv only, no
// shell) and joins it with what career-ops already saved about the company.
import path from 'node:path';
import { cliScriptPath, importCore } from '../core/adapter.js';
import type { ServerConfig } from '../config.js';
import type { Exec } from '../routes/system.js';
import { parseCompanyFile, type CompanyFile } from './immigration.js';
import { parseTsv, readText } from './files.js';

export const INSTALL_COMMAND = 'node plugins/h1b-sponsor/install-h1b-index.mjs';
const CHECK_TIMEOUT_MS = 20_000;

export interface H1bCheck {
  found: boolean;
  employerId: string | null;
  displayName: string;
  hasSponsorshipHistory: boolean;
  totals: { n_lca: number; n_certified: number | null; n_pwd: number; n_perm: number; first_year: number | null; last_year: number | null; does_gc: boolean };
  redFlags: { staffing_shop: { value: boolean; share: number | null; n_secondary?: number | null; n_total?: number | null } | null };
  friendlinessTier: string;
  source: string | null;
  fetchedAt: string;
}

export type BackendState = 'ok' | 'index_missing' | 'error';

interface Backend<T> {
  state: BackendState;
  data: T | null;
  error: string | null;
  installCommand: string | null;
}

export interface LookupResult {
  query: string;
  state: 'found' | 'not_found' | 'index_missing' | 'error';
  check: H1bCheck | null;
  error: string | null;
  installCommand: string | null;
  /** Output of custom/immigration/freshness.mjs for the saved company file, or its error. */
  freshness: Record<string, unknown> | null;
  companyFile: CompanyFile | null;
  markdown: string | null;
  alerts: Record<string, string>[];
}

export interface SearchHit {
  id: string;
  name: string;
}

export interface SearchResult {
  query: string;
  state: BackendState;
  total: number;
  shown: number;
  results: SearchHit[];
  error: string | null;
  installCommand: string | null;
}

interface Ctx {
  cfg: ServerConfig;
  exec: Exec;
  env: NodeJS.ProcessEnv;
}

/** The check prints its documented envelope with an `error` field on failure, with or without a non-zero exit. */
async function runCheck<T extends { error?: unknown }>(ctx: Ctx, args: string[]): Promise<Backend<T>> {
  const script = ctx.cfg.h1bCheckScript ?? cliScriptPath(ctx.cfg.codeRoot, 'h1bCheck');
  const r = await ctx.exec(process.execPath, [script, ...args], { cwd: ctx.cfg.codeRoot, timeoutMs: CHECK_TIMEOUT_MS, env: ctx.env });
  let parsed: T | null = null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) parsed = v as T;
  } catch {
    /* handled below */
  }
  if (parsed === null) {
    const detail = r.stderr.trim() || r.stdout.trim().slice(0, 200);
    return { state: 'error', data: null, error: `h1b-sponsor check printed non-JSON output${r.code !== 0 ? ` (exit ${r.code})` : ''}${detail ? `: ${detail}` : ''}`, installCommand: null };
  }
  const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : r.code !== 0 ? `h1b-sponsor check exited ${r.code}` : null;
  if (message === null) return { state: 'ok', data: parsed, error: null, installCommand: null };
  const indexMissing = /no local H-1B index/i.test(message);
  return { state: indexMissing ? 'index_missing' : 'error', data: parsed, error: message, installCommand: indexMissing ? INSTALL_COMMAND : null };
}

export async function searchCompanies(ctx: Ctx, query: string): Promise<SearchResult> {
  const r = await runCheck<{ total?: number; shown?: number; results?: SearchHit[]; error?: string }>(ctx, ['--search', query, '--json']);
  const results = r.state === 'ok' && Array.isArray(r.data?.results) ? r.data.results.map((h) => ({ id: String(h.id), name: String(h.name) })) : [];
  return {
    query,
    state: r.state,
    total: r.state === 'ok' ? Number(r.data?.total ?? results.length) : 0,
    shown: results.length,
    results,
    error: r.error,
    installCommand: r.installCommand,
  };
}

interface ImmigrationLib {
  companySlug: (name: string) => string;
  readCheckedAt: (md: string) => string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export async function lookupCompany(ctx: Ctx, query: string): Promise<LookupResult> {
  const lib = await importCore<ImmigrationLib>(ctx.cfg.codeRoot, 'custom/immigration/lib.mjs');
  const check = await runCheck<H1bCheck & { error?: string }>(ctx, [query, '--json']);
  const found = check.state === 'ok' && check.data?.found === true;
  const state: LookupResult['state'] = check.state === 'ok' ? (found ? 'found' : 'not_found') : check.state;

  // The saved file is keyed by the slug of whatever name the check session used: the resolved DOL name first, then the typed one.
  const names = [...(found && check.data ? [check.data.displayName] : []), query];
  const slugOf = (n: string): string | null => {
    try {
      const s = lib.companySlug(n);
      return SLUG_RE.test(s) ? s : null;
    } catch {
      return null;
    }
  };
  const slugs = [...new Set(names.map(slugOf).filter((s): s is string => s !== null))];
  const imm = path.join(ctx.cfg.dataRoot, 'data', 'immigration');
  let companyFile: CompanyFile | null = null;
  let markdown: string | null = null;
  let chosen = names[0]!;
  for (const [i, name] of names.entries()) {
    const slug = slugOf(name);
    if (!slug) continue;
    const read = readText(path.join(imm, 'companies', `${slug}.md`));
    if (read.kind !== 'ok') continue;
    companyFile = parseCompanyFile(read.text, slug, `data/immigration/companies/${slug}.md`, lib.readCheckedAt);
    markdown = read.text;
    chosen = names[i]!;
    break;
  }

  const fresh = await ctx.exec(process.execPath, [cliScriptPath(ctx.cfg.codeRoot, 'freshness'), chosen], { cwd: ctx.cfg.codeRoot, timeoutMs: CHECK_TIMEOUT_MS, env: ctx.env });
  let freshness: Record<string, unknown>;
  try {
    freshness = fresh.code === 0 ? (JSON.parse(fresh.stdout) as Record<string, unknown>) : { error: fresh.stderr.trim() || `exit ${fresh.code}` };
  } catch {
    freshness = { error: 'freshness.mjs printed non-JSON', stdout: fresh.stdout.slice(0, 400) };
  }

  const alertsRead = readText(path.join(imm, 'company-alerts.tsv'));
  const alerts =
    alertsRead.kind === 'ok'
      ? parseTsv(alertsRead.text)
          .filter((row) => {
            const rowSlug = row.slug && SLUG_RE.test(row.slug) ? row.slug : slugOf(row.company ?? '');
            return rowSlug !== null && slugs.includes(rowSlug);
          })
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      : [];

  return {
    query,
    state,
    check: check.state === 'ok' ? check.data : null,
    error: check.error,
    installCommand: check.installCommand,
    freshness,
    companyFile,
    markdown,
    alerts,
  };
}
