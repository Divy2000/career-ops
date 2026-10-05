import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import { importCore, cliScriptPath } from '../core/adapter.js';
import { readTracker } from '../domains/tracker.js';
import { readReport } from '../domains/reports.js';
import { readPipeline, readScanHistory } from '../domains/pipeline.js';
import { readShortlist } from '../domains/shortlist.js';
import { localDate, readImmigrationOverview } from '../domains/immigration.js';
import { collectWhatsNew, resolveOfferLimit, type NormalizeTextKey } from '../domains/whatsNew.js';
import { computeDashboard, readStatusLog, statusLabeler } from '../domains/insights.js';
import { activePin, parseFollowups, parseNextOverrides } from '../domains/followups.js';
import { readText } from '../domains/files.js';
import { inside } from '../lib/paths.js';
import { execNoShell, type Exec } from './system.js';
import { listLaunchableModeIds, getModePolicy } from '../claude/modes.js';
import type { EventBus } from '../watch/bus.js';
import type { DailyJobWatch } from '../system/daily.js';
import type { FollowupCadence } from '../../shared/api.js';

const SERVE_ROOTS = ['output', 'jds', 'reports'] as const;
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
};

/** Resolve a user-supplied relative path to a file under one of the allowed roots, or null. */
export function containedPath(dataRoot: string, requested: string): { abs: string; root: string } | null {
  if (!requested || requested.includes('\0') || path.isAbsolute(requested)) return null;
  const normalized = path.posix.normalize(requested.split(path.sep).join('/'));
  const root = SERVE_ROOTS.find((r) => normalized === r || normalized.startsWith(`${r}/`));
  if (!root) return null;
  const abs = path.resolve(dataRoot, normalized);
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = fs.realpathSync(path.join(dataRoot, root));
    realFile = fs.realpathSync(abs);
  } catch {
    return null;
  }
  if (realRoot === path.parse(realRoot).root) return null;
  if (realFile !== realRoot && !inside(realRoot, realFile)) return null;
  return { abs: realFile, root };
}

function isNoApplications(v: unknown): v is { error: string; cadenceDefaults?: Record<string, number> } {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string' && /no applications/i.test((v as { error: string }).error);
}

function emptyFollowups(cadenceDefaults: Record<string, number> | undefined, nowMs: number): FollowupCadence {
  return {
    metadata: { analysisDate: localDate(new Date(nowMs)), totalTracked: 0, actionable: 0, overdue: 0, urgent: 0, cold: 0, waiting: 0, retired: 0 },
    entries: [],
    ...(cadenceDefaults ? { cadenceDefaults } : {}),
  };
}

export async function readRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; bus: EventBus; exec?: Exec; now?: () => number; daily: DailyJobWatch }): Promise<void> {
  const { cfg, bus } = opts;
  const exec = opts.exec ?? execNoShell;
  const now = opts.now ?? (() => Date.now());
  // Core scripts resolve the user data root through CAREER_OPS_ROOT.
  const coreEnv = { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' };

  app.get('/api/events', async (req, reply) => {
    bus.attach(reply);
    await new Promise<void>((resolve) => req.raw.on('close', resolve));
    return reply;
  });

  app.get('/api/tracker', async () => readTracker(cfg.codeRoot, cfg.dataRoot));

  app.get<{ Params: { n: string } }>('/api/tracker/:n', async (req, reply) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'row number must be a positive integer' });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    if (tracker.kind !== 'ok') return reply.code(404).send({ error: 'tracker unavailable', tracker });
    const row = tracker.rows.find((r) => r.num === n);
    if (!row) return reply.code(404).send({ error: `no tracker row #${n}` });
    const report = row.report !== null ? readReport(cfg.dataRoot, row.report) : { kind: 'none' as const };
    const followupsRead = readText(path.join(cfg.dataRoot, 'data', 'follow-ups.md'));
    const followups = followupsRead.kind === 'ok' ? parseFollowups(followupsRead.text).filter((f) => f.appNum === n) : [];
    const pin = followupsRead.kind === 'ok' ? activePin(parseNextOverrides(followupsRead.text).get(n) ?? null, followups) : null;
    const statusLog = readStatusLog(tracker.path).filter((s) => s.num === n);
    const { normalizeTextKey } = await importCore<{ normalizeTextKey: NormalizeTextKey }>(cfg.codeRoot, 'tracker-parse.mjs');
    const key = normalizeTextKey(row.company, ' ');
    const companyHistory = tracker.rows.filter((r) => r.num !== n && normalizeTextKey(r.company, ' ') === key);
    const overview = await readImmigrationOverview(cfg.codeRoot, cfg.dataRoot);
    const companyFile = overview.companies.find((c) => normalizeTextKey(c.name, ' ') === key) ?? null;
    const alert = overview.alerts.latest.find((a) => normalizeTextKey(String(a.company ?? ''), ' ') === key) ?? null;
    return { row, report, timeline: { statusLog, followups, pin }, companyHistory, sponsorship: { companyFile, alert } };
  });

  app.get('/api/pipeline', async () => readPipeline(cfg.dataRoot));
  app.get('/api/shortlist', async () => readShortlist(cfg.dataRoot));

  app.get<{ Querystring: { days?: string; limit?: string } }>('/api/whats-new', async (req) => {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const limit = resolveOfferLimit(req.query.limit);
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const applications = tracker.kind === 'ok' ? tracker.rows : [];
    const { normalizeTextKey } = await importCore<{ normalizeTextKey: NormalizeTextKey }>(cfg.codeRoot, 'tracker-parse.mjs');
    return collectWhatsNew({ history: readScanHistory(cfg.dataRoot), applications, norm: normalizeTextKey, now: now(), days, limit });
  });

  app.get('/api/immigration/overview', async () => readImmigrationOverview(cfg.codeRoot, cfg.dataRoot, localDate(new Date(now())), () => opts.daily.runningNow()));

  app.get<{ Params: { slug: string } }>('/api/immigration/companies/:slug', async (req, reply) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.slug)) return reply.code(400).send({ error: 'bad slug' });
    const overview = await readImmigrationOverview(cfg.codeRoot, cfg.dataRoot);
    const company = overview.companies.find((c) => c.slug === req.params.slug);
    if (!company) return reply.code(404).send({ error: 'no company file' });
    const text = readText(company.path);
    const fresh = await exec(process.execPath, [cliScriptPath(cfg.codeRoot, 'freshness'), company.name], { cwd: cfg.codeRoot, timeoutMs: 20_000, env: coreEnv });
    let freshness: unknown;
    try {
      freshness = fresh.code === 0 ? JSON.parse(fresh.stdout) : { error: fresh.stderr.trim() || `exit ${fresh.code}` };
    } catch {
      freshness = { error: 'freshness.mjs printed non-JSON', stdout: fresh.stdout.slice(0, 400) };
    }
    return { company, markdown: text.kind === 'ok' ? text.text : '', freshness };
  });

  app.get('/api/followups', async (_req, reply) => {
    const r = await exec(process.execPath, [cliScriptPath(cfg.codeRoot, 'followupCadence'), '--json'], { cwd: cfg.codeRoot, timeoutMs: 30_000, env: coreEnv });
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      parsed = undefined;
    }
    // The script exits 1 with a JSON error for a tracker with no rows. That is a new user's normal state, not a failure.
    if (r.code !== 0 && isNoApplications(parsed)) {
      // The script says "no applications" for any tracker whose rows it cannot parse too; only a missing or row-less tracker is the empty state.
      const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
      if (tracker.kind === 'malformed') return reply.code(502).send({ error: 'followup-cadence: tracker is malformed', detail: tracker.error, path: tracker.path });
      if (tracker.kind === 'ok' && tracker.rows.length > 0) return reply.code(502).send({ error: 'followup-cadence reported no applications but the tracker has rows', exit: r.code });
      return emptyFollowups(parsed.cadenceDefaults, now());
    }
    if (r.code !== 0) return reply.code(502).send({ error: 'followup-cadence failed', exit: r.code, stderr: r.stderr.slice(-2000) });
    if (parsed === undefined) return reply.code(502).send({ error: 'followup-cadence printed non-JSON', stdout: r.stdout.slice(0, 400) });
    return parsed;
  });

  app.get('/api/insights/dashboard', async () => {
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    if (tracker.kind !== 'ok') return { kind: tracker.kind, path: tracker.path };
    return { kind: 'ok', dashboard: computeDashboard(tracker.rows, readStatusLog(tracker.path), await statusLabeler(cfg.codeRoot)) };
  });

  app.get('/api/modes', async () => listLaunchableModeIds().map((id) => getModePolicy(id)));

  app.get<{ Querystring: { path?: string } }>('/api/files/serve', async (req, reply) => {
    const found = containedPath(cfg.dataRoot, req.query.path ?? '');
    if (!found) return reply.code(403).send({ error: 'path must be a file under output/, jds/ or reports/' });
    const type = CONTENT_TYPES[path.extname(found.abs).toLowerCase()];
    if (!type) return reply.code(415).send({ error: 'unsupported file type' });
    let stat: fs.Stats;
    try {
      stat = fs.statSync(found.abs);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: 'not a file' });
    reply.header('content-type', type);
    if (type.startsWith('text/html')) reply.header('content-security-policy', 'sandbox');
    return reply.send(fs.createReadStream(found.abs));
  });
}
