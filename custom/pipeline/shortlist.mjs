#!/usr/bin/env node
// Sponsorship-aware shortlist of ranked pipeline rows -> data/shortlist.md.
// Score = relevance rank + DOL sponsorship-tier adjustment; companies with a
// paused/stopped/restricted alert in data/immigration/company-alerts.tsv are
// listed separately and never shortlisted. Zero LLM tokens.
//
//   node custom/pipeline/shortlist.mjs [--min-rank 3] [--top 40]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRow, buildShortlist, pickSearchMatch } from './lib.mjs';
import * as yaml from 'js-yaml';
import { buildTitleFilter, PIPELINE_PATH, PORTALS_PATH } from '../../scan.mjs';
import { companySlug, parseCompanyAlerts } from '../immigration/lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { hasIndex } from '../../plugins/h1b-sponsor/lib/index.mjs';
import { localToday } from '../../lib/local-today.mjs';

const run = promisify(execFile);
// Code lives in the checkout; user data follows career-ops' data-root contract.
const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = getCareerOpsRoot();
// Same resolved paths (data root + CAREER_OPS_* overrides) the scanner uses.
const PIPELINE = PIPELINE_PATH;
const PORTALS = PORTALS_PATH;
const ALERTS = path.join(DATA, 'data/immigration/company-alerts.tsv');
const TIER_CACHE = path.join(DATA, 'data/immigration/sponsor-tiers.json');
const OUT = path.join(DATA, 'data/shortlist.md');
const CHECK = path.join(CODE, 'plugins/h1b-sponsor/check.mjs');
const TIER_TTL_DAYS = 30;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`${name} needs a number`);
  return n;
}

async function checkName(name) {
  const { stdout } = await run('node', [CHECK, name, '--json'], { cwd: CODE, timeout: 60000 });
  const res = JSON.parse(stdout);
  return { tier: res.found ? res.friendlinessTier : 'unknown', matched: res.displayName ?? null };
}

// Feeds use brand names; DOL uses legal names. On a miss, search by the first
// six letters and accept only a candidate whose leading words spell the name.
async function lookupTier(company) {
  const direct = await checkName(company);
  if (direct.tier !== 'unknown') return direct;
  const probe = company.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  if (probe.length < 3) return { ...direct, searched: true };
  const { stdout } = await run('node', [CHECK, probe, '--search'], { cwd: CODE, timeout: 60000 });
  const candidates = stdout.split('\n').map((l) => l.match(/^\s+\d+\s+(.+?)\s*$/)?.[1]).filter(Boolean);
  const legal = pickSearchMatch(company, candidates);
  if (!legal) return { ...direct, searched: true };
  return { ...(await checkName(legal)), searched: true };
}

// Why no lookup can run, or null when check.mjs has a backend: an explicit H1B_API_BASE, else a local index (check.mjs's
// own order). Without either, every call would fail with the same reason, which check.mjs puts on stdout.
function lookupBackendMissing() {
  if (process.env.H1B_API_BASE !== undefined) return null;
  try {
    return hasIndex() ? null : 'no local H-1B index and no H1B_API_BASE, so no company was checked against DOL data. Install the index with: node plugins/h1b-sponsor/install-h1b-index.mjs';
  } catch (err) {
    return err.message;
  }
}

// check.mjs reports why a lookup failed in the JSON `error` field on stdout; execFile's own message only names the command.
function lookupError(err) {
  try {
    const reason = JSON.parse(err.stdout ?? '').error;
    if (reason) return String(reason);
  } catch {
    // not check.mjs's JSON envelope: fall back to execFile's message
  }
  return err.message.split('\n')[0];
}

async function loadTiers(companies, today) {
  const cache = existsSync(TIER_CACHE) ? JSON.parse(await readFile(TIER_CACHE, 'utf8')) : {};
  const fresh = (e) => e && !e.error && (e.tier !== 'unknown' || e.searched || e.note) && (Date.parse(today) - Date.parse(e.checked)) / 86400000 < TIER_TTL_DAYS;
  const stale = companies.filter((c) => !fresh(cache[c]));
  const missing = stale.length ? lookupBackendMissing() : null;
  if (missing) {
    // Nothing is cached for these, so the first run after an install looks them up.
    process.stderr.write(`shortlist: ${missing}\n`);
    const tierOf = (c) => (stale.includes(c) ? 'lookup unavailable' : cache[c].tier);
    return { tiers: new Map(companies.map((c) => [c, tierOf(c)])), looked: 0 };
  }
  let looked = 0;
  for (const c of companies) {
    if (fresh(cache[c])) continue;
    if (!c.replace(/\b(inc|llc|ltd|corp)\b\.?/gi, '').trim()) {
      cache[c] = { tier: 'unknown', matched: null, checked: today, note: 'no usable company name' };
      continue;
    }
    try {
      cache[c] = { ...(await lookupTier(c)), checked: today };
    } catch (err) {
      process.stderr.write(`tier lookup failed for ${c}: ${lookupError(err)}\n`);
      cache[c] = { tier: 'lookup failed', matched: null, checked: today, error: true };
    }
    looked++;
  }
  // data/immigration exists only once the daily job or a sponsorship check ran.
  await mkdir(path.dirname(TIER_CACHE), { recursive: true });
  await writeFile(TIER_CACHE, JSON.stringify(cache, null, 2) + '\n');
  return { tiers: new Map(companies.map((c) => [c, cache[c].tier])), looked };
}

async function loadAlerts(companies) {
  if (!existsSync(ALERTS)) return new Map();
  const bySlug = parseCompanyAlerts(await readFile(ALERTS, 'utf8'));
  // The slug column is whatever the writing session derived; the company name, slugged here like the pipeline rows,
  // matches even when its rule differed (AT&T as at-t, a kept "corporation").
  for (const [, alert] of [...bySlug]) {
    let own;
    try {
      own = companySlug(alert.company);
    } catch {
      continue;
    }
    const prev = bySlug.get(own);
    if (!prev || alert.date >= prev.date) bySlug.set(own, alert);
  }
  const out = new Map();
  for (const c of companies) {
    let slug;
    try {
      slug = companySlug(c);
    } catch {
      continue; // feed gave no usable company name (e.g. "Inc."); nothing to match
    }
    const hit = bySlug.get(slug) ?? [...bySlug].find(([s]) => slug.startsWith(`${s}-`))?.[1];
    if (hit) out.set(c, hit);
  }
  return out;
}

// scan.mjs creates the pipeline only once a scan adds an offer, so a fresh root has none yet: an empty pipeline.
async function readPipeline() {
  try {
    return await readFile(PIPELINE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// The pasted-URL workflow never writes portals.yml, and js-yaml refuses an empty document: no title negatives either way.
async function readPortals() {
  let text;
  try {
    text = await readFile(PORTALS, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  return text.trim() ? (yaml.load(text) ?? {}) : {};
}

const cell = (s) => String(s ?? '').replace(/\|/g, '/');

const USAGE = `Usage: node custom/pipeline/shortlist.mjs [--min-rank 3] [--top 40]
Writes data/shortlist.md from the ranked pending rows, scored with each company's DOL sponsorship tier.
  --min-rank N   leave out rows ranked below N (default 3)
  --top N        list at most N rows (default 40)
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const minRank = arg('--min-rank', 3);
  const top = arg('--top', 40);
  const today = localToday();
  const rows = (await readPipeline()).split('\n').map(parseRow).filter((r) => r?.pending && r.rank !== null);
  const companies = [...new Set(rows.filter((r) => r.rank >= minRank).map((r) => r.company))];
  const { tiers, looked } = await loadTiers(companies, today);
  const alerts = await loadAlerts(companies);
  // Re-apply only the CURRENT negatives: rows the scanner admitted (including
  // via per-company title_filter_overrides) stay, titles blocked since then go.
  const titleCfg = (await readPortals())?.title_filter ?? {};
  const titleOk = buildTitleFilter({ positive: [], negative: titleCfg.negative ?? [] });
  const { shortlist, excluded } = buildShortlist(rows, { tiers, alerts, minRank, keep: (r) => titleOk(r.title) });

  const md = [
    `# Shortlist - ${today}`,
    '',
    `Ranked rows with rank >= ${minRank}: ${shortlist.length + excluded.length}. Score = rank + sponsorship adjustment (strong +0.5, moderate +0.2, unknown -0.3, weak -1.0, none/staffing-shop -1.5; lookup unavailable/failed: no DOL answer, no adjustment). Sponsorship tier is DOL filing history and lags policy; full evaluation re-checks current news.`,
    '',
    '| # | Score | Rank | Sponsor | Company | Role | Location | Posted | Why |',
    '|---|---|---|---|---|---|---|---|---|',
    ...shortlist.slice(0, top).map((s, i) =>
      `| ${i + 1} | ${s.score} | ${s.rank} | ${cell(s.sponsor)} | ${cell(s.company)} | [${cell(s.title || s.url)}](${s.url}) | ${cell(s.location)} | ${s.posted ?? '-'} | ${cell(s.rankReason)} |`),
    '',
    `## Excluded by sponsorship alerts (${excluded.length})`,
    '',
    ...(excluded.length ? excluded.map((s) => `- ${cell(s.company)} - [${cell(s.title || s.url)}](${s.url}) - ${cell(s.sponsor)}`) : ['- none']),
    '',
  ].join('\n');
  await writeFile(OUT, md);
  process.stdout.write(`shortlist: ${shortlist.length} kept, ${excluded.length} excluded, ${companies.length} companies (${looked} tier lookups) -> data/shortlist.md\n`);
}

main().catch((err) => {
  process.stderr.write(`shortlist failed: ${err.message}\n`);
  process.exit(1);
});
