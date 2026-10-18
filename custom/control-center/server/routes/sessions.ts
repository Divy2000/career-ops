import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { BusyError, liveWorkOn, ModeRefusedError, NotFoundError, OutdatedSessionError, type SessionManager } from '../claude/manager.js';
import { englishModeOf, listLaunchableModeIds, sessionRefusal } from '../claude/modes.js';
import { isReportGated } from '../claude/honesty.js';
import { sameApplication, type AppRowIdentity, type SessionMeta } from '../claude/sessions.js';
import { readPipeline } from '../domains/pipeline.js';
import { localJdPath } from '../../shared/local-jd.js';
import { dedupUrlKey } from '../../shared/dedup-url.js';
import { EXPLICIT_HEADER } from './settings.js';
import type { EventBus } from '../watch/bus.js';
import { ProfileMissingError, rememberFact } from '../domains/memory.js';
import { isLockTimeout } from '../lib/file-lock.js';
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

// expect: on a tracker row target, the application the page showed under that number (a reindex can move another one under it).
const expectedRow = z.object({ company: z.string().max(4000), role: z.string().max(4000), report: z.number().int().positive().nullable() });
const target = z.object({ type: z.enum(['app', 'url', 'company', 'text', 'none']), value: z.string().max(4000).nullable(), expect: expectedRow.optional() });
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
  // The claim lock can be held past its wait by a live claimant. One that died holding it is broken at once, unless it
  // died before naming its pid in the lock or its pid was reused: that lock counts as stale only after LOCK_STALE_MS.
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

  /**
   * A start's `starting:<nonce>` claim (invariants 5-8 in sessions.invariants.md). The request that takes one settles it
   * exactly once, from a finally: `kept` once the claim has left it (its session took it over, or another pass did),
   * else `settle` gives it back to the paused session a fork took it from (`returnTo`), or releases it.
   */
  interface StartingClaim {
    readonly owner: string;
    kept(): void;
    settle(): void;
  }
  const startingClaim = (returnTo: string | null): StartingClaim => {
    const owner = `starting:${crypto.randomUUID()}`;
    let open = true;
    return {
      owner,
      kept: () => {
        open = false;
      },
      settle: () => {
        if (!open) return;
        open = false;
        if (returnTo) bestEffort('give the AI policy pass claim back to the forked session', () => policyClaim.retag(opts.cfg.dataRoot, owner, returnTo));
        else bestEffort('release the starting AI policy pass claim', () => policyClaim.release(opts.cfg.dataRoot, owner));
      },
    };
  };
  /** Runs one step of a refused start's cleanup; a step that throws is logged and never skips the steps after it. */
  const tryStep = (what: string, fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      app.log.warn({ err }, `could not ${what}`);
    }
  };
  type Handed = { code: 202; body: SessionMeta } | { code: 409; body: { error: string; session: SessionMeta } };
  /**
   * The one way a started pass or fork reaches its answer; it never throws. The session takes the start's claim over
   * (a fork takes its source's batch with it), or it is cancelled before the request answers and the claim goes back.
   * A session that already ended before its Claude process started leaves the claim, and a fork's batch, where they were.
   */
  const handOverStarted = (claim: StartingClaim, meta: SessionMeta, verb: string, source: { id: string; batch: string | null } | null): Handed => {
    if (FINAL.has(manager.read(meta.id)?.status ?? meta.status)) return { code: 202, body: meta };
    const batch = source?.batch ?? null;
    let why: string;
    try {
      // The fork gets the batch first: a crash between the writes leaves it with both, and acknowledging a batch twice
      // is harmless, while one with neither would send its items again. The source gives it up only once the fork holds
      // the claim. No write here yields, so the fork's turn cannot end in between.
      if (batch !== null) manager.store.setPolicyBatch(meta.id, batch);
      const handed = handOver(claim.owner, meta);
      if (handed) {
        claim.kept();
        if (batch !== null) tryStep('take the policy batch off the forked session (the fork acknowledges it)', () => manager.store.setPolicyBatch(source!.id, null));
        return { code: 202, body: manager.read(meta.id) ?? meta };
      }
      // Another pass took the claim over: it is not this start's to give back.
      claim.kept();
      why = LOST_CLAIM;
    } catch (err) {
      app.log.warn({ err, sessionId: meta.id }, 'could not hand the AI policy pass claim over to its session');
      why = claimBusy(err);
    }
    // The session never held the pass: it holds no batch, and it is cancelled so it does not bill a pass with no claim.
    if (batch !== null) tryStep('take the policy batch back off a cancelled fork', () => manager.store.setPolicyBatch(meta.id, null));
    let session = meta;
    tryStep('cancel a session that does not hold the AI policy pass claim', () => {
      session = manager.cancel(meta.id);
    });
    releaseOnceExited(meta.id, meta.turns.at(-1)?.runId);
    return { code: 409, body: { error: `${verb}: ${why}`, session } };
  };
  /** Marks a session's next turn (or a fork of it) as starting while `fn` runs, so the holds count it as live (invariant 4). */
  const whileStarting = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    const tracked = !turnsStarting.has(id);
    if (tracked) turnsStarting.add(id);
    try {
      return await fn();
    } finally {
      if (tracked) turnsStarting.delete(id);
    }
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
   * each other's reply for good), and never by its own session. `pin` is the application the new turn is for: a session
   * pinned to a different one (the row a reindex moved off the number) does not hold it; one with no pin, or a turn whose
   * application cannot be told, is held.
   */
  const tailoredCvHolds = (row: string, pin: AppRowIdentity | undefined, own: { meta: SessionMeta; kind: 'reply' | 'fork' } | null = null): string | null => {
    const holds = (m: SessionMeta) => own?.meta.status !== 'awaiting_user' || m.status !== 'awaiting_user' || turnsStarting.has(m.id);
    const otherApplication = (m: SessionMeta) => pin !== undefined && m.target.row !== undefined && !sameApplication(pin, m.target.row);
    const live = liveOrStarting().find((m) => tailoredCvRow(m.mode, m.target) === row && !(own?.kind === 'reply' && m.id === own.meta.id) && !otherApplication(m) && holds(m));
    return live ? `session ${live.id} is already generating the tailored CV for tracker row #${row}. Open it instead.` : null;
  };
  /** The 409 reason a reply or fork is refused with when it would carry on Process inbox or an evaluation over the same pending rows, or null. */
  const turnHeld = (id: string, kind: 'reply' | 'fork'): string | null => {
    const meta = manager.read(id);
    if (!meta) return null;
    if (isProcessInbox(meta.mode)) return evaluationsHold(meta);
    const cvRow = tailoredCvRow(meta.mode, meta.target);
    if (cvRow) return tailoredCvHolds(cvRow, meta.target.row, { meta, kind });
    return meta.target.type === 'url' && meta.target.value ? processInboxHolds(meta.mode, [meta.target.value]) : null;
  };

  type Refusal = { code: number; error: string };
  /** The refusal every new session of `mode` gets before anything is claimed or prepared: an unknown mode, or one that cannot run now. */
  const modeRefused = (mode: string): Refusal | null => {
    if (!manager.effectivePolicy(mode)) return { code: 404, error: `unknown mode ${mode}` };
    const refusal = sessionRefusal(mode);
    if (refusal) return { code: 422, error: refusal };
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, mode);
    return noReplies ? { code: 422, error: noReplies } : null;
  };
  /**
   * Null when a new session of `mode` on `target` may start, else the 409 the start is refused with: duplicate paid work
   * (invariant 4). Synchronous, and the caller creates the session in the same tick (invariant 2).
   */
  const admitNew = (mode: string, target: SessionMeta['target'], pin: AppRowIdentity | undefined): Refusal | null => {
    if (manager.isStartingInBatch(mode, target)) return { code: 409, error: target.type === 'company' ? `another sponsorship check is already starting for ${target.value?.trim()}` : `another batch evaluate is already starting ${target.value}` };
    const liveId = manager.liveEvaluationFor(mode, target);
    if (liveId) return { code: 409, error: `session ${liveId} is already ${liveWorkOn(target)}` };
    const inboxHeld = isProcessInbox(mode) ? evaluationsHold() : target.type === 'url' && target.value ? processInboxHolds(mode, [target.value]) : null;
    if (inboxHeld) return { code: 409, error: `Not started: ${inboxHeld}` };
    const cvRow = tailoredCvRow(mode, target);
    const cvHeld = cvRow ? tailoredCvHolds(cvRow, pin) : null;
    return cvHeld ? { code: 409, error: `Not started: ${cvHeld}` } : null;
  };
  /**
   * Null when a reply to or fork of session `id` may run, else its refusal; the caller marks the session starting
   * (whileStarting) in the same tick.
   */
  const admitTurn = (id: string, kind: 'reply' | 'fork', blacklistAllowed: boolean | undefined, headers: Record<string, unknown>): Refusal | null => {
    // A fork's first turn is a turn like any other: the same explicit unlock gate as a reply.
    if (blacklistAllowed) {
      const meta = manager.read(id);
      if (!meta) return { code: 404, error: 'no such session' };
      const refused = unlockRefused(meta.mode, headers);
      if (refused) return { code: 403, error: refused };
    }
    const noReplies = replyWatchSessionRefused(opts.cfg.dataRoot, manager.read(id)?.mode ?? '');
    if (noReplies) return { code: 422, error: noReplies };
    const held = turnHeld(id, kind);
    return held ? { code: 409, error: `${kind === 'reply' ? 'Not continued' : 'Not forked'}: ${held}` } : null;
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
    const { mode } = parsed.data;
    // The expected application is a check on the row the start pins, never part of the stored target.
    const { expect: expectRow, ...plainTarget } = parsed.data.target;
    if (expectRow && plainTarget.type !== 'app') return reply.code(400).send({ error: 'only a tracker row target can name the application it expects' });
    parsed.data.target = plainTarget;
    // A URL target reaches the session's prompt, so it is held to the fan-out's posting URL rule.
    // Every later use (duplicate checks, inbox holds, the stored target) sees the trimmed value; a blank one names no URL.
    if (parsed.data.target.type === 'url' && parsed.data.target.value !== null) {
      const url = parsed.data.target.value.trim();
      if (url && !plainPostingUrl(url)) return reply.code(400).send({ error: 'a url target must be a plain http(s) job posting URL: no credentials, no spaces, at most 2048 characters' });
      parsed.data.target = { type: 'url', value: url || null };
    }
    // The one-check-per-company guard keys on the company target: a check naming its company only in the prompt would pass it.
    if (mode === 'sponsorship-check' && !(parsed.data.target.type === 'company' && parsed.data.target.value?.trim())) {
      return reply.code(400).send({ error: 'a sponsorship check needs a company target' });
    }
    const noCompanyFile = mode === 'sponsorship-check' ? sponsorCheckRefusal(parsed.data.target.value ?? '') : null;
    if (noCompanyFile) return reply.code(400).send({ error: noCompanyFile });
    const modeRefusal = modeRefused(mode);
    if (modeRefusal) return reply.code(modeRefusal.code).send({ error: modeRefusal.error });
    const refused = parsed.data.blacklistAllowed ? unlockRefused(mode, req.headers) : null;
    if (refused) return reply.code(403).send({ error: refused });
    // An upload is stored in its canonical form, so the delete that removes it can tell every session naming it.
    if (parsed.data.target.type === 'text' && parsed.data.target.value) {
      const upload = uploadTarget(opts.cfg.dataRoot, parsed.data.target.value);
      if (upload.kind === 'refused') return reply.code(400).send({ error: upload.reason });
      if (upload.kind === 'upload') parsed.data.target = { type: 'text', value: upload.path };
    }
    // Everything the start awaits is read here, before the checks that admit it (invariant 2). The row an app session
    // is for comes first: the tailored CV hold goes by it.
    let pin: AppRowIdentity | undefined;
    if (parsed.data.target.type === 'app') {
      pin = (await appRowAt(parsed.data.target.value)) ?? undefined;
      parsed.data.target = { type: 'app', value: parsed.data.target.value, ...(pin ? { row: pin } : {}) };
      // A row number is reused after a reindex: a start naming the application it expects runs only on that one.
      if (expectRow && !(pin && sameApplication(pin, expectRow))) {
        const now = pin ? `now holds ${pin.company} (${pin.role})` : 'holds no single row any more';
        return reply.code(409).send({ error: `Not started: tracker row #${parsed.data.target.value?.trim()} ${now}, not ${expectRow.company} (${expectRow.role}). Reload the page.` });
      }
    }
    const chosenModel = sessionModel(opts.cfg.dataRoot, parsed.data.model);
    let userPrompt = promptWithTarget(parsed.data.prompt, parsed.data.target);
    // projects-ingest runs no command: the app extracts its documents/ source (as intake does) and the text rides in the first message.
    if (mode === 'projects-ingest') {
      const doc = parsed.data.target.type === 'text' && parsed.data.target.value ? await extractSourceText(opts.cfg.codeRoot, opts.cfg.dataRoot, parsed.data.target.value) : { ok: false as const, error: 'projects-ingest needs the documents/ path of the source as its target' };
      if (!doc.ok) return reply.code(422).send({ error: doc.error });
      userPrompt = `${userPrompt}\n\n<document source="documents/${doc.rel}">\n${doc.text.replace(/<\/document/gi, '<\\/document')}\n</document>`;
    }
    // The policy pass runs as run-daily.sh runs it: daily-prompt.md filled in with the queued official items (the
    // client's prompt only asks for the pass), and the batch of those items is acknowledged when the pass is done.
    // One pass at a time: two take the same queued items (acknowledged only when one ends done) and both append the
    // same rows to policy-changes.tsv and company-alerts.tsv and a digest section. The daily job runs a pass too, and one
    // the app queued has neither its lock nor the claim yet.
    const isPass = mode === 'immigration-policy';
    if (isPass && ((await opts.daily?.runningNow()) || opts.dailyPending?.())) return reply.code(409).send({ error: 'The daily job is running or about to, and it runs the AI policy pass itself. Try again once it finishes.' });
    const claim = isPass ? startingClaim(null) : null;
    if (claim) {
      const claimed = policyClaim.take(opts.cfg.dataRoot, claim.owner);
      if (!claimed.ok) {
        claim.kept();
        return reply.code(409).send({ error: `Not started: ${claimHolderText(claimed.holder.owner)}. Try again once it finishes.` });
      }
    }
    let pass: PolicyPass | null = null;
    // A pass that does not start leaves no batch behind; a session that was created keeps it (dropUnheldPolicyBatch).
    let started = false;
    try {
      if (claim) {
        try {
          pass = await preparePolicyPass(opts.cfg.codeRoot, opts.cfg.dataRoot);
        } catch (err) {
          if (err instanceof PendingUnreadableError) return reply.code(422).send({ error: err.message });
          if (err instanceof PolicyQueueBusyError) return reply.code(409).send({ error: `Not started: ${err.message}.` });
          throw err;
        }
        userPrompt = pass.prompt;
      }
      // From here to the session's create nothing awaits: the checks and the create run in one tick (invariant 2).
      const held = admitNew(mode, parsed.data.target, pin);
      if (held) return reply.code(held.code).send({ error: held.error });
      if (claim && !policyClaim.take(opts.cfg.dataRoot, claim.owner, { batch: pass?.batch ?? null }).ok) {
        claim.kept();
        return reply.code(409).send({ error: `Not started: ${LOST_CLAIM}` });
      }
      const meta = await manager.start({ ...parsed.data, prompt: userPrompt, model: chosenModel, reportNum: null, policyBatch: pass?.batch ?? null });
      started = true;
      if (!claim) return reply.code(202).send(meta);
      const out = handOverStarted(claim, meta, 'Not started', null);
      return reply.code(out.code).send(out.body);
    } catch (err) {
      if (err instanceof ModeRefusedError) return reply.code(422).send({ error: err.message });
      // Another start of the posting (here or in another server process) holds its claim, or recorded its session first.
      if (err instanceof BusyError) return reply.code(409).send({ error: err.message });
      throw err;
    } finally {
      claim?.settle();
      if (pass && !started) manager.dropUnheldPolicyBatch(pass.batch);
    }
  });

  const fanoutUrl = z.string().refine(plainPostingUrl, 'must be an http(s) posting URL without credentials or spaces');
  app.post<{ Body: unknown }>('/api/sessions/fanout', async (req, reply) => {
    const parsed = z.object({ mode: z.string().min(1).max(100), urls: z.array(fanoutUrl).min(1).transform((urls) => [...new Set(urls)]).pipe(z.array(z.string()).max(BATCH_MAX_URLS)), model }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const modeRefusal = modeRefused(parsed.data.mode);
    if (modeRefusal) return reply.code(modeRefusal.code).send({ error: modeRefusal.error });
    // Fan-out is Batch evaluate: every other mode's start guards (Process inbox, the policy-pass claim, the one check
    // per company) are in POST /api/sessions only, so a fan-out of one would run beside the session they hold back.
    if (!isReportGated(parsed.data.mode)) return reply.code(400).send({ error: `a fan-out only evaluates postings; ${parsed.data.mode} is not a posting evaluation mode` });
    // The manager claims each posting before its first await, so this check and those claims run in one tick.
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
    const id = req.params.id;
    const refused = admitTurn(id, 'reply', parsed.data.blacklistAllowed, req.headers);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    const busy = claimForTurn(id, `session:${id}`);
    if (busy) return reply.code(409).send({ error: busy });
    return whileStarting(id, () => mutate(reply, async () => reply.code(202).send(await manager.send(id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed }))));
  });

  app.post<{ Params: { id: string }; Body: unknown }>('/api/sessions/:id/fork', async (req, reply) => {
    const parsed = z.object({ prompt, blacklistAllowed: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const id = req.params.id;
    const refused = admitTurn(id, 'fork', parsed.data.blacklistAllowed, req.headers);
    if (refused) return reply.code(refused.code).send({ error: refused.error });
    const source = manager.read(id);
    const isPass = source?.mode === 'immigration-policy';
    // A fork continues the pass of the session it forks, taking over its claim: only a pass paused for a reply has no
    // Claude run of its own that would go on with the same items beside the fork's.
    if (isPass && source.status !== 'awaiting_user') {
      return reply.code(409).send({ error: `Not forked: this AI policy pass is ${source.status}; only a pass waiting for your reply can be forked. Start a new pass instead.` });
    }
    // It takes the claim from the paused source (and from no other live holder), and gives it back unless the fork takes it over.
    const claim = isPass ? startingClaim(`session:${id}`) : null;
    if (claim) {
      const busy = claimForTurn(id, claim.owner, `session:${id}`);
      if (busy) {
        claim.kept();
        return reply.code(409).send({ error: busy });
      }
    }
    try {
      return await mutate(reply, async () => {
        // The fork may wait for a cancelled source to finish before it creates the copy: the source counts as starting
        // meanwhile, so a tailored CV or Process inbox start for the same rows is refused instead of running beside it.
        const forked = await whileStarting(id, () => manager.fork(id, parsed.data.prompt, { blacklistAllowed: parsed.data.blacklistAllowed }));
        if (!claim) return reply.code(202).send(forked);
        // The fork continues the pass, so the items it was given are acknowledged when the fork ends done.
        const out = handOverStarted(claim, forked, 'Not forked', { id, batch: manager.read(id)?.policyBatch ?? null });
        return reply.code(out.code).send(out.body);
      });
    } finally {
      claim?.settle();
    }
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
      return { result: await rememberFact(opts.cfg.codeRoot, opts.cfg.dataRoot, parsed.data.fact) };
    } catch (err) {
      if (err instanceof ProfileMissingError) return reply.code(409).send({ error: err.message });
      // A lock held too long is a 503 busy with retry-after, as on the user-file editor save of the same file.
      if (isLockTimeout(err)) return reply.code(503).header('retry-after', '1').send({ error: 'modes/_profile.md is busy (another save is writing it), try again in a moment' });
      throw err;
    }
  });
}
