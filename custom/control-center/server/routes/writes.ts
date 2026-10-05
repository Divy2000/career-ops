import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { importCore } from '../core/adapter.js';
import { applyInboxSkip, postingUrl } from '../domains/inboxSkip.js';
import { appendOffers, editFollowups, FollowupsBusyError } from '../domains/writers.js';
import { readApplyDocuments, readDocuments } from '../domains/documents.js';
import { readTracker } from '../domains/tracker.js';
import type { DailyJobWatch } from '../system/daily.js';
import { dataRootOnly, writeFileAtomic } from '../lib/atomic-write.js';

type PipelineLock = { withPipelineLock: <T>(p: string, fn: () => T | Promise<T>, o?: { timeoutMs?: number; retryMs?: number }) => Promise<T> };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const url = z.string().refine((s) => postingUrl(s) !== null, 'must be an http(s) posting URL');

export async function writeRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; daily: DailyJobWatch }): Promise<void> {
  const { cfg } = opts;
  const pipelinePath = path.join(cfg.dataRoot, 'data', 'pipeline.md');

  app.post<{ Body: { url?: unknown; done?: unknown } }>('/api/pipeline/skip', async (req, reply) => {
    const parsed = z.object({ url, done: z.boolean() }).safeParse(req.body ?? {});
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

  app.post<{ Body: { urls?: unknown } }>('/api/pipeline/urls', async (req, reply) => {
    const parsed = z.object({ urls: z.array(url).min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const offers = [...new Set(parsed.data.urls)].map((u) => ({ url: u, company: '', title: '' }));
    return appendOffers(cfg.codeRoot, cfg.dataRoot, offers, false);
  });

  app.post<{ Body: { offers?: unknown } }>('/api/pipeline/add', async (req, reply) => {
    const offer = z.object({ url, company: z.string().max(200), title: z.string().max(300), location: z.string().max(200).optional(), portal: z.string().max(100).optional() });
    const parsed = z.object({ offers: z.array(offer).min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return appendOffers(cfg.codeRoot, cfg.dataRoot, parsed.data.offers, true);
  });

  const followupsReply = async (reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown } }, fn: () => Promise<Awaited<ReturnType<typeof editFollowups>>>) => {
    try {
      const r = await fn();
      if (!r.ok) return reply.code(r.error === 'not-found' ? 404 : 400).send({ error: r.error });
      return { ok: true, ...(r.num !== undefined ? { num: r.num } : {}) };
    } catch (err) {
      if (err instanceof FollowupsBusyError) return reply.code(409).header('retry-after', '1').send({ error: err.message });
      throw err;
    }
  };

  app.post<{ Body: Record<string, unknown> }>('/api/followups/log', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive(), date: DATE, channel: z.string().max(60), contact: z.string().max(200).default(''), notes: z.string().max(1000).default('') }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === parsed.data.appNum) : undefined;
    if (!row) return reply.code(404).send({ error: `no tracker row #${parsed.data.appNum}` });
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, { op: 'log.add', ...parsed.data, company: row.company, role: row.role }));
  });

  app.delete<{ Body: Record<string, unknown> }>('/api/followups/log', async (req, reply) => {
    const parsed = z.object({ num: z.number().int().positive() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, { op: 'log.delete', num: parsed.data.num }));
  });

  app.post<{ Body: Record<string, unknown> }>('/api/followups/override', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive(), date: DATE }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, { op: 'pin.set', appNum: parsed.data.appNum, date: parsed.data.date, setOn: new Date().toISOString().slice(0, 10) }));
  });

  app.delete<{ Body: Record<string, unknown> }>('/api/followups/override', async (req, reply) => {
    const parsed = z.object({ appNum: z.number().int().positive() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    return followupsReply(reply, () => editFollowups(cfg.codeRoot, cfg.dataRoot, { op: 'pin.clear', appNum: parsed.data.appNum }));
  });

  app.get<{ Params: { n: string } }>('/api/tracker/:n/documents', async (req, reply) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'row number must be a positive integer' });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === n) : undefined;
    if (!row) return reply.code(404).send({ error: `no tracker row #${n}` });
    return readDocuments(cfg.dataRoot, row.report, row.company);
  });

  app.get<{ Querystring: { n?: string } }>('/api/apply/documents', async (req, reply) => {
    if (req.query.n === undefined) return readApplyDocuments(cfg.dataRoot, null);
    const n = Number(req.query.n);
    if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: 'row number must be a positive integer' });
    const tracker = await readTracker(cfg.codeRoot, cfg.dataRoot);
    const row = tracker.kind === 'ok' ? tracker.rows.find((r) => r.num === n) : undefined;
    if (!row) return reply.code(404).send({ error: `no tracker row #${n}` });
    return readApplyDocuments(cfg.dataRoot, row);
  });

  app.get('/api/system/daily', async () => opts.daily.status());
}
