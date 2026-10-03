// Settings-area endpoints: blacklist (explicit gate), plugins, launchd schedule,
// app settings, usage meter, cached insights, contacts and interviews reads.
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import type { EventBus } from '../watch/bus.js';
import { cliScriptPath } from '../core/adapter.js';
import { execNoShell, type Exec } from './system.js';
import { etagMatches } from './config.js';
import { BLACKLIST_DATE, blacklistRowSchema, readBlacklist, writeBlacklist } from '../domains/blacklist.js';
import { listPlugins } from '../domains/plugins.js';
import { LOG_JOBS, type ScheduleService } from '../system/schedule.js';
import { listLogDates, parseDailyLog } from '../domains/immigration.js';
import { readText } from '../domains/files.js';
import { appSettingsPatchSchema, readSettings, writeSettings, type AppSettings } from '../domains/settings.js';
import { computeUsage, type UsageRead } from '../domains/usage.js';
import { INSIGHT_SCRIPTS, readInsight, type InsightScript } from '../domains/insightsCache.js';
import { readContacts, readInterviews } from '../domains/contacts.js';

export const EXPLICIT_HEADER = 'x-cc-explicit';

export interface SettingsDeps {
  cfg: ServerConfig;
  bus: EventBus;
  exec?: Exec;
  schedule: ScheduleService;
  /** Applies a saved settings object to the live runner (slot cap, retention). */
  applySettings: (s: AppSettings) => void;
}

export async function settingsRoutes(app: FastifyInstance, opts: SettingsDeps): Promise<void> {
  const { cfg, bus, schedule } = opts;
  const exec = opts.exec ?? execNoShell;

  // ---- blacklist ----
  app.get('/api/blacklist', async () => readBlacklist(cfg.dataRoot));

  app.put<{ Body: unknown }>('/api/blacklist', async (req, reply) => {
    const explicit = req.headers[EXPLICIT_HEADER];
    const confirm = (req.body as { confirm?: unknown } | null)?.confirm;
    if (explicit !== 'blacklist' || confirm !== true) {
      return reply.code(403).send({ error: 'the blacklist is only written from its editor after an explicit confirmation ({confirm:true} plus X-CC-Explicit: blacklist)' });
    }
    const body = z.object({ confirm: z.literal(true), rows: z.array(blacklistRowSchema).max(2000) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid rows: company, since (YYYY-MM-DD), scope (company|domain) and reason without pipes', issues: body.error.issues });
    for (const row of body.data.rows) {
      if (row.scope === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(row.company)) {
        return reply.code(400).send({ error: `domain scope needs a bare hostname suffix such as example.com (got ${row.company})` });
      }
    }
    const current = readBlacklist(cfg.dataRoot);
    if (!etagMatches(current.etag, req.headers['if-match'])) return reply.code(409).send({ error: 'data/blacklist.md changed since you loaded it', current });
    // New rows need YYYY-MM-DD; a legacy cell already in the file ("Sept 2025", empty) is kept as it is.
    const legacy = new Set(current.rows.map((r) => r.since));
    const badDate = body.data.rows.find((r) => !BLACKLIST_DATE.test(r.since) && !legacy.has(r.since));
    if (badDate) return reply.code(400).send({ error: `since must be YYYY-MM-DD for ${badDate.company} (got ${badDate.since || 'nothing'})` });
    const written = writeBlacklist(cfg.dataRoot, body.data.rows, current.preamble, current.postamble);
    bus.publish('data.changed', { domain: 'config' });
    return { ok: true, etag: written.etag, rows: written.rows, path: written.path };
  });

  // ---- plugins ----
  app.get('/api/plugins', async () => listPlugins(cfg.codeRoot, cfg.dataRoot));

  app.get<{ Params: { id: string } }>('/api/plugins/:id/skill', async (req, reply) => {
    const known = listPlugins(cfg.codeRoot, cfg.dataRoot).plugins.find((p) => p.id === req.params.id);
    if (!known) return reply.code(404).send({ error: `no plugin ${req.params.id}` });
    const r = await exec(process.execPath, [cliScriptPath(cfg.codeRoot, 'plugins'), 'skill', known.id], { cwd: cfg.codeRoot, timeoutMs: 15_000, env: { CAREER_OPS_ROOT: cfg.dataRoot, NO_COLOR: '1' } });
    if (r.code !== 0) return reply.code(502).send({ error: `plugins.mjs skill exited ${r.code}`, stderr: r.stderr.trim().slice(-2000) });
    // Plugin documentation is third-party text: the client renders it sanitized and labeled.
    return { id: known.id, markdown: r.stdout, untrusted: true };
  });

  // ---- launchd schedule ----
  app.get('/api/schedule', async () => ({ jobs: await schedule.readAll(), agentsDir: cfg.launchAgentsDir }));

  app.put<{ Params: { label: string }; Body: unknown }>('/api/schedule/:label', async (req, reply) => {
    const job = schedule.job(req.params.label);
    if (!job) return reply.code(404).send({ error: `unknown job ${req.params.label}` });
    const body = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), weekday: z.number().int().min(0).max(6).optional(), enabled: z.boolean() }).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid schedule: hour 0-23, minute 0-59, weekday 0-6 (weekly jobs only), enabled', issues: body.error.issues });
    if (job.kind === 'daily' && body.data.weekday !== undefined) return reply.code(400).send({ error: 'the daily job has no weekday' });
    const weekday = job.kind === 'weekly' ? (body.data.weekday ?? job.defaults.weekday) : null;
    const r = await schedule.write(job, { hour: body.data.hour, minute: body.data.minute, weekday, enabled: body.data.enabled });
    if (!r.ok) return reply.code(r.status).send({ error: r.error, stderr: r.stderr });
    bus.publish('data.changed', { domain: 'config' });
    return r.state;
  });

  const logJob = (q: { job?: string }) => LOG_JOBS[q.job ?? 'immigration-watch'];
  app.get<{ Querystring: { job?: string } }>('/api/schedule/logs', async (req, reply) => {
    const job = logJob(req.query);
    if (!job) return reply.code(400).send({ error: 'job must be immigration-watch or upstream-sync' });
    const dates = listLogDates(cfg.dataRoot, job.logDir);
    const latestDate = dates[0];
    const latest = latestDate ? readJobLog(cfg.dataRoot, job.logDir, latestDate) : null;
    return { job: job.label, dates, latest };
  });
  app.get<{ Params: { date: string }; Querystring: { job?: string } }>('/api/schedule/logs/:date', async (req, reply) => {
    const job = logJob(req.query);
    if (!job) return reply.code(400).send({ error: 'job must be immigration-watch or upstream-sync' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    const log = readJobLog(cfg.dataRoot, job.logDir, req.params.date);
    if (!log) return reply.code(404).send({ error: 'no log for that date' });
    return log;
  });

  // ---- app settings ----
  app.get('/api/settings/app', async () => {
    const { settings, problem } = readSettings(cfg.dataRoot);
    return { ...settings, problem };
  });
  app.put<{ Body: unknown }>('/api/settings/app', async (req, reply) => {
    const body = appSettingsPatchSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid settings', issues: body.error.issues });
    const next = writeSettings(cfg.dataRoot, body.data);
    opts.applySettings(next);
    bus.publish('data.changed', { domain: 'config' });
    return next;
  });

  // ---- usage meter ----
  let usageCache: { at: number; value: UsageRead } | null = null;
  app.get<{ Querystring: { fresh?: string } }>('/api/usage', async (req) => {
    const now = Date.now();
    if (!usageCache || req.query.fresh === '1' || now - usageCache.at > 30_000) usageCache = { at: now, value: computeUsage(cfg.claudeProjectsDir, now) };
    return { ...usageCache.value, budgets: readSettings(cfg.dataRoot).settings.usageBudgets };
  });

  // ---- cached insights scripts ----
  app.get('/api/insights/scripts', async () => Object.entries(INSIGHT_SCRIPTS).map(([id, d]) => ({ id, label: d.label })));
  app.get<{ Params: { script: string }; Querystring: { recompute?: string } }>('/api/insights/:script', async (req, reply) => {
    if (!(req.params.script in INSIGHT_SCRIPTS)) return reply.code(404).send({ error: `unknown insights script ${req.params.script}` });
    return readInsight(cfg, exec, req.params.script as InsightScript, { recompute: req.query.recompute === '1' });
  });

  // ---- contacts and interviews ----
  app.get('/api/contacts', async () => readContacts(cfg.dataRoot));
  app.get('/api/interviews', async () => readInterviews(cfg.dataRoot));
}

function readJobLog(dataRoot: string, logDir: string, date: string) {
  const raw = readText(path.join(dataRoot, logDir, `${date}.log`));
  if (raw.kind !== 'ok') return null;
  return { ...parseDailyLog(raw.text, date), raw: raw.text };
}
