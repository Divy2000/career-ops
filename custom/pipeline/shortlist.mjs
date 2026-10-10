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
import { parseRow, buildShortlist, pickSearchMatch, strayOperands } from './lib.mjs';
import * as yaml from 'js-yaml';
import { buildTitleFilter, PIPELINE_PATH, PORTALS_PATH } from '../../scan.mjs';
import { companySlug, parseCompanyAlerts } from '../immigration/lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { hasIndex } from '../../plugins/h1b-sponsor/lib/index.mjs';
import { localToday } from '../../lib/local-today.mjs';
import { validateFlags, flagValue, hasFlag } from '../../lib/cli-flags.mjs';

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

function arg(args, name, fallback) {
  if (!hasFlag(args, name)) return fallback;
  const raw = flagValue(args, name) ?? '';
  // Number('') is 0, so an empty `--top=` would silently list nothing.
  const n = raw.trim() ? Number(raw) : NaN;
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

// A URL-only row has no company, and a feed can give only a legal suffix ("Inc."): nothing to look up or score.
const usableName = (c) => Boolean(c.replace(/\b(inc|llc|ltd|corp)\b\.?/gi, '').trim());

async function loadTiers(allCompanies, today) {
  const cache = existsSync(TIER_CACHE) ? JSON.parse(await readFile(TIER_CACHE, 'utf8')) : {};
  const fresh = (e) => e && !e.error && (e.tier !== 'unknown' || e.searched || e.note) && (Date.parse(today) - Date.parse(e.checked)) / 86400000 < TIER_TTL_DAYS;
  const nameless = allCompanies.filter((c) => !usableName(c));
  const companies = allCompanies.filter(usableName);
  const withNameless = (tiers) => new Map([...nameless.map((c) => [c, 'no company name']), ...tiers]);
  const stale = companies.filter((c) => !fresh(cache[c]));
  const missing = stale.length ? lookupBackendMissing() : null;
  if (missing) {
    // Nothing is cached for these, so the first run after an install looks them up.
    process.stderr.write(`shortlist: ${missing}\n`);
    const tierOf = (c) => (stale.includes(c) ? 'lookup unavailable' : cache[c].tier);
    return { tiers: withNameless(companies.map((c) => [c, tierOf(c)])), looked: 0 };
  }
  let looked = 0;
  for (const c of companies) {
    if (fresh(cache[c])) continue;
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
  return { tiers: withNameless(companies.map((c) => [c, cache[c].tier])), looked };
}

// Trailing words that name a company's legal form, not the company: "Acme Robotics, Inc." is "Acme Robotics".
const CORPORATE_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'bv', 'holdings', 'group']);

// A web domain joined by a dot to a word ("Amazon.com") names the brand; a standalone "Co" or "AI" stays a word.
const DOMAIN_SUFFIX = /(?<=[\p{L}\p{N}])\.(?:com|io|ai|net|org|co|app|dev)(?![\p{L}\p{N}]|\.[\p{L}\p{N}])/giu;

function normalizeCompanyName(name) {
  const words = String(name ?? '').replace(DOMAIN_SUFFIX, '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words.at(-1))) words.pop();
  return words.join(' ');
}

const slugOf = (name) => {
  try {
    return companySlug(name);
  } catch {
    return null; // no usable company name (e.g. "Inc."): nothing to match by slug
  }
};

// An alert applies to a company only when it names that company: equal slugs (the alert's slug column, or its company
// slugged like the pipeline rows, since the writing session's rule may have differed: AT&T as at-t, a kept
// "corporation"), or equal names once stripped of a dotted domain suffix, lowercased, stripped of punctuation and of
// trailing corporate suffixes. A longer
// or shorter name is another company ("Meta Labs" is not "Meta"). Of every alert that applies, the newest wins.
async function loadAlerts(companies) {
  if (!existsSync(ALERTS)) return new Map();
  const alerts = [...parseCompanyAlerts(await readFile(ALERTS, 'utf8'))].map(([slug, alert]) => ({
    slugs: new Set([slug, slugOf(alert.company)].filter(Boolean)),
    name: normalizeCompanyName(alert.company),
    alert,
  }));
  const out = new Map();
  for (const c of companies) {
    const slug = slugOf(c);
    const name = normalizeCompanyName(c);
    let hit = null;
    for (const a of alerts) {
      if (!(slug && a.slugs.has(slug)) && !(name && a.name === name)) continue;
      if (!hit || a.alert.date > hit.date) hit = a.alert;
    }
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
  const args = process.argv.slice(2);
  // An unknown flag (--dry-run) is refused before any lookup or write.
  validateFlags(args, ['--min-rank', '--top', '--help', '-h'], USAGE, { valueFlags: ['--min-rank', '--top'], requireOperand: true });
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const stray = strayOperands(args, ['--min-rank', '--top']);
  if (stray.length) throw new Error(`unexpected argument(s): ${stray.join(' ')}\n${USAGE}`);
  const minRank = arg(args, '--min-rank', 3);
  if (minRank < 0 || minRank > 5) throw new Error('--min-rank needs a number from 0 to 5');
  // slice(0, -n) would drop the bottom rows instead.
  const top = arg(args, '--top', 40);
  if (!Number.isInteger(top) || top < 1) throw new Error('--top needs a positive whole number');
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
    `Ranked rows with rank >= ${minRank}: ${shortlist.length + excluded.length}. Score = rank + sponsorship adjustment (strong +0.5, moderate +0.2, unknown -0.3, weak -1.0, none/staffing-shop -1.5; lookup unavailable/failed or no company name: no DOL answer, no adjustment). Sponsorship tier is DOL filing history and lags policy; full evaluation re-checks current news.`,
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
