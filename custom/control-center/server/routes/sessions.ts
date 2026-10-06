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
import { PendingUnreadableError, preparePolicyPass, type PolicyPass } from '../domains/policyPass.js';
import { BATCH_MAX_URLS } from '../../shared/fanout.js';
import { withEmptyJsonBody } from '../lib/empty-json-body.js';

const target = z.object({ type: z.enum(['app', 'url', 'company', 'text', 'none']), value: z.string().max(4000).nullable() });
const prompt = z.string().min(1).max(20_000);
const model = z.string().regex(/^[\w.-]+$/).max(60).nullable().optional();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesTarget(prompt: string, type: string, v: string): boolean {
  // A row is named only as "#3", never inside "#30": a bare "3" in the prompt can be anything.
  if (type === 'app') return new RegExp(`#${escapeRegExp(v)}(?!\\d)`).test(prompt);
  // A company as a whole word in any case ("Meta" is not named by "Metadata"); lookarounds, not \b, so "Stripe, Inc." works.
  if (type === 'company') return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(v)}(?![\\p{L}\\p{N}_])`, 'iu').test(prompt);
  return prompt.includes(v);
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

export async function sessionRoutes(app: FastifyInstance, opts: { cfg: ServerConfig; manager: SessionManager; bus: EventBus }): Promise<void> {
  const { manager } = opts;
  // Every session event also rides the app's one event stream, so a page follows any number of sessions on the
  // connection it already holds (HTTP/1.1 allows 6 per host; one stream per session stalled the page at five).
  const offBus = manager.onEvent((sessionId, stored) => opts.bus.publish('session.event', { sessionId, stored }));
  app.addHook('onClose', async () => offBus());
  // Unlocking data/blacklist.md for a turn is the same explicit gate as PUT /api/blacklist: Dev Chat only, and the header on that request.
  const unlockRefused = (mode: string, headers: Record<string, unknown>) =>
    manager.effectivePolicy(mode)?.policyClass !== 'devchat'
      ? 'only a Dev Chat turn can unlock data/blacklist.md'
      : headers[EXPLICIT_HEADER] !== 'blacklist'
        ? 'unlocking data/blacklist.md for a turn needs the X-CC-Explicit: blacklist header on that request'
        : null;

  app.get('/api/sessions', async () => manager.list());

  app.get('/api/sessions/engine', async () => ({ playwrightAvailable: manager.playwrightAvailable, modes: listLaunchableModeIds() }));

  app.post<{ Body: unknown }>('/api/sessions', async (req, reply) => {
    const parsed = z.object({ mode: z.string().min(1).max(100), target: target.default({ type: 'none', value: null }), prompt, model, reportNum: z.number().int().positive().nullable().optional(), blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (!manager.effectivePolicy(parsed.data.mode)) return reply.code(404).send({ error: `unknown mode ${parsed.data.mode}` });
    const refused = parsed.data.blacklistAllowed ? unlockRefused(parsed.data.mode, req.headers) : null;
    if (refused) return reply.code(403).send({ error: refused });
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
    if (parsed.data.mode === 'immigration-policy') {
      try {
        pass = preparePolicyPass(opts.cfg.codeRoot, opts.cfg.dataRoot);
      } catch (err) {
        if (err instanceof PendingUnreadableError) return reply.code(422).send({ error: err.message });
        throw err;
      }
      userPrompt = pass.prompt;
    }
    try {
      const meta = await manager.start({ ...parsed.data, prompt: userPrompt, model: chosenModel, reportNum: parsed.data.reportNum ?? null, policyBatch: pass?.batch ?? null });
      return reply.code(202).send(meta);
    } catch (err) {
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
    return mutate(reply, async () => reply.code(202).send(await manager.fork(req.params.id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed })));
  });

  await withEmptyJsonBody(app, (scope) => {
    scope.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (req, reply) => mutate(reply, async () => manager.cancel(req.params.id)));
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) =>
    mutate(reply, async () => {
      if (!manager.read(req.params.id)) return reply.code(404).send({ error: 'no such session' });
      manager.delete(req.params.id);
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
