import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { importCore } from '../core/adapter.js';
import { applyInboxSkip, pipelineRef, postingUrl } from '../domains/inboxSkip.js';
import { appendOffers, editFollowups, FollowupsBusyError, PipelineBusyError, type FollowupRefusal } from '../domains/writers.js';
import type { FollowupEdit } from '../domains/followups-edit.js';
import { readApplyDocuments, readDocuments } from '../domains/documents.js';
import { readTracker } from '../domains/tracker.js';
import type { DailyJobWatch } from '../system/daily.js';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';
import { isIsoDay, PIPELINE_ADD_MAX, PIPELINE_OFFER_LIMITS } from '../../shared/pipeline-add.js';
import { localDate } from '../../shared/local-date.js';

type PipelineLock = { withPipelineLock: <T>(p: string, fn: () => T | Promise<T>, o?: { timeoutMs?: number; retryMs?: number }) => Promise<T> };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const url = z.string().refine((s) => postingUrl(s) !== null, 'must be an http(s) posting URL');
const rowRef = z.string().refine((s) => pipelineRef(s) !== null, 'must be an http(s) posting URL or a local:jds/ reference');

export async function writeRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; daily: DailyJobWatch }): Promise<void> {
  const { cfg } = opts;
  const pipelinePath = path.join(cfg.dataRoot, 'data', 'pipeline.md');

  app.post<{ Body: { url?: unknown; done?: unknown } }>('/api/pipeline/skip', async (req, reply) => {
    const parsed = z.object({ url: rowRef, done: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { withPipelineLock } = await importCore<PipelineLock>(cfg.codeRoot, 'pipeline-lock.mjs');
    try {
      const result = await withPipelineLock(
        pipelinePath,
        () => {
          let md: string;
          try {
            md = fs.readFileSync(pipelinePath, 'utf8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false as const, error: 'not-found' as const };
            throw err;
          }
          const r = applyInboxSkip(md, parsed.data.url, parsed.data.done);
          if (r.ok && r.changed > 0) {
            writeFileAtomic(pipelinePath, r.text, dataRootOnly(cfg.dataRoot));
          }
          return r;
        },
        { timeoutMs: 5000, retryMs: 50 },
      );
      if (!result.ok) return reply.code(result.error === 'invalid-url' ? 400 : 404).send({ error: result.error });
      return { matched: result.matched, changed: result.changed, done: parsed.data.done };
    } catch (err) {
      if ((err as Error).name === 'LockTimeoutError') return reply.code(409).header('retry-after', '1').send({ error: 'pipeline is busy, try again in a moment' });
      throw err;
    }
  });

  // Like /skip: a lock another writer holds is a 409 the client retries, never a 500.
  const pipelineAdd = async (reply: FastifyReply, fn: () => Promise<{ added: number; skipped: number }>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PipelineBusyError) return reply.code(409).header('retry-after', '1').send({ error: err.message });
      throw err;
    }
  };

  app.post<{ Body: { urls?: unknown } }>('/api/pipeline/urls', async (req, reply) => {
    const parsed = z.object({ urls: z.array(url).min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const offers = [...new Set(parsed.data.urls)].map((u) => ({ url: u, company: '', title: '' }));
    return pipelineAdd(reply, () => appendOffers(cfg.codeRoot, cfg.dataRoot, offers, false));
  });

  app.post<{ Body: { offers?: unknown } }>('/api/pipeline/add', async (req, reply) => {
    const offer = z.object({ url, company: z.string().max(PIPELINE_OFFER_LIMITS.company), title: z.string().max(PIPELINE_OFFER_LIMITS.title), location: z.string().max(PIPELINE_OFFER_LIMITS.location).optional(), portal: z.string().max(PIPELINE_OFFER_LIMITS.portal).optional(), postedAt: z.string().refine(isIsoDay, 'a YYYY-MM-DD calendar day').optional() });
    const parsed = z.object({ offers: z.array(offer).min(1).max(PIPELINE_ADD_MAX) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return pipelineAdd(reply, () => appendOffers(cfg.codeRoot, cfg.dataRoot, parsed.data.offers, true));
  });

  const followupsReply = async (reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown } }, fn: () => Promise<Awaited<ReturnType<typeof editFollowups>>>) => {
    try {
      const r = await fn();
      if (!r.ok) return reply.code('status' in r && r.status !== undefined ? r.status : r.error === 'not-found' ? 404 : r.error === 'stale' ? 409 : 400).send({ error: r.error });
      return { ok: true, ...(r.num !== undefined ? { num: r.num } : {}) };
    } catch (err) {
      if (err instanceof FollowupsBusyError) return reply.code(409).header('retry-after', '1').send({ error: err.message });
      throw err;
    }
  };

  // A tracker delete reindexes the rows, so the number a page read can name another application by the time it writes:
  // expectCompany/expectRole are the row the page showed, and a write naming a row no longer under that number is refused
  // as stale, as tracker.setStatus and the follow-up Delete refuse theirs. Checked in the write's turn in the queue.
  const expectedRow = { expectCompany: z.string().optional(), expectRole: z.string().optional() };
  type ExpectedRow = { expectCompany?: string; expectRole?: string };
  const expectsRow = (p: ExpectedRow) => p.expectCompany !== undefined || p.expectRole !== undefined;
  const rowUnder = async (appNum: number, expect: ExpectedRow): Promise<{ company: string; role: string } | FollowupRefusal> => {
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    // An unreadable tracker is the problem to report: "stale" sends the page to reload, which changes nothing.
    if (tracker.kind === 'malformed') return { ok: false, error: `tracker unavailable: ${tracker.error} (${tracker.path})`, status: 503 };
    if (tracker.kind === 'missing') return { ok: false, error: `tracker unavailable: no tracker at ${tracker.path}`, status: 404 };
    const rows = tracker.rows.filter((r) => r.num === appNum);
    if (!expectsRow(expect)) return rows[0] ?? { ok: false, error: `no tracker row #${appNum}`, status: 404 };
    const row = rows.find((r) => (expect.expectCompany === undefined || r.company === expect.expectCompany) && (expect.expectRole === undefined || r.role === expect.expectRole));
    return row ?? { ok: false, error: 'stale' };
  };
  const guarded = (appNum: number, expect: ExpectedRow, edit: (row: { company: string; role: string }) => FollowupEdit) => async (): Promise<FollowupEdit | FollowupRefusal> => {
    const row = await rowUnder(appNum, expect);
    return 'ok' in row ? row : edit(row);
  };

  app.post<{ Body: Record<string, unknown> }>('/api/followups/log', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive(), date: DATE, channel: z.string().max(60), contact: z.string().max(200).default(''), notes: z.string().max(1000).default(''), ...expectedRow }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { expectCompany, expectRole, ...log } = parsed.data;
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, guarded(log.appNum, { expectCompany, expectRole }, (row) => ({ op: 'log.add', ...log, company: row.company, role: row.role }))));
  });

  app.delete<{ Body: Record<string, unknown> }>('/api/followups/log', async (req, reply) => {
    // The cells name the row as the page read it, hand edits included, so they are compared to the file, not validated.
    const parsed = z.object({ num: z.number().int().positive(), appNum: z.number().int().positive(), date: z.string(), channel: z.string(), contact: z.string(), notes: z.string() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, { op: 'log.delete', ...parsed.data }));
  });

  app.post<{ Body: Record<string, unknown> }>('/api/followups/override', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive(), date: DATE, ...expectedRow }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { appNum, date } = parsed.data;
    const edit: FollowupEdit = { op: 'pin.set', appNum, date, setOn: localDate() };
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, expectsRow(parsed.data) ? guarded(appNum, parsed.data, () => edit) : edit));
  });

  app.delete<{ Body: Record<string, unknown> }>('/api/followups/override', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive(), ...expectedRow }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const edit: FollowupEdit = { op: 'pin.clear', appNum: parsed.data.appNum };
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, expectsRow(parsed.data) ? guarded(parsed.data.appNum, parsed.data, () => edit) : edit));
  });

  app.get<{ Params: { n: string } }>('/api/tracker/:n/documents', async (req, reply) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'row number must be a positive integer' });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === n) : undefined;
    if (!row) return reply.code(404).send({ error: `no tracker row #${n}` });
    return readDocuments(cfg.codeRoot, cfg.dataRoot, row.report, row.company);
  });

  app.get<{ Querystring: { n?: string } }>('/api/apply/documents', async (req, reply) => {
    if (req.query.n === undefined) return readApplyDocuments(cfg.codeRoot, cfg.dataRoot, null);
    const n = Number(req.query.n);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'row number must be a positive integer' });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === n) : undefined;
    if (!row) return reply.code(404).send({ error: `no tracker row #${n}` });
    return readApplyDocuments(cfg.codeRoot, cfg.dataRoot, row);
  });

  app.get('/api/system/daily', async () => opts.daily.status());
}
