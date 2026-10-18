import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { BusyError, liveWorkOn, ModeRefusedError, NotFoundError, OutdatedSessionError, type SessionManager } from '../claude/manager.js';
import { englishModeOf, listLaunchableModeIds, sessionRefusal } from '../claude/modes.js';
import { isReportGated } from '../claude/honesty.js';
import type { AppRowIdentity, SessionMeta } from '../claude/sessions.js';
import { readPipeline } from '../domains/pipeline.js';
import { localJdPath } from '../../shared/local-jd.js';
import { dedupUrlKey } from '../../shared/dedup-url.js';
import { EXPLICIT_HEADER } from './settings.js';
import type { EventBus } from '../watch/bus.js';
import { ProfileMissingError, rememberFact } from '../domains/memory.js';
import { sessionModel } from '../domains/settings.js';
import { extractSourceText } from '../domains/projects.js';
import { claimHolderText, PendingUnreadableError, policyClaim, PolicyQueueBusyError, preparePolicyPass, type PolicyPass } from '../domains/policyPass.js';
import crypto from 'node:crypto';
import { replyWatchSessionRefused } from '../domains/replyCandidates.js';
import { BATCH_MAX_URLS } from '../../shared/fanout.js';
import { plainPostingUrl } from '../../shared/posting-url.js';
import { sponsorCheckRefusal } from '../../shared/company-slug.js';
import { withEmptyJsonBody } from '../lib/empty-json-body.js';
import { removeUpload, uploadTarget } from '../actions/tmp-inputs.js';
import { rowsSetUnder } from '../actions/registry.js';

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
  // The row an app session starts on, so the page holding its number later can tell it apart. A number with no row, or
  // with several, pins none; a tracker that cannot be read pins none either, as the session can still run without it.
  const appRowAt = async (value: string | null): Promise<AppRowIdentity | null> => {
    const n = /^\s*(\d+)\s*$/.exec(value ?? '')?.[1];
    if (!n) return null;
    try {
      const rows = await rowsSetUnder(opts.cfg, Number(n));
      return rows.length === 1 ? rows[0]! : null;
    } catch (err) {
      app.log.warn({ err, row: n }, 'could not read the tracker row a session targets; it is started without the row pinned');
      return null;
    }
  };
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
      if (manager.list({ strict: true }).some(names)) return;
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
  /** False when the starting claim is no longer this start's (another pass took it over): the session must not run. */
  const handOver = (starting: string, meta: { id: string; status: string }): boolean => {
    const owner = `session:${meta.id}`;
    if (!policyClaim.retag(opts.cfg.dataRoot, starting, owner)) return false;
    if (FINAL.has(manager.read(meta.id)?.status ?? meta.status)) policyClaim.release(opts.cfg.dataRoot, owner);
    return true;
  };
  const LOST_CLAIM = 'another AI policy pass took over the queued items while this one was starting, so it was cancelled. Try again once that pass finishes.';
  // The claim lock can be held past its wait (a claimant that died holding it counts as stale only later).
  const claimBusy = (err: unknown) => `the AI policy pass claim could not be handed over (${(err as Error).message}), so it was cancelled. Try again in a minute.`;
  /**
   * Runs a claim cleanup without letting its own throw hide the error or answer that ended the start. A cleanup that
   * throws is retried in the background until it goes through: a starting claim names this live server, so it is never
   * taken over as stale and would otherwise hold the AI policy pass until the server restarts.
   */
  const cleanupRetries = new Set<NodeJS.Timeout>();
  const bestEffort = (what: string, fn: () => unknown, delayMs = 250) => {
    try {
      fn();
    } catch (err) {
      app.log.warn({ err }, `could not ${what}; retrying in ${delayMs} ms`);
      const timer = setTimeout(() => {
        cleanupRetries.delete(timer);
        bestEffort(what, fn, Math.min(delayMs * 2, 30_000));
      }, delayMs);
      timer.unref();
      cleanupRetries.add(timer);
    }
  };
  app.addHook('onClose', async () => {
    for (const timer of cleanupRetries) clearTimeout(timer);
    cleanupRetries.clear();
  });
  const release = (sessionId: string) => {
    try {
      policyClaim.release(opts.cfg.dataRoot, `session:${sessionId}`);
    } catch (err) {
      app.log.warn({ err, sessionId }, 'could not release the AI policy pass claim; a later pass takes it over as stale');
    }
  };
  // A session can end (a cancel sets cancelled at once) while its Claude process still runs, for up to the runner's
  // SIGKILL delay: the claim is released only once that run has ended too.
  const awaitingExit = new Map<string, string>();
  const releaseOnceExited = (sessionId: string, runId: string | undefined) => {
    if (runId && policyClaim.runUnfinished(opts.cfg.dataRoot, runId)) awaitingExit.set(runId, sessionId);
    else release(sessionId);
  };
  const offClaims = manager.onEvent((sessionId, { event }) => {
    if (event.type !== 'status' && event.type !== 'error') return;
    const meta = manager.read(sessionId);
    if (!FINAL.has(meta?.status ?? '')) return;
    releaseOnceExited(sessionId, meta?.turns.at(-1)?.runId);
  });
  const offRunEnds = opts.bus.onEvent((ev) => {
    if (ev.type !== 'run.status') return;
    const runId = (ev.payload as { runId?: string }).runId;
    const sessionId = runId ? awaitingExit.get(runId) : undefined;
    if (!runId || !sessionId || policyClaim.runUnfinished(opts.cfg.dataRoot, runId)) return;
    awaitingExit.delete(runId);
    release(sessionId);
  });
  app.addHook('onClose', async () => {
    offClaims();
    offRunEnds();
  });
  /** A reply or fork of a policy pass continues it: it must hold the claim. Null when it may go on, else the 409 reason. */
  const claimForTurn = (id: string, owner: string, takeFrom?: string): string | null => {
    const meta = manager.read(id);
    if (meta?.mode !== 'immigration-policy') return null;
    const claimed = policyClaim.take(opts.cfg.dataRoot, owner, { batch: meta.policyBatch ?? null, takeFrom });
    return claimed.ok ? null : `Not continued: ${claimHolderText(claimed.holder.owner)}. Try again once it finishes.`;
  };

  // Process inbox (pipeline mode) evaluates every pending Inbox row, so an evaluation of one of them beside it (Batch
  // evaluate, the advisor, another tab) would evaluate, report and bill that row twice: whichever starts second is refused.
  const LIVE = new Set<SessionMeta['status']>(['queued', 'running', 'awaiting_user']);
  const isProcessInbox = (mode: string) => englishModeOf(mode) === 'pipeline';
  const liveSessions = (): SessionMeta[] => manager.list().filter((m) => LIVE.has(m.status));
  /**
   * The posting URLs of the pending Inbox rows Process inbox works on, by the key POST /api/pipeline/add dedups them on
   * (two spellings of one posting are one row); it leaves saved-JD (local:jds/) rows out.
   */
  const pendingInboxUrls = (): Map<string, string> => {
    const read = readPipeline(opts.cfg.dataRoot);
    return new Map(read.kind === 'ok' ? read.rows.filter((r) => !r.done && localJdPath(r.url) === null).map((r) => [dedupUrlKey(r.url), r.url]) : []);
  };
  // A reply to a finished session carries it on over its rows, but the session reads done until its turn begins.
  const turnsStarting = new Set<string>();
  const liveOrStarting = (): SessionMeta[] => {
    const live = liveSessions();
    const starting = [...turnsStarting].filter((id) => !live.some((m) => m.id === id)).map((id) => manager.read(id));
    return [...live, ...starting.filter((m): m is SessionMeta => m !== null)];
  };
  /** Null when evaluations of these URLs in `mode` may start, else the 409 reason: a live Process inbox holds a pending one. */
  const processInboxHolds = (mode: string, urls: string[]): string | null => {
    if (!isReportGated(mode)) return null;
    const pipe = liveOrStarting().find((m) => isProcessInbox(m.mode));
    if (!pipe) return null;
    const pending = pendingInboxUrls();
    const held = urls.find((u) => pending.has(dedupUrlKey(u)));
    return held ? `Process inbox (session ${pipe.id}) is processing the pending Inbox rows, ${held} among them, and would evaluate it a second time. Try again once it ends.` : null;
  };
  /** The first session of a run's fork lineage (the id of a deleted ancestor where the chain breaks). */
  const runRoot = (meta: SessionMeta): string => {
    let cur = meta;
    for (let i = 0; i < 100 && cur.forkedFrom; i++) {
      const up = manager.read(cur.forkedFrom);
      if (!up) return cur.forkedFrom;
      cur = up;
    }
    return cur.id;
  };
  /**
   * Null when a Process inbox turn may run, else the 409 reason: another Process inbox run, or an evaluation of a pending
   * row, is live or starting. `own` is the run a reply or fork carries on: a run of its fork lineage paused for a reply
   * is carried on by it, while one that is queued or running would process the rows beside it.
   */
  const evaluationsHold = (own?: SessionMeta): string | null => {
    const sessions = liveOrStarting();
    const ownRoot = own ? runRoot(own) : null;
    const other = sessions.find((m) => isProcessInbox(m.mode) && !(m.status === 'awaiting_user' && runRoot(m) === ownRoot));
    if (other) return `Process inbox (session ${other.id}) is already processing the pending Inbox rows, and a second run would evaluate them again. Try again once it ends.`;
    const pending = pendingInboxUrls();
    const live = sessions.find((m) => isReportGated(m.mode) && m.target.type === 'url' && pending.has(dedupUrlKey(m.target.value ?? '')));
    if (live) return `session ${live.id} is evaluating the pending Inbox row ${live.target.value}, and Process inbox would evaluate it a second time. Try again once it ends.`;
    const evaluationModes = listLaunchableModeIds().filter(isReportGated);
    for (const url of pending.values()) {
      if (evaluationModes.some((m) => manager.isStartingInBatch(m, { type: 'url', value: url }))) return `a Batch evaluate is starting the pending Inbox row ${url}, and Process inbox would evaluate it a second time. Try again once it ends.`;
    }
    return null;
  };
  // A tailored CV (pdf mode) of a tracker row is one paid session writing that row's CV: a second one for the row (a
  // start, a fork, or a reply to a finished one) is refused while one is live. The check and the session's create run
  // in one tick, so two racing starts cannot both pass.
  const tailoredCvRow = (mode: string, t: { type: string; value: string | null }): string | null => {
    if (englishModeOf(mode) !== 'pdf' || t.type !== 'app' || !t.value?.trim()) return null;
    const row = t.value.trim();
    // " 12" and "012" name row 12 too.
    return /^\d+$/.test(row) ? String(Number(row)) : row;
  };
  /**
   * Null when a tailored CV for the row may run, else the 409 reason naming the session in the way. A start, or a reply
   * to or fork of a finished session, is held by any live one. A reply to or fork of a session paused for a reply carries
   * that run on, so it is held only by one whose turn runs or is starting (two paused sessions would otherwise refuse
   * each other's reply for good), and never by its own session.
   */
  const tailoredCvHolds = (row: string, own: { meta: SessionMeta; kind: 'reply' | 'fork' } | null = null): string | null => {
    const holds = (m: SessionMeta) => own?.meta.status !== 'awaiting_user' || m.status !== 'awaiting_user' || turnsStarting.has(m.id);
    const live = liveOrStarting().find((m) => tailoredCvRow(m.mode, m.target) === row && !(own?.kind === 'reply' && m.id === own.meta.id) && holds(m));
    return live ? `session ${live.id} is already generating the tailored CV for tracker row #${row}. Open it instead.` : null;
  };
  /** The 409 reason a reply or fork is refused with when it would carry on Process inbox or an evaluation over the same pending rows, or null. */
  const turnHeld = (id: string, kind: 'reply' | 'fork'): string | null => {
    const meta = manager.read(id);
    if (!meta) return null;
    if (isProcessInbox(meta.mode)) return evaluationsHold(meta);
    const cvRow = tailoredCvRow(meta.mode, meta.target);
    if (cvRow) return tailoredCvHolds(cvRow, { meta, kind });
    return meta.target.type === 'url' && meta.target.value ? processInboxHolds(meta.mode, [meta.target.value]) : null;
  };

  // A cancelled session's process can outlive its status until the runner's SIGKILL, and the duplicate-evaluation guard
  // still counts it then: `stopping` lets pages keep its posting out of a new start the server would refuse.
  app.get('/api/sessions', async () => manager.list().map((m) => (!LIVE.has(m.status) && manager.isActive(m.id) ? { ...m, stopping: true as const } : m)));

  app.get('/api/sessions/engine', async () => ({ playwrightAvailable: manager.playwrightAvailable, modes: listLaunchableModeIds() }));

  app.post<{ Body: unknown }>('/api/sessions', async (req, reply) => {
    // A report number is reserved by the fan-out (reserve-report-num.mjs) and released with force when the session
    // ends: one named here would release a number another fan-out holds, reopening a report-number collision.
    if (req.body && typeof req.body === 'object' && 'reportNum' in req.body) {
      return reply.code(400).send({ error: 'a session cannot name a report number; Batch evaluate reserves one per posting' });
    }
    const parsed = z.object({ mode: z.string().min(1).max(100), target: target.default({ type: 'none', value: null }), prompt, model, blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    // A URL target reaches the session's prompt, so it is held to the fan-out's posting URL rule.
    // Every later use (duplicate checks, inbox holds, the stored target) sees the trimmed value; a blank one names no URL.
    if (parsed.data.target.type === 'url' && parsed.data.target.value !== null) {
      const url = parsed.data.target.value.trim();
      if (url && !plainPostingUrl(url)) return reply.code(400).send({ error: 'a url target must be a plain http(s) job posting URL: no credentials, no spaces, at most 2048 characters' });
      parsed.data.target = { type: 'url', value: url || null };
    }
    // The one-check-per-company guard keys on the company target: a check naming its company only in the prompt would pass it.
    if (parsed.data.mode === 'sponsorship-check' && !(parsed.data.target.type === 'company' && parsed.data.target.value?.trim())) {
      return reply.code(400).send({ error: 'a sponsorship check needs a company target' });
    }
    const noCompanyFile = parsed.data.mode === 'sponsorship-check' ? sponsorCheckRefusal(parsed.data.target.value ?? '') : null;
    if (noCompanyFile) return reply.code(400).send({ error: noCompanyFile });
    if (!manager.effectivePolicy(parsed.data.mode)) return reply.code(404).send({ error: `unknown mode ${parsed.data.mode}` });
    if (manager.isStartingInBatch(parsed.data.mode, parsed.data.target)) return reply.code(409).send({ error: parsed.data.target.type === 'company' ? `another sponsorship check is already starting for ${parsed.data.target.value?.trim()}` : `another batch evaluate is already starting ${parsed.data.target.value}` });
    const liveId = manager.liveEvaluationFor(parsed.data.mode, parsed.data.target);
    if (liveId) return reply.code(409).send({ error: `session ${liveId} is already ${liveWorkOn(parsed.data.target)}` });
    const inboxHeld = isProcessInbox(parsed.data.mode) ? evaluationsHold() : parsed.data.target.type === 'url' && parsed.data.target.value ? processInboxHolds(parsed.data.mode, [parsed.data.target.value]) : null;
    if (inboxHeld) return reply.code(409).send({ error: `Not started: ${inboxHeld}` });
    const cvRow = tailoredCvRow(parsed.data.mode, parsed.data.target);
    const cvHeld = cvRow ? tailoredCvHolds(cvRow) : null;
    if (cvHeld) return reply.code(409).send({ error: `Not started: ${cvHeld}` });
    const refused = parsed.data.blacklistAllowed ? unlockRefused(parsed.data.mode, req.headers) : null;
    if (refused) return reply.code(403).send({ error: refused });
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, parsed.data.mode);
    if (noReplies) return reply.code(422).send({ error: noReplies });
    // An upload is stored in its canonical form, so the delete that removes it can tell every session naming it.
    if (parsed.data.target.type === 'text' && parsed.data.target.value) {
      const upload = uploadTarget(opts.cfg.dataRoot, parsed.data.target.value);
      if (upload.kind === 'refused') return reply.code(400).send({ error: upload.reason });
      if (upload.kind === 'upload') parsed.data.target = { type: 'text', value: upload.path };
    }
    if (parsed.data.target.type === 'app') {
      const row = await appRowAt(parsed.data.target.value);
      parsed.data.target = { type: 'app', value: parsed.data.target.value, ...(row ? { row } : {}) };
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
        pass = await preparePolicyPass(opts.cfg.codeRoot, opts.cfg.dataRoot);
      } catch (err) {
        const claimed = starting;
        bestEffort('release the starting AI policy pass claim', () => policyClaim.release(opts.cfg.dataRoot, claimed));
        if (err instanceof PendingUnreadableError) return reply.code(422).send({ error: err.message });
        if (err instanceof PolicyQueueBusyError) return reply.code(409).send({ error: `Not started: ${err.message}.` });
        throw err;
      }
      userPrompt = pass.prompt;
    }
    // A pass that does not start leaves no batch behind; a session that was created keeps it (dropUnheldPolicyBatch).
    const dropBatch = () => {
      if (pass) manager.dropUnheldPolicyBatch(pass.batch);
    };
    try {
      if (starting && !policyClaim.take(opts.cfg.dataRoot, starting, { batch: pass?.batch ?? null }).ok) {
        dropBatch();
        return reply.code(409).send({ error: `Not started: ${LOST_CLAIM}` });
      }
      const meta = await manager.start({ ...parsed.data, prompt: userPrompt, model: chosenModel, reportNum: null, policyBatch: pass?.batch ?? null });
      if (starting) {
        let handed: boolean;
        try {
          handed = handOver(starting, meta);
        } catch (err) {
          // The session already runs: it is cancelled as on a lost claim, so it does not bill a pass that holds no claim.
          app.log.warn({ err, sessionId: meta.id }, 'could not hand the AI policy pass claim over to its session');
          const session = manager.cancel(meta.id);
          const claimed = starting;
          bestEffort('release the starting AI policy pass claim', () => policyClaim.release(opts.cfg.dataRoot, claimed));
          releaseOnceExited(meta.id, meta.turns.at(-1)?.runId);
          return reply.code(409).send({ error: `Not started: ${claimBusy(err)}`, session });
        }
        if (!handed) return reply.code(409).send({ error: `Not started: ${LOST_CLAIM}`, session: manager.cancel(meta.id) });
      }
      return reply.code(202).send(meta);
    } catch (err) {
      const claimed = starting;
      if (claimed) bestEffort('release the starting AI policy pass claim', () => policyClaim.release(opts.cfg.dataRoot, claimed));
      dropBatch();
      if (err instanceof ModeRefusedError) return reply.code(422).send({ error: err.message });
      // Another start of the posting (here or in another server process) holds its claim, or recorded its session first.
      if (err instanceof BusyError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  const fanoutUrl = z.string().refine(plainPostingUrl, 'must be an http(s) posting URL without credentials or spaces');
  app.post<{ Body: unknown }>('/api/sessions/fanout', async (req, reply) => {
    const parsed = z.object({ mode: z.string().min(1).max(100), urls: z.array(fanoutUrl).min(1).transform((urls) => [...new Set(urls)]).pipe(z.array(z.string()).max(BATCH_MAX_URLS)), model }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (!manager.effectivePolicy(parsed.data.mode)) return reply.code(404).send({ error: `unknown mode ${parsed.data.mode}` });
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, parsed.data.mode);
    if (noReplies) return reply.code(422).send({ error: noReplies });
    // Fan-out is Batch evaluate: every other mode's start guards (Process inbox, the policy-pass claim, the one check
    // per company) live in POST /api/sessions only, so a fan-out of one would run beside the session they hold back.
    const refusal = sessionRefusal(parsed.data.mode);
    if (refusal) return reply.code(422).send({ error: refusal });
    if (!isReportGated(parsed.data.mode)) return reply.code(400).send({ error: `a fan-out only evaluates postings; ${parsed.data.mode} is not a posting evaluation mode` });
    const inboxHeld = processInboxHolds(parsed.data.mode, parsed.data.urls);
    if (inboxHeld) return reply.code(409).send({ error: `Not started: ${inboxHeld}` });
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
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, manager.read(req.params.id)?.mode ?? '');
    if (noReplies) return reply.code(422).send({ error: noReplies });
    const held = turnHeld(req.params.id, 'reply');
    if (held) return reply.code(409).send({ error: `Not continued: ${held}` });
    const busy = claimForTurn(req.params.id, `session:${req.params.id}`);
    if (busy) return reply.code(409).send({ error: busy });
    const id = req.params.id;
    const tracked = !turnsStarting.has(id);
    if (tracked) turnsStarting.add(id);
    try {
      return await mutate(reply, async () => reply.code(202).send(await manager.send(id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed })));
    } finally {
      if (tracked) turnsStarting.delete(id);
    }
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
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, manager.read(req.params.id)?.mode ?? '');
    if (noReplies) return reply.code(422).send({ error: noReplies });
    const held = turnHeld(req.params.id, 'fork');
    if (held) return reply.code(409).send({ error: `Not forked: ${held}` });
    const source = manager.read(req.params.id);
    const isPass = source?.mode === 'immigration-policy';
    // A fork continues the pass of the session it forks, taking over its claim: only a pass paused for a reply has no
    // Claude run of its own that would go on with the same items beside the fork's.
    if (isPass && source.status !== 'awaiting_user') {
      return reply.code(409).send({ error: `Not forked: this AI policy pass is ${source.status}; only a pass waiting for your reply can be forked. Start a new pass instead.` });
    }
    // It takes the claim from the paused source (and from no other live holder).
    const starting = `starting:${crypto.randomUUID()}`;
    const busy = claimForTurn(req.params.id, starting, `session:${req.params.id}`);
    if (busy) return reply.code(409).send({ error: busy });
    const giveBack = () => bestEffort('give the AI policy pass claim back to the forked session', () => policyClaim.retag(opts.cfg.dataRoot, starting, `session:${req.params.id}`));
    return mutate(reply, async () => {
      let forked;
      // The fork may wait for a cancelled source to finish before it creates the copy: the source counts as starting
      // meanwhile, so a tailored CV or Process inbox start for the same rows is refused instead of running beside it.
      const tracked = !turnsStarting.has(req.params.id);
      if (tracked) turnsStarting.add(req.params.id);
      try {
        forked = await manager.fork(req.params.id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed });
      } catch (err) {
        // The fork did not start: the claim goes back to the session it was taken from.
        if (isPass) giveBack();
        throw err;
      } finally {
        if (tracked) turnsStarting.delete(req.params.id);
      }
      if (!isPass) return reply.code(202).send(forked);
      // A fork that failed before its Claude process started leaves the pass, its claim and its batch with the source.
      if (FINAL.has(manager.read(forked.id)?.status ?? forked.status)) {
        giveBack();
        return reply.code(202).send(forked);
      }
      // The fork continues the pass, so the items it was given are acknowledged when the fork ends done. Both writes
      // run before this request yields, so the fork's turn cannot end in between; the source is paused and the claim
      // is the fork's, so it cannot run meanwhile. The fork gets the batch first: a crash between the writes leaves it
      // with both, and acknowledging a batch twice is harmless, while one with neither would send its items again.
      // The source gives its batch up only once the fork holds the claim.
      const batch = manager.read(req.params.id)?.policyBatch ?? null;
      if (batch !== null) manager.store.setPolicyBatch(forked.id, batch);
      let handed: boolean | { err: unknown };
      try {
        handed = handOver(starting, forked);
      } catch (err) {
        app.log.warn({ err, sessionId: forked.id }, 'could not hand the AI policy pass claim over to its fork');
        handed = { err };
      }
      if (handed !== true) {
        if (batch !== null) manager.store.setPolicyBatch(forked.id, null);
        const session = manager.cancel(forked.id);
        if (handed === false) return reply.code(409).send({ error: `Not forked: ${LOST_CLAIM}`, session });
        // The fork never held the pass: the claim and the batch stay with the paused source.
        giveBack();
        return reply.code(409).send({ error: `Not forked: ${claimBusy(handed.err)}`, session });
      }
      if (batch !== null) manager.store.setPolicyBatch(req.params.id, null);
      return reply.code(202).send(manager.read(forked.id) ?? forked);
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
      await manager.delete(req.params.id);
      dropUpload(meta);
      releaseOnceExited(req.params.id, meta.turns.at(-1)?.runId);
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
