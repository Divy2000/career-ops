import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { BusyError, ModeRefusedError, NotFoundError, OutdatedSessionError, type SessionManager } from '../claude/manager.js';
import { listLaunchableModeIds } from '../claude/modes.js';
import { EXPLICIT_HEADER } from './settings.js';
import type { EventBus } from '../watch/bus.js';
import { ProfileMissingError, rememberFact } from '../domains/memory.js';
import { sessionModel } from '../domains/settings.js';
import { extractSourceText } from '../domains/projects.js';
import { claimHolderText, PendingUnreadableError, policyClaim, preparePolicyPass, type PolicyPass } from '../domains/policyPass.js';
import crypto from 'node:crypto';
import { BATCH_MAX_URLS } from '../../shared/fanout.js';
import { withEmptyJsonBody } from '../lib/empty-json-body.js';
import { removeUpload, uploadTarget } from '../actions/tmp-inputs.js';

const target = z.object({ type: z.enum(['app', 'url', 'company', 'text', 'none']), value: z.string().max(4000).nullable() });
const prompt = z.string().min(1).max(20_000);
const model = z.string().regex(/^[\w.-]+$/).max(60).nullable().optional();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesTarget(prompt: string, type: string, v: string): boolean {
  // A row is named only as "#3", never inside "#30": a bare "3" in the prompt can be anything.
  if (type === 'app') return new RegExp(`#${escapeRegExp(v)}(?!\\d)`).test(prompt);
  // A company as a whole word in any case ("Meta" is not named by "Metadata"); lookarounds, not \b, so "Stripe, Inc." works.
  if (type === 'company') return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(v)}(?![\\p{L}\\p{N}_])`, 'iu').test(prompt);
  // A URL is named only where it ends: before a space or the end, after any closing punctuation ("...1", or "...1).").
  // A longer URL that starts with it (.../acme/12, .../acme/1/apply, .../acme/1?ref=x) is another URL.
  return new RegExp(`${escapeRegExp(v)}(?=[.,;:!?)\\]}>"']*(?:\\s|$))`).test(prompt);
}

/**
 * Claude only gets the prompt and the preamble, never the session's target, so a target the prompt does not already
 * name is added to the first message. A text target (a document path) is the mode's own input and is left alone.
 */
export function promptWithTarget(prompt: string, target: { type: string; value: string | null }): string {
  const v = target.value?.trim();
  if (!v || target.type === 'none' || target.type === 'text') return prompt;
  if (namesTarget(prompt, target.type, v)) return prompt;
  const what = target.type === 'app' ? `tracker row #${v}` : target.type === 'company' ? `company ${v}` : v;
  return `${prompt}\n\nTarget: ${what}`;
}

export async function sessionRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; manager: SessionManager; bus: EventBus; daily?: { runningNow(): Promise<boolean> }; dailyPending?: () => boolean }): Promise<void> {
  const { manager } = opts;
  // Every session event also rides the app's one event stream, so a page follows any number of sessions on the
  // connection it already holds (HTTP/1.1 allows 6 per host; one stream per session stalled the page at five).
  const offBus = manager.onEvent((sessionId, stored) => opts.bus.publish('session.event', { sessionId, stored }));
  app.addHook('onClose', async () => offBus());
  // An uploaded CV holds personal data, but any session that names it can still read it (a reply, a "re-read page 2"
  // turn after done, a fork or a retry). It goes when the last session naming it is deleted; the startup age sweep
  // removes any left behind. Only a regular file in the uploads folder ever goes, and a failure is logged, never
  // thrown: the delete it follows has already happened.
  const dropUpload = (meta: { target?: { type?: string; value?: string | null } }) => {
    const value = meta.target?.type === 'text' ? meta.target.value : null;
    if (!value) return;
    try {
      const target = uploadTarget(opts.cfg.dataRoot, value);
      if (target.kind !== 'upload') return;
      const names = (m: { target?: { type?: string; value?: string | null } }) => {
        if (m.target?.type !== 'text' || !m.target.value) return false;
        const other = uploadTarget(opts.cfg.dataRoot, m.target.value);
        return other.kind === 'upload' && other.path === target.path;
      };
      if (manager.list().some(names)) return;
      removeUpload(opts.cfg.dataRoot, target.path);
    } catch (err) {
      app.log.warn({ err, value }, 'could not remove an uploaded CV (or tell whether a session still reads it); the startup sweep will');
    }
  };
  // Unlocking data/blacklist.md for a turn is the same explicit gate as PUT /api/blacklist: Dev Chat only, and the header on that request.
  const unlockRefused = (mode: string, headers: Record<string, unknown>) =>
    manager.effectivePolicy(mode)?.policyClass !== 'devchat'
      ? 'only a Dev Chat turn can unlock data/blacklist.md'
      : headers[EXPLICIT_HEADER] !== 'blacklist'
        ? 'unlocking data/blacklist.md for a turn needs the X-CC-Explicit: blacklist header on that request'
        : null;

  // The policy-pass claim (see policyClaim): a started session takes over its starting claim (and lets it go at once if
  // the session already ended, a start that failed before spawning), and a session that ends or is deleted releases it.
  const FINAL = new Set(['done', 'error', 'cancelled']);
  const handOver = (starting: string, meta: { id: string; status: string }) => {
    const owner = `session:${meta.id}`;
    policyClaim.retag(opts.cfg.dataRoot, starting, owner);
    if (FINAL.has(manager.read(meta.id)?.status ?? meta.status)) policyClaim.release(opts.cfg.dataRoot, owner);
  };
  const offClaims = manager.onEvent((sessionId, { event }) => {
    if (event.type !== 'status' && event.type !== 'error') return;
    if (!FINAL.has(manager.read(sessionId)?.status ?? '')) return;
    try {
      policyClaim.release(opts.cfg.dataRoot, `session:${sessionId}`);
    } catch (err) {
      app.log.warn({ err, sessionId }, 'could not release the AI policy pass claim; a later pass takes it over as stale');
    }
  });
  app.addHook('onClose', async () => offClaims());
  /** A reply or fork of a policy pass continues it: it must hold the claim. Null when it may go on, else the 409 reason. */
  const claimForTurn = (id: string, owner: string, takeFrom?: string): string | null => {
    const meta = manager.read(id);
    if (meta?.mode !== 'immigration-policy') return null;
    const claimed = policyClaim.take(opts.cfg.dataRoot, owner, { batch: meta.policyBatch ?? null, takeFrom });
    return claimed.ok ? null : `Not continued: ${claimHolderText(claimed.holder.owner)}. Try again once it finishes.`;
  };

  app.get('/api/sessions', async () => manager.list());

  app.get('/api/sessions/engine', async () => ({ playwrightAvailable: manager.playwrightAvailable, modes: listLaunchableModeIds() }));

  app.post<{ Body: unknown }>('/api/sessions', async (req, reply) => {
    // A report number is reserved by the fan-out (reserve-report-num.mjs) and released with force when the session
    // ends: one named here would release a number another fan-out holds, reopening a report-number collision.
    if (req.body && typeof req.body === 'object' && 'reportNum' in req.body) {
      return reply.code(400).send({ error: 'a session cannot name a report number; Batch evaluate reserves one per posting' });
    }
    const parsed = z.object({ mode: z.string().min(1).max(100), target: target.default({ type: 'none', value: null }), prompt, model, blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (!manager.effectivePolicy(parsed.data.mode)) return reply.code(404).send({ error: `unknown mode ${parsed.data.mode}` });
    const refused = parsed.data.blacklistAllowed ? unlockRefused(parsed.data.mode, req.headers) : null;
    if (refused) return reply.code(403).send({ error: refused });
    // An upload is stored in its canonical form, so the delete that removes it can tell every session naming it.
    if (parsed.data.target.type === 'text' && parsed.data.target.value) {
      const upload = uploadTarget(opts.cfg.dataRoot, parsed.data.target.value);
      if (upload.kind === 'refused') return reply.code(400).send({ error: upload.reason });
      if (upload.kind === 'upload') parsed.data.target = { type: 'text', value: upload.path };
    }
    const chosenModel = sessionModel(opts.cfg.dataRoot, parsed.data.model);
    let userPrompt = promptWithTarget(parsed.data.prompt, parsed.data.target);
    // projects-ingest runs no command: the app extracts its documents/ source (as intake does) and the text rides in the first message.
    if (parsed.data.mode === 'projects-ingest') {
      const doc = parsed.data.target.type === 'text' && parsed.data.target.value ? await extractSourceText(opts.cfg.codeRoot, opts.cfg.dataRoot, parsed.data.target.value) : { ok: false as const, error: 'projects-ingest needs the documents/ path of the source as its target' };
      if (!doc.ok) return reply.code(422).send({ error: doc.error });
      userPrompt = `${userPrompt}\n\n<document source="documents/${doc.rel}">\n${doc.text.replace(/<\/document/gi, '<\\/document')}\n</document>`;
    }
    // The policy pass runs as run-daily.sh runs it: daily-prompt.md filled in with the queued official items (the
    // client's prompt only asks for the pass), and the batch of those items is acknowledged when the pass is done.
    let pass: PolicyPass | null = null;
    // The pass's claim while its session is being created; the session takes it over once it exists.
    let starting: string | null = null;
    if (parsed.data.mode === 'immigration-policy') {
      // One pass at a time: two take the same queued items (acknowledged only when one ends done) and both append the
      // same rows to policy-changes.tsv and company-alerts.tsv and a digest section. The daily job runs a pass too,
      // and one the app queued has neither its lock nor the claim yet.
      if ((await opts.daily?.runningNow()) || opts.dailyPending?.()) return reply.code(409).send({ error: 'The daily job is running or about to, and it runs the AI policy pass itself. Try again once it finishes.' });
      starting = `starting:${crypto.randomUUID()}`;
      const claimed = policyClaim.take(opts.cfg.dataRoot, starting);
      if (!claimed.ok) return reply.code(409).send({ error: `Not started: ${claimHolderText(claimed.holder.owner)}. Try again once it finishes.` });
      try {
        pass = preparePolicyPass(opts.cfg.codeRoot, opts.cfg.dataRoot);
      } catch (err) {
        policyClaim.release(opts.cfg.dataRoot, starting);
        if (err instanceof PendingUnreadableError) return reply.code(422).send({ error: err.message });
        throw err;
      }
      policyClaim.take(opts.cfg.dataRoot, starting, { batch: pass.batch });
      userPrompt = pass.prompt;
    }
    try {
      const meta = await manager.start({ ...parsed.data, prompt: userPrompt, model: chosenModel, reportNum: null, policyBatch: pass?.batch ?? null });
      if (starting) handOver(starting, meta);
      return reply.code(202).send(meta);
    } catch (err) {
      if (starting) policyClaim.release(opts.cfg.dataRoot, starting);
      if (err instanceof ModeRefusedError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Body: unknown }>('/api/sessions/fanout', async (req, reply) => {
    const parsed = z.object({ mode: z.string().min(1).max(100), urls: z.array(z.string().url().max(2048)).min(1).transform((urls) => [...new Set(urls)]).pipe(z.array(z.string()).max(BATCH_MAX_URLS)), model }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (!manager.effectivePolicy(parsed.data.mode)) return reply.code(404).send({ error: `unknown mode ${parsed.data.mode}` });
    try {
      const out = await manager.fanOut({ mode: parsed.data.mode, urls: parsed.data.urls, model: sessionModel(opts.cfg.dataRoot, parsed.data.model) });
      return reply.code(202).send(out);
    } catch (err) {
      return reply.code(err instanceof ModeRefusedError ? 422 : 502).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const meta = manager.read(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such session' });
    return { meta, events: manager.store.readEvents(meta.id) };
  });

  const mutate = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof BusyError || err instanceof OutdatedSessionError) return reply.code(409).send({ error: err.message });
      if (err instanceof ModeRefusedError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  };

  app.post<{ Params: { id: string }; Body: unknown }>('/api/sessions/:id/turns', async (req, reply) => {
    const parsed = z.object({ prompt, blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (parsed.data.blacklistAllowed) {
      const meta = manager.read(req.params.id);
      if (!meta) return reply.code(404).send({ error: 'no such session' });
      const refused = unlockRefused(meta.mode, req.headers);
      if (refused) return reply.code(403).send({ error: refused });
    }
    const busy = claimForTurn(req.params.id, `session:${req.params.id}`);
    if (busy) return reply.code(409).send({ error: busy });
    return mutate(reply, async () => reply.code(202).send(await manager.send(req.params.id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed })));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/sessions/:id/fork', async (req, reply) => {
    const parsed = z.object({ prompt, blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    // A fork's first turn is a turn like any other: the same explicit unlock gate as POST /turns.
    if (parsed.data.blacklistAllowed) {
      const meta = manager.read(req.params.id);
      if (!meta) return reply.code(404).send({ error: 'no such session' });
      const refused = unlockRefused(meta.mode, req.headers);
      if (refused) return reply.code(403).send({ error: refused });
    }
    // A fork continues the pass of the session it forks: it takes the claim from it (and from no other live holder).
    const starting = `starting:${crypto.randomUUID()}`;
    const busy = claimForTurn(req.params.id, starting, `session:${req.params.id}`);
    if (busy) return reply.code(409).send({ error: busy });
    const isPass = manager.read(req.params.id)?.mode === 'immigration-policy';
    return mutate(reply, async () => {
      try {
        const forked = await manager.fork(req.params.id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed });
        if (isPass) handOver(starting, forked);
        return reply.code(202).send(forked);
      } catch (err) {
        // The fork did not start: the claim goes back to the session it was taken from.
        if (isPass) policyClaim.retag(opts.cfg.dataRoot, starting, `session:${req.params.id}`);
        throw err;
      }
    });
  });

  await withEmptyJsonBody(app, (scope) => {
    scope.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req, reply) => mutate(reply, async () => manager.cancel(req.params.id)));
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) =>
    mutate(reply, async () => {
      const meta = manager.read(req.params.id);
      if (!meta) return reply.code(404).send({ error: 'no such session' });
      // Deleted first: a running session refuses, and its upload stays with it.
      manager.delete(req.params.id);
      dropUpload(meta);
      try {
        policyClaim.release(opts.cfg.dataRoot, `session:${req.params.id}`);
      } catch (err) {
        app.log.warn({ err }, 'could not release the AI policy pass claim; a later pass takes it over as stale');
      }
      return { ok: true };
    }),
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (req, reply) => {
    const meta = manager.read(req.params.id);
    if (!meta) return reply.code(404).send({ error: 'no such session' });
    const after = Number(req.headers['last-event-id'] ?? 0) || 0;
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
    reply.raw.write('retry: 2000\n\n');
    let last = after;
    const send = (ev: { seq: number; ts: string; event: { type: string } }) => {
      if (ev.seq <= last) return;
      last = ev.seq;
      reply.raw.write(`id: ${ev.seq}\nevent: ${ev.event.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    for (const ev of manager.store.readEvents(meta.id, after)) send(ev);
    const off = manager.onEvent((sid, ev) => sid === meta.id && send(ev));
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000);
    await opts.bus.stream(reply);
    clearInterval(heartbeat);
    off();
    return reply;
  });

  app.post<{ Body: unknown }>('/api/memory', async (req, reply) => {
    const parsed = z.object({ fact: z.string().min(1).max(300) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    try {
      return { result: rememberFact(opts.cfg.dataRoot, parsed.data.fact) };
    } catch (err) {
      if (err instanceof ProfileMissingError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
