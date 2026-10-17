// Session manager (spec 4.1 to 4.3): every Claude turn is a detached run
// through the runner (Claude slot cap applies), the Keychain token is read at
// spawn and only ever lives in the child's env, stdout is normalized into
// events.ndjson, and the honesty gate decides done / awaiting_user.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ServerConfig } from '../config.js';
import { pidAlive, type Runner } from '../runner/runner.js';
import type { RawLine, RunMeta } from '../runner/store.js';
import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import { cliScriptPath, CONTRACT } from '../core/adapter.js';
import { conversationStarted, SessionStore, type SessionMeta, type StoredEvent } from './sessions.js';
import { StreamParser, type SessionEvent } from './stream-parse.js';
import { assertRootsConfinable, buildArgv, buildEnv, buildPermissions, buildPreamble, redact, toolResultsDirs, transcriptFiles, writePolicyFile, writeSettingsFile } from './invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, SESSION_POLICY_VERSION, getModePolicy, sessionRefusal, type ModePolicy, type PolicyClass } from './modes.js';
import { assertApprovedClaude } from './cli-version.js';
import { decideTurnOutcome, detectNewReports, isReportGated, ownReports, snapshotReports, type NewReport } from './honesty.js';
import { reportNumberOf } from '../domains/reports.js';
import { markPipelineEvaluated } from '../domains/pipelineProcessed.js';
import { localJdPath } from '../../shared/local-jd.js';
import { dedupUrlKey } from '../../shared/dedup-url.js';
import { sponsorCheckCompany } from '../../shared/company-slug.js';
import { recordTurnAfter } from '../../supervisor/recovery.js';
import { ackPolicyPass, donePolicyBatches, dropPolicyBatch, dropUnreadablePolicyBatch, forgetDonePolicyBatch, policyBatchReadable, recordDonePolicyBatch } from '../domains/policyPass.js';
import { beginTakingReportNums, unrecordedFor } from '../actions/registry.js';

export type TokenReader = () => Promise<string>;

/** A report-number release that fails (the tracker lock busy) is tried this many times, waiting longer each time. */
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_MS = 250;
/** How long a turn that failed after its run started waits for that stopped run to end before giving its number back. */
const RUN_END_WAIT_MS = 10_000;
/** A running turn's reservation sentinel older than this is refreshed: well inside the stale GC's four hours. */
const RESERVATION_REFRESH_AGE_MS = 60 * 60_000;
/** Releases or refreshes a sentinel only while it is still the session's, under the tracker lock (run as a child, never loaded here). */
const RESERVATION_SENTINEL_SCRIPT = fileURLToPath(new URL('./reservation-sentinel.mjs', import.meta.url));
/** A done pass whose ack failed is acknowledged again after this delay, doubling up to the cap while it keeps failing. */
const POLICY_ACK_RETRY_MS = 60_000;
const POLICY_ACK_RETRY_CAP_MS = 30 * 60_000;

const KEYCHAIN_HELP = 'Keychain item career-ops-claude-token not found. Run: claude setup-token, then security add-generic-password -U -a "$USER" -s career-ops-claude-token -w';
/** errSecItemNotFound: the only `security find-generic-password` exit that means the item is absent (as supervisor/preflight.ts reads it). */
const SECURITY_ITEM_NOT_FOUND = 44;
const KEYCHAIN_TIMEOUT_MS = 5000;

function keychainUnreadable(why: string): string {
  return `Could not read Keychain item career-ops-claude-token: ${why}. The login keychain is probably locked or cannot prompt (for example over SSH or before login). Unlock it with: security unlock-keychain, then retry.`;
}

/**
 * Reads the OAuth token from the Keychain at spawn time; the value never leaves the process except into the child's env.
 * Only an absent (exit 44) or empty token asks for a new one: any other failure (a locked keychain, no UI to prompt, a
 * timeout, no security command) leaves a stored token that is fine.
 */
export function keychainTokenReader(exec: Exec): TokenReader {
  return async () => {
    if (process.env.NODE_ENV === 'test' && process.env.CC_FAKE_TOKEN) return process.env.CC_FAKE_TOKEN;
    const r = await exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'], { timeoutMs: KEYCHAIN_TIMEOUT_MS });
    if (r.timedOut) throw new Error(keychainUnreadable(`security timed out after ${KEYCHAIN_TIMEOUT_MS / 1000}s`));
    if (r.code === SECURITY_ITEM_NOT_FOUND) throw new Error(KEYCHAIN_HELP);
    // execNoShell's note for a command it could not spawn (ENOENT).
    if (r.code !== 0 && /(?:^|\n)security: not found$/.test(r.stderr.trim())) throw new Error('Could not read Keychain item career-ops-claude-token: the security command was not found on PATH (it ships with macOS in /usr/bin).');
    if (r.code !== 0) throw new Error(keychainUnreadable(`security failed (exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-200)}` : ''})`));
    if (!r.stdout.trim()) throw new Error(KEYCHAIN_HELP);
    return r.stdout.trim();
  };
}

export function readOutputLanguage(dataRoot: string): string {
  try {
    const doc = YAML.parse(fs.readFileSync(path.join(dataRoot, 'config', 'profile.yml'), 'utf8')) as { language?: { output?: unknown } } | null;
    const out = doc?.language?.output;
    return typeof out === 'string' && out.trim() ? out.trim() : 'en';
  } catch {
    return 'en';
  }
}

export function evaluatePrompt(url: string): string {
  return `Evaluate this job posting following the mode file: ${url}`;
}

export interface StartInput {
  mode: string;
  target: SessionMeta['target'];
  prompt: string;
  model?: string | null;
  reportNum?: number | null;
  /** The immigration policy pass's batch file (see domains/policyPass.ts), acknowledged when a turn ends done. */
  policyBatch?: string | null;
  blacklistAllowed?: boolean;
}

interface TurnState {
  beforeReports: string[];
  filesOffset: number;
  /** The turn resumed a conversation; absent in turns started before it was recorded, which go by their number. */
  resumed?: boolean;
}

interface Tracked {
  timer: NodeJS.Timeout;
}

/** How far into a turn's raw log the transcript got, so a restarted server resumes instead of replaying. */
interface TurnProgress {
  rawSeq: number;
  rawOffset: number;
}

/** How old a progress temp file of a live process may get before it counts as left behind (a save takes milliseconds). */
const PROGRESS_TMP_STALE_MS = 10 * 60_000;

/**
 * A save that died between its write and its rename leaves its temp file; each has its own name, so none is ever reused.
 * Housekeeping only: a sweep that fails is warned of and never fails the turn reading its progress.
 */
function sweepProgressTemps(file: string): void {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp-`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[sessions] could not list ${dir} to sweep left-behind progress files: ${(err as Error).message}`);
    return;
  }
  for (const name of names) {
    const m = name.startsWith(prefix) ? /^(\d+)-[0-9a-f]+$/.exec(name.slice(prefix.length)) : null;
    if (!m) continue;
    const tmp = path.join(dir, name);
    try {
      if (pidAlive(Number(m[1])) && Date.now() - fs.statSync(tmp).mtimeMs < PROGRESS_TMP_STALE_MS) continue;
      fs.rmSync(tmp, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[sessions] could not remove the left-behind progress file ${tmp}: ${(err as Error).message}`);
    }
  }
}

export function readProgress(file: string): TurnProgress | null {
  sweepProgressTemps(file);
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TurnProgress>;
    return typeof p.rawSeq === 'number' && typeof p.rawOffset === 'number' ? { rawSeq: p.rawSeq, rawOffset: p.rawOffset } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A temp name of its own, so a blue/green peer saving the same turn never writes into or renames away this one's. */
export function writeProgress(file: string, p: TurnProgress): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(p));
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanup) {
      // The save's own failure is what the caller acts on; a later read sweeps this temp file.
      console.warn(`[sessions] could not remove the progress temp file ${tmp}: ${(cleanup as Error).message}`);
    }
    throw err;
  }
}

export interface ManagerDeps {
  readToken: TokenReader;
  exec: Exec;
  pollMs?: number;
  playwrightAvailable?: boolean;
  /** The home directory a root may not be or contain (tests point it at a temp root). */
  home?: string;
  /** The first delay before a failed policy-pass ack is tried again (POLICY_ACK_RETRY_MS by default). */
  policyAckRetryMs?: number;
}

export class SessionManager {
  readonly store: SessionStore;
  private listeners = new Set<(sessionId: string, ev: StoredEvent) => void>();
  private active = new Map<string, Tracked>();
  /** Sessions whose next turn is being prepared (before beginTurn marks them running). */
  private sending = new Set<string>();
  /** Reservation warnings already given (a session and number, or a session's refresh failure): the tracker ticks every poll. */
  private reservationWarned = new Set<string>();
  /** Sessions whose sentinel refresh is running: a tick does not start another while one waits for the tracker lock. */
  private refreshing = new Set<string>();
  /** The postings (evaluation class and postingKey) a fan-out or a replayed original request is starting right now, before their runs exist. */
  private fanningOut = new Set<string>();
  /** Sessions cancelled while their first turn prepares (queued, no turn yet): the turn stops before it spawns. */
  private cancelledBeforeSpawn = new Set<string>();
  /** Sessions whose own turn is being prepared and not yet spawned (`sending` also holds a fork's source). */
  private preparing = new Set<string>();
  readonly playwrightAvailable: boolean;
  /** The pending retry of the policy-pass acks that failed, and the delay the next one waits. */
  private policyAckTimer: NodeJS.Timeout | null = null;
  private policyAckDelay: number;
  private policyAcksInFlight = new Set<string>();
  private closed = false;

  constructor(
    private cfg: ServerConfig,
    private runner: Runner,
    private bus: EventBus,
    private deps: ManagerDeps,
  ) {
    this.store = new SessionStore(cfg.dataRoot, cfg.guardRoot);
    this.playwrightAvailable = deps.playwrightAvailable ?? CONTRACT.playwrightMcp.probed === true;
    this.policyAckDelay = deps.policyAckRetryMs ?? POLICY_ACK_RETRY_MS;
  }

  onEvent(cb: (sessionId: string, ev: StoredEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  list(opts: { strict?: boolean } = {}): SessionMeta[] {
    return this.store.list(opts);
  }

  read(id: string): SessionMeta | null {
    try {
      return this.store.read(id);
    } catch {
      return null;
    }
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** Policy actually granted: the apply class loses Playwright when the MCP launch was never probed. */
  effectivePolicy(mode: string): ModePolicy | null {
    const p = getModePolicy(mode);
    if (!p) return null;
    if (p.mcp === 'playwright' && !this.playwrightAvailable) {
      const { mcp: _mcp, ...rest } = p;
      return rest;
    }
    return p;
  }

  /** The policy a new turn runs under; a mode that never runs as a session is refused with its reason. */
  private turnPolicy(mode: string): ModePolicy {
    const refused = sessionRefusal(mode);
    if (refused) throw new ModeRefusedError(refused);
    const policy = this.effectivePolicy(mode);
    if (!policy) throw new Error(`unknown mode ${mode}`);
    return policy;
  }

  /** `onCreated` hears of the session as soon as it is recorded, so a caller can settle it if the start then throws. */
  async start(input: StartInput, onCreated?: (meta: SessionMeta) => void): Promise<SessionMeta> {
    const policy = this.turnPolicy(input.mode);
    const meta = this.store.create({ mode: input.mode, policyClass: policy.policyClass, target: input.target, model: input.model ?? null, reportNum: input.reportNum ?? null, policyBatch: input.policyBatch ?? null });
    onCreated?.(meta);
    return this.runTurn(meta, policy, input.prompt, { resume: false, fork: false, blacklistAllowed: input.blacklistAllowed, original: true });
  }

  /** True while a batch evaluate is starting this posting: a single start of it would write a second report and row. */
  isStartingInBatch(mode: string, target: SessionMeta['target']): boolean {
    const key = postingKey(mode, target);
    return key !== null && this.fanningOut.has(`${evaluationClass(mode)}\0${key}`);
  }

  /** Id of a live session of this mode's evaluation class already evaluating this posting, if any: a second start would write a second report. */
  liveEvaluationFor(mode: string, target: SessionMeta['target'], exceptId?: string): string | null {
    const key = postingKey(mode, target);
    if (key === null) return null;
    const cls = evaluationClass(mode);
    for (const m of this.store.list()) {
      if (m.id !== exceptId && evaluationClass(m.mode) === cls && this.isLive(m) && postingKey(m.mode, m.target) === key) return m.id;
    }
    return null;
  }

  /** Live, or a cancelled turn still stopping (its process lives until SIGKILL) or finalizing: it may yet write its report. */
  private isLive(m: SessionMeta): boolean {
    return LIVE_STATUSES.has(m.status) || this.active.has(m.id);
  }

  async send(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const meta = this.must(id);
    assertCurrentPolicy(meta);
    const policy = this.turnPolicy(meta.mode);
    // Checked and claimed synchronously: two requests racing past the token read would run two `claude --resume` on one session.
    this.assertIdle(meta);
    this.sending.add(id);
    try {
      // A fork that never reported its own Claude id (even one whose first turn never started) forks the source again;
      // it must never start a fresh conversation under the source's id or append to it.
      const forkPending = meta.forkPending === true;
      const resume = this.hasConversation(meta) || forkPending;
      // A resumed evaluation that still owes its report evaluates the posting again, as a replayed request does, and a
      // resumed sponsorship check writes its company's files again: refused beside another live session doing the same.
      const unclaim = !resume || owesReport(meta) || meta.mode === 'sponsorship-check' ? this.claimReplay(meta) : () => {};
      try {
        return await this.runTurn(meta, policy, resume ? prompt : this.withOriginalRequest(meta, prompt), { resume, fork: forkPending, blacklistAllowed: opts.blacklistAllowed });
      } finally {
        unclaim();
      }
    } finally {
      this.sending.delete(id);
    }
  }

  async fork(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const first = this.must(id);
    assertCurrentPolicy(first);
    const policy = this.turnPolicy(first.mode);
    // A source with a turn starting or running would get a second paid run beside it, on the conversation it is writing.
    this.assertIdle(first, { finishing: false });
    this.sending.add(id);
    try {
      // A cancelled turn still stopping may yet start the conversation, or write the report a replayed request would.
      await this.untilFinished(id);
      const src = this.must(id);
      // A source whose turns never started a conversation has nothing to fork: the copy starts its own.
      if (!this.hasConversation(src)) {
        // Not excluded from the check: a source still waiting for the user evaluates the posting beside the copy.
        const unclaim = this.claimReplay(src, null);
        try {
          const fresh = this.store.create({ mode: src.mode, policyClass: src.policyClass, target: src.target, model: src.model, forkedFrom: src.id });
          return await this.runTurn(fresh, policy, this.withOriginalRequest(src, prompt), { resume: false, fork: false, blacklistAllowed: opts.blacklistAllowed, original: true });
        } finally {
          unclaim();
        }
      }
      // A copy of an evaluation that still owes its report writes one of its own, and a copy of a sponsorship check
      // writes its company's files again: refused beside any live session doing the same, the source included while it
      // waits for the user.
      const unclaim = owesReport(src) || src.mode === 'sponsorship-check' ? this.claimReplay(src, null) : () => {};
      try {
        const forked = this.store.fork(id);
        return await this.runTurn(forked, policy, prompt, { resume: true, fork: true, blacklistAllowed: opts.blacklistAllowed });
      } finally {
        unclaim();
      }
    } finally {
      this.sending.delete(id);
    }
  }

  /**
   * Refuses a session with a turn being prepared or running, and (unless `finishing` is false) one whose ended turn is
   * still finishing (its process may live until SIGKILL, and its finalize is still to run).
   */
  private assertIdle(meta: SessionMeta, opts: { finishing?: boolean } = {}): void {
    if (this.sending.has(meta.id)) throw new BusyError(`session ${meta.id} is starting a turn`);
    if (meta.status === 'running' || meta.status === 'queued') throw new BusyError(`session ${meta.id} is ${meta.status}`);
    // A cancelled turn's run may still be stopping (its Claude process lives until SIGKILL) or finalizing: a new turn now
    // would run a second claude --resume on the same conversation and let the old turn's finalize overwrite this one's.
    if (opts.finishing !== false && this.active.has(meta.id)) throw new BusyError(`session ${meta.id} is still finishing its previous turn`);
  }

  /** Waits (up to RUN_END_WAIT_MS) for a session's ended turn to finish stopping and finalizing; refused when it does not. */
  private async untilFinished(id: string): Promise<void> {
    const deadline = Date.now() + RUN_END_WAIT_MS;
    while (this.active.has(id)) {
      if (Date.now() > deadline) throw new BusyError(`session ${id} is still finishing its previous turn`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * A replayed original request starts the posting's evaluation again: refused while another session evaluates it, and
   * claimed (as a starting fan-out claims its URLs) until its turn is running, so no start slips in while it prepares.
   * `exceptId` is the session doing the replay, which does not count against itself. Returns the release.
   */
  private claimReplay(meta: SessionMeta, exceptId: string | null = meta.id): () => void {
    if (this.isStartingInBatch(meta.mode, meta.target)) throw new BusyError(meta.target.type === 'company' ? `another sponsorship check is already starting for ${meta.target.value?.trim()}` : `another evaluation is already starting ${meta.target.value}`);
    const live = this.liveEvaluationFor(meta.mode, meta.target, exceptId ?? undefined);
    if (live) throw new BusyError(`session ${live} is already ${liveWorkOn(meta.target)}`);
    const posting = postingKey(meta.mode, meta.target);
    if (posting === null) return () => {};
    const key = `${evaluationClass(meta.mode)}\0${posting}`;
    this.fanningOut.add(key);
    return () => this.fanningOut.delete(key);
  }

  /** Parallel evaluations: reserve N report numbers first, hand each session its number in the preamble. */
  async fanOut(input: { mode: string; urls: string[]; model?: string | null }): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
    this.turnPolicy(input.mode);
    // A second evaluation of a posting a live session of the mode's class evaluates (one waiting for the user's reply
    // too: the reply finishes it), or another fan-out is starting, would write a second report and tracker row for it.
    const cls = evaluationClass(input.mode);
    const key = (url: string) => `${cls}\0${postingKey(input.mode, { type: 'url', value: url })}`;
    const live = new Map<string, string>();
    for (const m of this.store.list()) if (evaluationClass(m.mode) === cls && m.target.type === 'url' && m.target.value && this.isLive(m)) live.set(key(m.target.value), m.id);
    const refused: SessionMeta[] = [];
    const urls: string[] = [];
    // Two spellings of one posting in this batch (a tracking param, a trailing slash) are one evaluation: the first starts.
    const batch = new Map<string, string>();
    for (const url of input.urls) {
      const holder = live.get(key(url));
      const twin = batch.get(key(url));
      const why = holder ? `not started: session ${holder} is already evaluating ${url}` : twin ? `not started: ${twin} in this batch is the same posting` : this.fanningOut.has(key(url)) ? `not started: another batch evaluate is starting ${url}` : null;
      if (why) refused.push(unstartedMeta(input.mode, { type: 'url', value: url }, input.model ?? null, why));
      else {
        urls.push(url);
        batch.set(key(url), url);
      }
    }
    if (urls.length === 0) return { sessions: refused, reserved: [] };
    for (const url of urls) this.fanningOut.add(key(url));
    try {
      // The i-th reserved number goes to the i-th session, so the refused ones come after the started ones.
      const out = await this.startFanOut({ ...input, urls });
      return { sessions: [...out.sessions, ...refused], reserved: out.reserved };
    } finally {
      for (const url of urls) this.fanningOut.delete(key(url));
    }
  }

  private async startFanOut(input: { mode: string; urls: string[]; model?: string | null }): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
    const { r, nums: reserved } = await this.takeReportNums(input.urls.length);
    const sessions: SessionMeta[] = [];
    const handed = new Set<number>();
    try {
      if (r.code !== 0) throw new Error(`reserve-report-num failed (exit ${r.code}): ${r.stderr.trim().slice(-400)}`);
      if (reserved.length !== input.urls.length) throw new Error(`reserve-report-num returned ${reserved.length} numbers for ${input.urls.length} postings: ${r.stdout.trim()}`);
      for (const [i, url] of input.urls.entries()) {
        const num = reserved[i]!;
        const target = { type: 'url' as const, value: url };
        let created: SessionMeta | null = null;
        const recorded = (m: SessionMeta) => {
          created = m;
          this.recordedReportNums([num]);
        };
        try {
          sessions.push(await this.start({ mode: input.mode, target, prompt: evaluatePrompt(url), model: input.model ?? null, reportNum: num }, recorded));
          handed.add(num);
        } catch (err) {
          // One URL that cannot start must not hide the ones that did: the caller keeps only the failed URLs for a retry.
          const message = (err as Error).message;
          const recorded = created as SessionMeta | null;
          if (recorded && err instanceof TurnStartedError) {
            // Settled by the turn itself: the number was released, or is still the session's while its run may write.
            handed.add(num);
            sessions.push(this.read(recorded.id) ?? { ...recorded, status: 'error', error: message, lastReason: message });
          } else if (recorded) {
            // The session holds the number now and releases it as a first turn that cannot start does.
            handed.add(num);
            sessions.push(await this.failBeforeSpawn(recorded, message));
          } else {
            sessions.push(unstartedMeta(input.mode, target, input.model ?? null, message));
          }
        }
      }
    } finally {
      // A session releases its own number; the ones never handed to a session go straight back to the pool.
      // Each one leaves the unrecorded set before it is released, never after: a later reservation may take it again.
      for (const num of reserved) {
        if (handed.has(num)) continue;
        this.recordedReportNums([num]);
        await this.releaseReportNum(num, false);
      }
    }
    return { sessions, reserved };
  }

  /**
   * Runs reserve-report-num.mjs --count; the numbers it took stay in unrecordedReportNums until the caller passes
   * them to recordedReportNums, once a session record holds them or they went back to the pool.
   */
  private async takeReportNums(count: number): Promise<{ r: Awaited<ReturnType<Exec>>; nums: number[] }> {
    const unrecorded = await beginTakingReportNums(this.cfg.dataRoot);
    try {
      const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--count', String(count)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
      const nums = r.code === 0 ? parseReservedRange(r.stdout) : [];
      for (const num of nums) unrecorded.nums.add(num);
      return { r, nums };
    } finally {
      unrecorded.taking -= 1;
    }
  }

  private recordedReportNums(nums: number[]): void {
    const unrecorded = unrecordedFor(this.cfg.dataRoot);
    for (const num of nums) unrecorded.nums.delete(num);
  }

  cancel(id: string): SessionMeta {
    const meta = this.must(id);
    const turn = meta.turns.at(-1);
    if (this.preparing.has(id)) {
      // A turn still preparing (the CLI version probe, a later turn's re-reservation, the Keychain read) ends before
      // Claude is spawned.
      if (this.cancelledBeforeSpawn.has(id)) return meta;
      this.cancelledBeforeSpawn.add(id);
      this.store.setStatus(id, 'cancelled');
      this.emit(id, { type: 'status', status: 'cancelled', reason: 'cancel requested' });
      this.bus.publish('session.status', { sessionId: id, status: 'cancelled', mode: meta.mode });
      return this.store.read(id)!;
    }
    if (turn && (meta.status === 'running' || meta.status === 'queued')) {
      // A turn whose run already ended is being finalized (or about to be): marking it cancelled here would turn a
      // completed turn into "cancelled", keep its pipeline row pending, leave its policy batch unacknowledged and let
      // the claim go mid-finalize. The run's exit (its endedAt, or the exit file the runner has not copied in yet)
      // proves the turn is over, so the cancel is a no-op.
      const run = this.runner.store.read(turn.runId);
      if ((run && run.endedAt !== null) || this.runner.store.readExit(turn.runId) !== null) return meta;
      // Its exit can land (from another process) between that read and the stop: a run cancel finds done or failed ended
      // on its own, and the same no-op applies.
      const stopped = this.runner.cancel(turn.runId);
      if (stopped && (stopped.status === 'done' || stopped.status === 'failed')) return this.store.read(id)!;
      this.store.setStatus(id, 'cancelled');
      this.emit(id, { type: 'status', status: 'cancelled', turn: turn.n, reason: 'cancel requested' });
      this.bus.publish('session.status', { sessionId: id, status: 'cancelled', mode: meta.mode });
    }
    return this.store.read(id)!;
  }

  /**
   * A session left holding its report number (awaiting the user, or a later turn that failed or was cancelled before it
   * started) gives it back here: nothing else would drop the RESERVED file before a gc.
   */
  async delete(id: string): Promise<boolean> {
    if (this.active.has(id) || this.sending.has(id)) throw new BusyError(`session ${id} is still running`);
    const meta = this.store.read(id);
    const batch = meta?.policyBatch ?? null;
    const num = meta?.reportNum ?? null;
    const credited = num !== null && this.creditedHolds(meta!, num);
    // Taken before the delete removes the record of when the session got the number. A credited report still there
    // holds the number, so no other reservation can have claimed it.
    const since = num !== null && !credited ? this.ownedSince(meta!, num) : undefined;
    // Claimed before the delete and the await, as finalize does, so the number is released once.
    if (num !== null) this.store.setReportNum(id, null);
    let deleted: boolean;
    try {
      deleted = this.store.delete(id);
    } finally {
      if (num !== null) {
        const released = await this.releaseReportNum(num, credited, since);
        if (released.startsWith('could not') || released.includes('already lost')) console.warn(`[sessions] session ${id} deleted: ${released}`);
      }
    }
    for (const key of this.reservationWarned) if (key.startsWith(`${id}\0`)) this.reservationWarned.delete(key);
    if (deleted && batch !== null) this.dropUnheldPolicyBatch(batch);
    return deleted;
  }

  /**
   * Removes a policy pass batch no session can acknowledge any more. One a session still holds (a pass that ended in
   * error or was cancelled can be continued by a reply; a fork interrupted mid hand-over leaves it with both), one
   * being acknowledged, or one recorded done stays.
   */
  dropUnheldPolicyBatch(batch: string): void {
    if (this.policyAcksInFlight.has(batch) || this.store.list().some((m) => m.policyBatch === batch)) return;
    try {
      dropPolicyBatch(this.cfg.dataRoot, batch);
    } catch (err) {
      console.warn(`[sessions] could not remove policy pass batch ${batch}: ${(err as Error).message}`);
    }
  }

  /**
   * Server start: sessions left running by a previous process are re-attached or finalized, and so is a last turn that
   * was never finalized whatever the session's status says (cancelled while no server tracked it, between a drain and
   * the next server's activation): finalize records its cost, files and post-turn hashes and releases its report number.
   */
  reconcile(): void {
    for (const meta of this.store.list()) {
      const live = meta.status === 'running' || meta.status === 'queued';
      const turn = meta.turns.at(-1);
      if (!live && (!turn || turn.endedAt)) continue;
      if (this.active.has(meta.id)) continue;
      const run = turn ? this.runner.store.read(turn.runId) : null;
      if (!turn || !run) {
        // Already settled (a status other than running or queued) with no run to follow: nothing more to record.
        if (!live) continue;
        const reason = 'run record missing after a restart';
        this.store.setStatus(meta.id, 'error', reason);
        // No turn will finalize this session: its reservation goes back to the pool (claimed first, as finalize does).
        if (meta.reportNum !== null) {
          const since = this.ownedSince(meta, meta.reportNum);
          this.store.setReportNum(meta.id, null);
          void this.releaseReportNum(meta.reportNum, false, since);
        }
        this.emit(meta.id, { type: 'status', status: 'error', reason, ...(turn ? { turn: turn.n } : {}) });
        continue;
      }
      const policy = this.effectivePolicy(meta.mode) ?? policyForClass(meta.policyClass);
      const state = this.readTurnState(meta.id, turn.n);
      this.track(meta.id, turn.n, run.id, policy, state, '');
    }
    this.runLeftoverPolicyAcks();
  }

  close(): void {
    for (const t of this.active.values()) clearInterval(t.timer);
    this.active.clear();
    this.closed = true;
    if (this.policyAckTimer) clearTimeout(this.policyAckTimer);
    this.policyAckTimer = null;
  }

  /**
   * Acknowledges the batches of passes that ended done but whose ack failed: until it lands their items stay queued, and
   * the next pass would send them to Claude again, whatever the batch's age. A batch still failing is kept and tried
   * again later; one that cannot be read is let go of unacknowledged and removed (policyBatchReadable).
   */
  private async ackLeftoverPolicyBatches(): Promise<void> {
    let failed = false;
    for (const batch of donePolicyBatches(this.cfg.dataRoot)) {
      if (this.policyAcksInFlight.has(batch)) continue;
      if (!policyBatchReadable(this.cfg.dataRoot, batch)) {
        console.warn(`[sessions] policy pass batch ${batch} cannot be read: it is removed and its items stay queued for the next pass`);
        dropUnreadablePolicyBatch(this.cfg.dataRoot, batch);
        continue;
      }
      if (!(await this.ackDonePolicyBatch(batch)).ok) failed = true;
    }
    if (failed) this.retryPolicyAcks();
    else this.policyAckDelay = this.deps.policyAckRetryMs ?? POLICY_ACK_RETRY_MS;
  }

  /** Acknowledges a done pass's batch and forgets it once the ack lands; a failure leaves it recorded and arms a retry. */
  private async ackDonePolicyBatch(batch: string): Promise<{ ok: boolean; text: string }> {
    this.policyAcksInFlight.add(batch);
    try {
      const ack = await ackPolicyPass(this.deps.exec, this.cfg.codeRoot, this.cfg.dataRoot, batch);
      if (ack.ok) forgetDonePolicyBatch(this.cfg.dataRoot, batch);
      else this.retryPolicyAcks();
      return ack;
    } finally {
      this.policyAcksInFlight.delete(batch);
    }
  }

  /** Runs the leftover acks in the background; a batches folder it cannot read is logged and tried again later. */
  private runLeftoverPolicyAcks(): void {
    this.ackLeftoverPolicyBatches().catch((err: unknown) => {
      console.error(`[sessions] policy-pass acks: ${(err as Error).stack ?? String(err)}`);
      this.retryPolicyAcks();
    });
  }

  private retryPolicyAcks(): void {
    if (this.policyAckTimer || this.closed) return;
    this.policyAckTimer = setTimeout(() => {
      this.policyAckTimer = null;
      this.runLeftoverPolicyAcks();
    }, this.policyAckDelay);
    this.policyAckTimer.unref();
    this.policyAckDelay = Math.min(this.policyAckDelay * 2, POLICY_ACK_RETRY_CAP_MS);
  }

  /**
   * Whether the CLI has a conversation under the session's id to resume: a turn reported session.init, or the CLI
   * saved its transcript (a turn that died before its init event). Neither means a turn starts it with --session-id;
   * if that is ever wrong the CLI refuses the reused id and the transcript is left as it was.
   */
  private hasConversation(meta: SessionMeta): boolean {
    return conversationStarted(meta) || transcriptFiles(this.cfg.claudeProjectsDir, this.cfg.codeRoot, meta.claudeSessionId).some((f) => fs.existsSync(f));
  }

  private originalRequestPath(id: string): string {
    return path.join(this.store.guardDirOf(id), 'original-request.txt');
  }

  /** Kept from the session's first turn on: the route adds the target to that message only, so a later fresh start needs it. */
  private recordOriginalRequest(id: string, prompt: string): void {
    const file = this.originalRequestPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, prompt, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }

  /**
   * A turn that starts a fresh conversation after the first one never reached Claude (it failed before spawn, or died
   * before the CLI saved anything) would otherwise carry only the reply: the original request and its target go first.
   */
  private withOriginalRequest(meta: SessionMeta, prompt: string): string {
    let original: string | undefined;
    try {
      original = fs.readFileSync(this.originalRequestPath(meta.id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      original = meta.turns[0]?.userText;
    }
    return original ? `${original}\n\n${prompt}` : prompt;
  }

  private must(id: string): SessionMeta {
    const meta = this.read(id);
    if (!meta) throw new NotFoundError(`no session ${id}`);
    return meta;
  }

  private emit(sessionId: string, event: SessionEvent): StoredEvent {
    const seq = this.store.appendEvent(sessionId, event);
    const stored: StoredEvent = { seq, ts: new Date().toISOString(), event };
    for (const l of this.listeners) l(sessionId, stored);
    return stored;
  }

  private turnStatePath(id: string, n: number): string {
    return path.join(this.store.guardDirOf(id), 'turns', String(n), 'turn.json');
  }

  private readTurnState(id: string, n: number): TurnState {
    try {
      return JSON.parse(fs.readFileSync(this.turnStatePath(id, n), 'utf8')) as TurnState;
    } catch {
      return { beforeReports: [...snapshotReports(this.cfg.dataRoot)], filesOffset: 0 };
    }
  }

  private filesLineCount(id: string): number {
    try {
      return fs.readFileSync(path.join(this.store.guardDirOf(id), 'files.ndjson'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /**
   * A turn that cannot start: the session says why. A first turn's report reservation goes back to the pool; a later
   * turn's stays with the session (as after an awaiting_user outcome), so the retried reply is told the number again.
   */
  private async failBeforeSpawn(meta: SessionMeta, message: string): Promise<SessionMeta> {
    this.store.setStatus(meta.id, 'error', message);
    this.emit(meta.id, { type: 'error', message });
    const num = this.store.read(meta.id)?.reportNum ?? null;
    if (num !== null && meta.turns.length === 0) {
      this.store.setReportNum(meta.id, null);
      await this.releaseReportNum(num, false);
    }
    // Last, so a stream consumer that reloads the session on a terminal status sees the reservation released.
    this.emit(meta.id, { type: 'status', status: 'error', reason: message });
    this.bus.publish('session.status', { sessionId: meta.id, status: 'error', mode: meta.mode });
    return this.store.read(meta.id)!;
  }

  /**
   * A later turn of a session that holds a reserved number, which it may have waited on for hours: the stale-sentinel
   * GC (verify-pipeline.mjs, reserve-report-num.mjs --gc) frees a sentinel by age alone, and the next reservation hands
   * the number out again. A sentinel still its own (written no later than the session got the number) is refreshed; a
   * lost one is replaced by a fresh reservation, or by none when that fails (the turn then numbers its report itself).
   */
  private async reassertReservation(meta: SessionMeta): Promise<SessionMeta> {
    const num = meta.reportNum;
    if (num === null || this.creditedHolds(meta, num)) return meta;
    if (await this.refreshReservation(meta, num)) {
      this.forgetReservationLosses(meta.id);
      return meta;
    }
    // Claimed before the await, as finalize does; the number is someone else's now, so it is not released.
    this.store.setReportNum(meta.id, null);
    const { r, nums: fresh } = await this.takeReportNums(1);
    if (fresh.length === 1) {
      // Recorded first: a number held without its record would read as lost on the next turn. One that cannot be
      // recorded goes straight back to the pool, and the turn fails holding none.
      try {
        fs.writeFileSync(this.reservationPath(meta.id), JSON.stringify({ num: fresh[0], at: Date.now() }));
      } catch (err) {
        this.recordedReportNums(fresh);
        await this.releaseReportNum(fresh[0]!, false);
        throw err;
      }
      try {
        this.store.setReportNum(meta.id, fresh[0]!);
      } finally {
        this.recordedReportNums(fresh);
      }
      // A new reservation, possibly of the same number: losing it is a new loss, said again.
      this.forgetReservationLosses(meta.id);
    } else {
      this.recordedReportNums(fresh);
      console.warn(`[sessions] session ${meta.id} lost report number ${num} and could not reserve another (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-200)}`);
    }
    return this.store.read(meta.id)!;
  }

  /**
   * Refreshes `num`'s sentinel when it is still the session's (written no later than the session got the number); false
   * when it is not. The check and the touch run under the tracker lock the stale GC takes, so a sentinel it is collecting
   * is never refreshed after its age was read. Throws when the refresh could not be run (the tracker lock stayed busy).
   */
  private async refreshReservation(meta: SessionMeta, num: number): Promise<boolean> {
    const since = this.reservedAt(meta, num);
    if (!this.sentinelOwned(num, since)) return false;
    const r = await this.settleSentinel('refresh', num, since);
    if (r.failure) throw new Error(r.failure);
    return r.outcome === 'refreshed';
  }

  /**
   * A running turn keeps its reserved number's sentinel younger than the stale-sentinel GC's age threshold: the
   * allocator process that wrote it has exited, so age alone would let a GC free the number while the turn may still
   * write its report under it.
   */
  private keepReservationFresh(id: string): void {
    // One refresh at a time: a tick while another waits for the tracker lock leaves it to finish.
    if (this.refreshing.has(id)) return;
    this.refreshing.add(id);
    void this.refreshIfAged(id).finally(() => this.refreshing.delete(id));
  }

  /** Never rejects: the tracker tick behind it goes on, and an unreadable record waits for the next tick. */
  private async refreshIfAged(id: string): Promise<void> {
    let num: number | null = null;
    try {
      // Read inside the try: the tracker tick calling this must never throw (an unreadable record waits for the next tick).
      const meta = this.store.read(id);
      num = meta?.reportNum ?? null;
      if (meta && num !== null && !this.creditedHolds(meta, num)) {
        const sentinel = this.sentinelPath(num);
        if (Date.now() - fs.statSync(sentinel).mtimeMs >= RESERVATION_REFRESH_AGE_MS) {
          if (await this.refreshReservation(meta, num)) this.forgetReservationLosses(id);
          else this.warnReservationLost(id, num, readSentinelCreatedAt(sentinel) === null && fs.existsSync(sentinel) ? 'cannot be read, so it is not refreshed or released' : 'was collected while its turn runs; the number may be handed out again');
        }
      }
      // A tick that got through: a later failure is a new one, said again.
      this.reservationWarned.delete(`${id}\0refresh`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && num !== null) this.warnReservationLost(id, num, 'was collected while its turn runs; the number may be handed out again');
      else this.warnOnce(`${id}\0refresh`, `[sessions] session ${id}: could not refresh the reservation for report number ${num ?? '(unknown)'}: ${(err as Error).message}`);
    }
  }

  /** Said once per session and number: the tracker ticks again every poll. Finalize then leaves the number alone. */
  private warnReservationLost(id: string, num: number, why: string): void {
    this.warnOnce(`${id}\0${num}\0${why}`, `[sessions] session ${id}: its reservation of report number ${num} ${why}`);
  }

  /** The session's reservation-loss warnings (not its refresh failure), forgotten once it holds a reservation again. */
  private forgetReservationLosses(id: string): void {
    for (const key of this.reservationWarned) if (key.startsWith(`${id}\0`) && key !== `${id}\0refresh`) this.reservationWarned.delete(key);
  }

  private warnOnce(key: string, message: string): void {
    if (this.reservationWarned.has(key)) return;
    this.reservationWarned.add(key);
    console.warn(message);
  }

  /**
   * A session credited a report under `num`, and a report numbered `num` is still there (the credited file, or the same
   * report renamed): it holds the number. Once the user deleted it, nothing does.
   */
  private creditedHolds(meta: SessionMeta, num: number): boolean {
    if (meta.creditedReport?.num !== num) return false;
    for (const file of snapshotReports(this.cfg.dataRoot)) if (reportNumberOf(file) === num) return true;
    return false;
  }

  private sentinelPath(num: number): string {
    return path.join(this.cfg.dataRoot, 'reports', `${String(num).padStart(3, '0')}-RESERVED.md`);
  }

  /**
   * When the session got `num`, taken before anything removes that record (a delete); null when it cannot be read, and
   * then no sentinel reads as the session's.
   */
  private ownedSince(meta: SessionMeta, num: number): number | null {
    try {
      return this.reservedAt(meta, num);
    } catch (err) {
      console.warn(`[sessions] session ${meta.id}: could not read when it got report number ${num}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Tells whether `num`'s sentinel is still the session's: written no later than `since`, when the session got the
   * number. A sentinel the stale GC collected is gone, or belongs to whichever reservation claimed the number next, and
   * is not the session's to release. One that cannot be read is not released either.
   */
  private sentinelOwned(num: number, since: number | null): boolean {
    if (since === null) return false;
    try {
      const createdAt = readSentinelCreatedAt(this.sentinelPath(num));
      return createdAt !== null && createdAt <= since;
    } catch (err) {
      console.warn(`[sessions] could not read the reservation for report number ${num}: ${(err as Error).message}`);
      return false;
    }
  }

  private reservationPath(id: string): string {
    return path.join(this.store.guardDirOf(id), 'reservation.json');
  }

  /** When the session got `num`: a fan-out reserves before it creates the session; a later re-reservation is recorded. */
  private reservedAt(meta: SessionMeta, num: number): number {
    try {
      const r = JSON.parse(fs.readFileSync(this.reservationPath(meta.id), 'utf8')) as { num?: unknown; at?: unknown };
      if (r.num === num && typeof r.at === 'number') return r.at;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    return Date.parse(meta.createdAt);
  }

  /**
   * A new session's first turn is claimed (as send and fork claim theirs) until it is running, so a delete is refused
   * while it prepares; a cancel meanwhile is honoured before anything is spawned.
   */
  private async runTurn(meta: SessionMeta, policy: ModePolicy, prompt: string, opts: { resume: boolean; fork: boolean; blacklistAllowed?: boolean; original?: boolean }): Promise<SessionMeta> {
    const claimed = !this.sending.has(meta.id);
    if (claimed) this.sending.add(meta.id);
    this.preparing.add(meta.id);
    try {
      return await this.prepareAndSpawn(meta, policy, prompt, opts);
    } finally {
      if (claimed) this.sending.delete(meta.id);
      this.preparing.delete(meta.id);
      this.cancelledBeforeSpawn.delete(meta.id);
    }
  }

  /**
   * A turn cancelled before its run started: a first turn's report reservation goes back to the pool and a later turn's
   * stays with the session, as for one that cannot start.
   */
  private async endCancelledBeforeSpawn(meta: SessionMeta): Promise<SessionMeta> {
    const num = this.store.read(meta.id)?.reportNum ?? null;
    if (num !== null && meta.turns.length === 0) {
      this.store.setReportNum(meta.id, null);
      const reason = `cancelled by the user before the turn started; ${await this.releaseReportNum(num, false)}`;
      // Last, so a stream consumer that reloads the session on a terminal status sees the reservation released.
      this.emit(meta.id, { type: 'status', status: 'cancelled', reason });
      this.bus.publish('session.status', { sessionId: meta.id, status: 'cancelled', mode: meta.mode });
    }
    return this.store.read(meta.id)!;
  }

  private async prepareAndSpawn(meta: SessionMeta, policy: ModePolicy, prompt: string, opts: { resume: boolean; fork: boolean; blacklistAllowed?: boolean; original?: boolean }): Promise<SessionMeta> {
    // Policy, settings and revert bookkeeping live under the guard root, outside every write scope.
    const sessionDir = this.store.guardDirOf(meta.id);
    const n = meta.turns.length + 1;
    const turnDir = path.join(sessionDir, 'turns', String(n));
    // Only Dev Chat can unlock the blacklist (the route also demands the explicit header).
    const blacklistAllowed = opts.blacklistAllowed === true && policy.policyClass === 'devchat';
    let token: string;
    let env: NodeJS.ProcessEnv;
    let argv: string[];
    let state: TurnState;
    try {
      const baseDeny = policy.policyClass === 'devchat' ? DEVCHAT_DENIED_WRITES : ALWAYS_DENIED_WRITES;
      const deny = blacklistAllowed ? baseDeny.filter((p) => p !== 'data/blacklist.md') : [...baseDeny];
      // Only a session's own first message: a replay of one that was never kept must not record the bare reply as it.
      if (opts.original === true) this.recordOriginalRequest(meta.id, prompt);
      assertRootsConfinable(this.cfg.codeRoot, this.cfg.dataRoot, this.deps.home ?? os.homedir());
      // The CLI that runs this turn must be a version whose confinement was probed (cached on the binary's stat).
      await assertApprovedClaude(this.cfg.claudeBin, this.cfg.nodeEnv);
      if (n > 1) meta = await this.reassertReservation(meta);
      // A fork's first turn runs under an id --fork-session mints, so its tool-results folder is not known yet.
      const readOnlyRoots = opts.fork ? [] : toolResultsDirs(this.cfg.claudeProjectsDir, this.cfg.codeRoot, meta.claudeSessionId);
      const policyFile = writePolicyFile(turnDir, { codeRoot: this.cfg.codeRoot, dataRoot: this.cfg.dataRoot, sessionDir, policy, extraAllow: blacklistAllowed ? ['data/blacklist.md'] : [], deny, readOnlyRoots });
      // Per turn, next to the turn's policy: the permissions this turn ran with, in a file so no rule is split as an argument.
      const settingsFile = writeSettingsFile(turnDir, { permissions: buildPermissions({ policy, codeRoot: this.cfg.codeRoot, dataRoot: this.cfg.dataRoot, guardRoot: this.cfg.guardRoot }) });
      const preamble = buildPreamble({ policy, outputLanguage: readOutputLanguage(this.cfg.dataRoot), reportNum: meta.reportNum ?? undefined, blacklistAllowed, codeRoot: this.cfg.codeRoot, dataRoot: this.cfg.dataRoot });
      token = await this.deps.readToken();
      env = buildEnv({}, { token, dataRoot: this.cfg.dataRoot, policyFile: policyFile.file, policySha256: policyFile.sha256, sessionDir });
      env.CC_MODE = meta.mode;
      env.CC_TURN_DIR = turnDir;
      env.NO_COLOR = '1';
      argv = buildArgv({
        claudeBin: this.cfg.claudeBin,
        codeRoot: this.cfg.codeRoot,
        dataRoot: this.cfg.dataRoot,
        sessionDir,
        policyFile: policyFile.file,
        settingsFile,
        policy,
        userMessage: prompt,
        claudeSessionId: meta.claudeSessionId,
        resume: opts.resume,
        fork: opts.fork,
        model: meta.model ?? undefined,
        preamble,
      });
      // Written before the run exists, so a restart always finds the turn's starting point.
      state = { beforeReports: [...snapshotReports(this.cfg.dataRoot)], filesOffset: this.filesLineCount(meta.id), resumed: opts.resume };
      fs.writeFileSync(this.turnStatePath(meta.id, n), JSON.stringify(state));
    } catch (err) {
      if (this.cancelledBeforeSpawn.has(meta.id)) return this.endCancelledBeforeSpawn(meta);
      // The turn has failed: a cancel while its number is released finds it ended and changes nothing.
      this.preparing.delete(meta.id);
      return this.failBeforeSpawn(meta, (err as Error).message);
    }
    // Checked after the last await: no cancel can land between here and the spawn.
    if (this.cancelledBeforeSpawn.has(meta.id)) return this.endCancelledBeforeSpawn(meta);
    // From here a cancel stops the run like any other.
    this.preparing.delete(meta.id);
    let run: RunMeta;
    try {
      run = this.runner.start({
        actionId: `session.${meta.mode}`,
        label: `${policy.title}: turn ${n}`,
        cost: 'tokens',
        resources: [],
        claude: true,
        params: { sessionId: meta.id, turn: n },
        cmd: { bin: this.cfg.claudeBin, args: argv, cwd: this.cfg.codeRoot },
        env,
      });
    } catch (err) {
      // Nothing was spawned (its run record could not be created): the turn fails like any other that cannot start.
      return this.failBeforeSpawn(meta, (err as Error).message);
    }
    try {
      const began = this.store.beginTurn(meta.id, { runId: run.id, userText: prompt });
      this.emit(meta.id, { type: 'status', status: 'running', turn: n });
      this.bus.publish('session.status', { sessionId: meta.id, status: 'running', mode: meta.mode, turn: n });
      this.track(meta.id, n, run.id, policy, state, token);
      return began;
    } catch (err) {
      // The run exists and may already be writing: it is stopped first. A first turn's report number goes back to the pool
      // only once that run has ended; a later turn's stays with the session, as for any reply that could not start.
      const message = (err as Error).message;
      let stopped = false;
      try {
        this.runner.cancel(run.id);
        stopped = await this.runEnded(run.id);
      } catch {
        /* the run record cannot be read: the number stays reserved */
      }
      try {
        this.store.setStatus(meta.id, 'error', message);
        const num = this.store.read(meta.id)?.reportNum ?? null;
        if (stopped && num !== null && meta.turns.length === 0) {
          this.store.setReportNum(meta.id, null);
          await this.releaseReportNum(num, false);
        }
      } catch {
        /* the session record cannot be written either: the next reconcile settles it */
      }
      throw new TurnStartedError(message);
    }
  }

  private track(id: string, n: number, runId: string, policy: ModePolicy, state: TurnState, token: string): void {
    if (this.active.has(id)) return;
    const progressFile = path.join(this.store.guardDirOf(id), 'turns', String(n), 'progress.json');
    const parser = new StreamParser();
    let seq = 0;
    let offset = 0;
    let envelopes = 0;
    let answers = 0;
    let denials = 0;
    let sawResult = false;
    let turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null = null;
    let finalText = '';
    // A line that cannot be processed fails this session (its run is stopped), never the server that tracks it.
    let failure: string | null = null;
    const stopRun = () => {
      try {
        this.runner.cancel(runId);
      } catch {
        /* the run record is unreadable too: the turn is settled without it */
      }
    };
    const handle = (l: RawLine, emit: boolean) => {
      seq = l.seq;
      if (failure) return;
      try {
        handleLine(l, emit);
      } catch (err) {
        failure = `could not process the session output: ${(err as Error).message}`;
        stopRun();
      }
    };
    const handleLine = (l: RawLine, emit: boolean) => {
      const events: SessionEvent[] = l.stream === 'stdout' ? parser.push(l.line) : [{ type: 'stderr', text: redact(l.line, token) }];
      for (const ev of events) {
        if (ev.type === 'envelope') envelopes++;
        if (ev.type === 'envelope' && ev.kind === 'answers') answers++;
        if (ev.type === 'permission.denied') denials++;
        if (ev.type === 'turn.done') {
          turnDone = ev;
          sawResult = true;
        }
        // The honesty gate reads the last message (the result), as it always has; text.done holds every message for the transcript.
        // Its visible text can be empty (an answer that is only an envelope): that is the turn's output, not a reason to fall back to the raw stream.
        if (ev.type === 'text.done') finalText = parser.lastVisibleText;
        // A fork's first turn reports the id --fork-session minted; later turns must resume that one.
        if (ev.type === 'session.init') {
          this.store.adoptForkedClaudeSessionId(id, ev.claudeSessionId);
          this.store.markConversationStarted(id);
        }
        if (emit) this.emit(id, ev);
      }
    };
    // A file the tracker cannot read or write (a full disk, a folder turned read-only) fails this session the same way:
    // its run is stopped (when even that is possible), the next tick tries again, and the turn ends once the run does.
    const fail = (err: unknown) => {
      if (failure) return;
      failure = `could not record the session output: ${(err as Error).message}`;
      stopRun();
    };
    // A previous server already turned part of this log into events: rebuild the counters silently and go on from there.
    try {
      const saved = readProgress(progressFile);
      if (saved) {
        for (const l of this.runner.store.readRaw(runId).lines) if (l.seq <= saved.rawSeq) handle(l, false);
        seq = saved.rawSeq;
        offset = saved.rawOffset;
      }
    } catch (err) {
      fail(err);
    }
    const pull = () => {
      const { lines, offset: next } = this.runner.store.readRaw(runId, seq, offset);
      offset = next;
      for (const l of lines) handle(l, true);
      if (lines.length) writeProgress(progressFile, { rawSeq: seq, rawOffset: offset });
    };
    const safePull = () => {
      try {
        pull();
      } catch (err) {
        fail(err);
      }
    };
    const timer = setInterval(() => {
      safePull();
      this.keepReservationFresh(id);
      let run: RunMeta | null;
      try {
        run = this.runner.store.read(runId);
      } catch (err) {
        // Without its run record the turn cannot be followed or finalized: it ends now, in error. Nothing confirms the
        // stopped run has ended, so it may still write its report: the session keeps its number.
        fail(err);
        clearInterval(timer);
        // Still tracked until the runner stops following its process: the duplicate checks count it live until then.
        void this.finalizeFailed(id, n, null, { turnDone, denials, failure, keepReservation: true }, err).finally(() => this.untilRunStops(id, runId));
        return;
      }
      // A cancelled run's status leaves queued/running at once, but its Claude process may still run until the runner's
      // SIGKILL: the turn is only over once the run has ended (its exit recorded), so the tracker waits for that instead
      // of finalizing a turn whose process is still writing the conversation.
      if (!run) {
        // Its record is gone (a runs prune, a folder deleted by hand): nothing will ever record its exit. While the runner
        // still follows its process, that process may still write the report, so the turn waits for it; then the turn
        // ends in error and gives its report number back, as reconcile does for a run record missing after a restart.
        stopRun();
        if (this.runner.ending(runId)) return;
        clearInterval(timer);
        void this.finalizeFailed(id, n, null, { turnDone, denials, failure }, new Error(`the run record ${runId} is gone`)).finally(() => this.active.delete(id));
        return;
      }
      if (run.endedAt === null) return;
      clearInterval(timer);
      safePull();
      const ended = run;
      this.finalize(id, n, ended, policy, state, { envelopes, answers, denials, sawResult, turnDone, finalText: sawResult ? finalText : parser.text, failure })
        .catch((err: unknown) => this.finalizeFailed(id, n, ended, { turnDone, denials, failure }, err))
        .finally(() => this.active.delete(id));
    }, this.deps.pollMs ?? 250);
    timer.unref();
    this.active.set(id, { timer });
  }

  /**
   * A finalize that threw (a file it reads, a folder it writes): the turn ends once, instead of an unhandled rejection
   * taking the server down and the next start re-running the same finalize. What finalize would have settled still is:
   * the usage the turn reported, a reserved report number (released, so its RESERVED file goes) and a cancel (the turn
   * stays cancelled); anything else ends in error saying why.
   */
  private async finalizeFailed(id: string, n: number, run: RunMeta | null, r: { turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; denials: number; failure: string | null; keepReservation?: boolean }, err: unknown): Promise<void> {
    // A run stopped because its output could not be processed failed; it was not cancelled by the user.
    const why = `${r.failure ? `${r.failure}; ` : ''}the turn could not be finalized: ${(err as Error).message}`;
    console.error(`[sessions] session ${id} turn ${n}: ${(err as Error).stack ?? why}`);
    try {
      const meta = this.store.read(id);
      if (!meta || this.turnEnded(id, n)) return;
      const cancelled = meta.status === 'cancelled' || (run?.status === 'cancelled' && !r.failure);
      let reason = cancelled ? `cancelled by the user; ${why}` : why;
      const num = meta.reportNum;
      if (num !== null && r.keepReservation !== true) {
        // Claimed before the await, as finalize does, so the number is released once, and only while it is still the session's.
        const since = this.creditedHolds(meta, num) ? undefined : this.ownedSince(meta, num);
        this.store.setReportNum(id, null);
        reason += `; ${await this.releaseReportNum(num, null, since)}`;
      }
      if (this.turnEnded(id, n)) return;
      const status = cancelled ? 'cancelled' : 'error';
      this.store.endTurn(id, n, { costUsd: r.turnDone?.costUsd ?? 0, tokens: r.turnDone?.tokens ?? 0, permissionDenials: r.denials, status, error: status === 'error' ? why : undefined, reason });
      this.emit(id, { type: 'status', status, reason, turn: n });
      this.bus.publish('session.status', { sessionId: id, status, mode: meta.mode, turn: n });
    } catch (again) {
      console.error(`[sessions] session ${id} turn ${n} could not be settled either: ${(again as Error).message}`);
    }
  }

  /** Waits (up to RUN_END_WAIT_MS) for a run to record its exit; false when it has not. */
  private async runEnded(runId: string): Promise<boolean> {
    const deadline = Date.now() + RUN_END_WAIT_MS;
    for (;;) {
      // A cancelled run's status leaves queued/running at once, but its Claude process may still run until the runner's
      // SIGKILL: only a recorded exit (endedAt) proves it can no longer write its report. A missing record proves nothing.
      const run = this.runner.store.read(runId);
      if (run !== null && run.endedAt !== null) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Keeps the session in `active` while the runner still follows the run's process, then drops it. Meanwhile the stop
   * that failed while the record could not be read is tried again, and the number the session kept stays reserved.
   */
  private untilRunStops(id: string, runId: string): void {
    if (this.closed) return;
    let stopped = false;
    const following = () => {
      if (!stopped) {
        try {
          this.runner.cancel(runId);
          stopped = true;
        } catch {
          /* the run record is still unreadable: tried again on the next tick */
        }
      }
      try {
        return this.runner.ending(runId);
      } catch {
        // Its record is unreadable and the runner does not follow it: nothing here can tell it is still alive.
        return false;
      }
    };
    if (!following()) {
      this.active.delete(id);
      return;
    }
    const timer = setInterval(() => {
      this.keepReservationFresh(id);
      if (following()) return;
      clearInterval(timer);
      this.active.delete(id);
    }, this.deps.pollMs ?? 250);
    timer.unref();
    this.active.set(id, { timer });
  }

  private turnEnded(id: string, n: number): boolean {
    return Boolean(this.store.read(id)?.turns.find((t) => t.n === n)?.endedAt);
  }

  private async finalize(id: string, n: number, run: RunMeta, policy: ModePolicy, state: TurnState, r: { envelopes: number; answers: number; denials: number; sawResult: boolean; turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; finalText: string; failure: string | null }): Promise<void> {
    const meta = this.store.read(id);
    // Already finalized (by another server, or before a restart): its cost and report number were settled then.
    if (!meta || this.turnEnded(id, n)) return;
    // The bytes this turn left behind; a revert refuses to overwrite anything that changed since.
    recordTurnAfter(this.store.guardDirOf(id), n, state.filesOffset);
    const changed = this.changedFiles(id, state.filesOffset);
    if (changed.length) {
      this.emit(id, { type: 'files.changed', paths: changed });
      this.store.addFilesChanged(id, changed);
    }
    // Only this turn's own report counts: the reserved number, or a report in its own files log.
    const newReports: NewReport[] = ownReports(detectNewReports(this.cfg.dataRoot, new Set(state.beforeReports)), { reportNum: meta.reportNum, turnFiles: changed });
    if (newReports.length) this.emit(id, { type: 'evaluation', reports: newReports });
    const cancelled = meta.status === 'cancelled' || run.status === 'cancelled';
    if (r.failure) this.emit(id, { type: 'error', message: r.failure });
    // A lost run (queued at a restart, or its process vanished) says why, instead of looking like a signal exit.
    const outcome = r.failure ? { status: 'error' as const, reason: r.failure } : run.status === 'lost' && !cancelled ? { status: 'error' as const, reason: run.error ?? 'the run was lost without an exit record' } : decideTurnOutcome({
      modeId: meta.mode,
      policyClass: policy.policyClass,
      cancelled,
      exitCode: run.exitCode,
      isError: r.turnDone?.isError ?? false,
      sawResult: r.sawResult,
      finalText: r.finalText,
      envelopeCount: r.envelopes,
      newReports,
      resumed: state.resumed ?? n > 1,
      // Read before this turn's own answers are recorded: a turn that delivers them is done by its envelope.
      answersSeen: meta.answersSeen === true,
      reportProduced: meta.creditedReport !== undefined,
    });
    if (r.answers > 0) this.store.markAnswersSeen(id);
    if (newReports[0]) this.store.setCreditedReport(id, newReports[0]);
    // The sentinel is dropped once the turn is over: a real report now holds the number, or it goes back to the pool.
    let reason = outcome.reason;
    const num = meta.reportNum;
    if (num !== null && outcome.status !== 'awaiting_user') {
      // An earlier turn's credited report holds the number as well as this turn's own new one, while it is still there.
      const creditedHeld = this.creditedHolds(meta, num);
      const used = newReports.some((x) => x.num === num) || creditedHeld;
      // A report holding the number means no other reservation can have claimed it; otherwise the stale GC may have, and
      // the sentinel now there (or the one a reservation writes before the release runs) is someone else's.
      const since = used ? undefined : this.ownedSince(meta, num);
      // Claimed before the await, so no other finalize of this turn can release the number again.
      this.store.setReportNum(id, null);
      reason += `; ${await this.releaseReportNum(num, used, since)}`;
    }
    // Only a pass that ends done acknowledges the items it was given; any other outcome leaves them queued for the next run.
    const batch = meta.policyBatch ?? null;
    if (batch !== null && outcome.status === 'done') {
      // Claimed before the await, as the report number is; recorded first, so an ack that fails is tried again later.
      this.store.setPolicyBatch(id, null);
      try {
        recordDonePolicyBatch(this.cfg.dataRoot, batch);
      } catch (err) {
        console.error(`[sessions] could not record policy pass batch ${batch} for a later ack: ${(err as Error).message}`);
      }
      reason += `; ${(await this.ackDonePolicyBatch(batch)).text}`;
    }
    // A completed evaluation of a pipeline URL leaves Pending, as pipeline mode moves it (modes/pipeline.md, Workflow 2f).
    // So does one of a saved JD (Evaluate JD on a local:jds/ row), whose text target is the row's reference.
    // The report may have come on an earlier turn that did not end done: the first done turn moves the URL with it.
    const credited = newReports[0] ?? meta.creditedReport;
    const pipelineKey = meta.target.type === 'url' || (meta.target.type === 'text' && localJdPath(meta.target.value ?? '') !== null);
    if (outcome.status === 'done' && isReportGated(meta.mode) && pipelineKey && meta.target.value && credited && meta.pipelineMarked !== true) {
      const moved = await this.markEvaluated(meta.target.value, credited);
      if (moved.note) reason += `; ${moved.note}`;
      if (moved.settled) this.store.markPipelineMarked(id);
    }
    if (this.turnEnded(id, n)) return;
    this.store.endTurn(id, n, {
      costUsd: r.turnDone?.costUsd ?? 0,
      tokens: r.turnDone?.tokens ?? 0,
      permissionDenials: r.denials,
      status: outcome.status,
      error: outcome.status === 'error' ? outcome.reason : undefined,
      reason,
    });
    this.emit(id, { type: 'status', status: outcome.status, reason, turn: n });
    this.bus.publish('session.status', { sessionId: id, status: outcome.status, mode: meta.mode, turn: n });
    if (changed.length || newReports.length) this.bus.publish('data.changed', { domain: 'reports' });
  }

  private changedFiles(id: string, fromLine: number): string[] {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.store.guardDirOf(id), 'files.ndjson'), 'utf8');
    } catch {
      return [];
    }
    const out = new Set<string>();
    for (const line of text.split('\n').filter(Boolean).slice(fromLine)) {
      try {
        const p = (JSON.parse(line) as { path?: string }).path;
        if (p) out.add(p);
      } catch {
        /* torn line */
      }
    }
    return [...out];
  }

  /**
   * Moves the URL's Pending row to Processed. `note` says what happened (null when the pipeline does not list the URL
   * as pending, a posting evaluated from elsewhere); `settled` is false only when the move failed, so a later done turn
   * tries again.
   */
  private async markEvaluated(url: string, report: { file: string }): Promise<{ note: string | null; settled: boolean }> {
    try {
      const moved = await markPipelineEvaluated(this.cfg.codeRoot, this.cfg.dataRoot, url, report.file);
      return { note: moved ? `pipeline row moved to Processed as #${report.file.match(/^\d+/)![0]}` : null, settled: true };
    } catch (err) {
      return { note: `could not move the pipeline row to Processed: ${(err as Error).message}`, settled: false };
    }
  }

  /** Releases the reservation sentinel; the caller has already cleared (claimed) the session's reportNum. */
  /** `used`: a report holds the number now (true), none does (false), or it is not known (null: a finalize that failed). */
  /** A failed attempt is tried again (the tracker lock may be busy): nothing else would drop the RESERVED file before a gc. */
  /**
   * `since`, when given (when the session got the number), makes the release ownership-checked: a sentinel lost to the
   * stale GC is not released, checked before every attempt and again under the tracker lock as the sentinel goes.
   * Without it (a report holds the number, so no other reservation can have claimed it) the sentinel goes as it is.
   */
  private async releaseReportNum(num: number, used: boolean | null, since?: number | null): Promise<string> {
    const lost = `report number ${num} was already lost (its reservation was collected), so it is not released`;
    let failure = '';
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS * (attempt - 1)));
      if (since !== undefined && !this.sentinelOwned(num, since)) return lost;
      if (since === undefined) {
        failure = await this.tryReleaseReportNum(num);
      } else {
        const r = await this.settleSentinel('release', num, since!);
        if (r.outcome && r.outcome !== 'released') return lost;
        failure = r.failure;
      }
      if (!failure) break;
    }
    if (failure) return `could not release the reservation for ${num}: ${failure}`;
    if (used === null) return `the reservation for report number ${num} was released`;
    return used ? `report number ${num} is now held by the report` : `report number ${num} returned to the pool`;
  }

  /** One release attempt: '' on success, else why it failed. */
  private async tryReleaseReportNum(num: number): Promise<string> {
    try {
      const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--release', String(num)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
      return r.code === 0 ? '' : (r.stderr || r.stdout).trim().slice(-200) || `exit ${r.code}`;
    } catch (err) {
      // The number is already let go on the session: a rejection is reported as a failed release is, not thrown.
      return (err as Error).message;
    }
  }

  /**
   * One ownership-checked release or refresh of `num`'s sentinel under the tracker lock (reservation-sentinel.mjs):
   * its outcome, or why it could not be run (the lock busy, the command failing), never thrown.
   */
  private async settleSentinel(action: 'release' | 'refresh', num: number, since: number): Promise<{ outcome: string | null; failure: string }> {
    try {
      const r = await this.deps.exec(process.execPath, [RESERVATION_SENTINEL_SCRIPT, `--${action}`, String(num), '--since', String(since)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
      if (r.code !== 0) return { outcome: null, failure: (r.stderr || r.stdout).trim().slice(-200) || `exit ${r.code}` };
      const outcome = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { outcome?: unknown }).outcome;
      if (typeof outcome !== 'string') return { outcome: null, failure: `no outcome in: ${r.stdout.trim().slice(-200)}` };
      return { outcome, failure: '' };
    } catch (err) {
      return { outcome: null, failure: (err as Error).message };
    }
  }
}

/** What a fan-out answers for a URL whose session could not even be recorded: an error with the reason, saved nowhere. */
const LIVE_STATUSES = new Set<SessionMeta['status']>(['queued', 'running', 'awaiting_user']);

/**
 * What a mode's duplicate guard compares: every report-gated mode (oferta, auto-pipeline, a localized oferta) writes the
 * posting's report and tracker row, so they are one class; any other mode is only a duplicate of itself.
 */
function evaluationClass(mode: string): string {
  return isReportGated(mode) ? '\0report' : mode;
}

/** An evaluation that has not been credited its report yet: its next turn, or a copy's, still writes one. */
function owesReport(meta: SessionMeta): boolean {
  return isReportGated(meta.mode) && meta.creditedReport === undefined;
}

/**
 * The dedupe key of what a session writes for: a posting's URL (by its dedup key, so two spellings of one posting are
 * one), the saved JD a local:jds/ text target names (as finalize keys it), or the company a sponsorship check writes
 * data/immigration/companies/** for (by its company-file slug).
 */
function postingKey(mode: string, target: SessionMeta['target']): string | null {
  if (target.type === 'url' && target.value) return `url\0${dedupUrlKey(target.value)}`;
  if (target.type === 'company' && mode === 'sponsorship-check') {
    if (target.value?.trim()) return `company\0${sponsorCheckCompany(target.value)}`;
  }
  if (target.type === 'text' && target.value) {
    const jd = localJdPath(target.value);
    if (jd !== null) return `jds\0${jd}`;
  }
  return null;
}

/** What a live duplicate session is doing to `target`, for the refusal that names it. */
export function liveWorkOn(target: SessionMeta['target']): string {
  return target.type === 'company' ? `running a sponsorship check for ${target.value?.trim()}` : `evaluating ${target.value}`;
}

/** When a reservation sentinel was claimed (reserve-report-num writes created_at), or null when it is gone or unreadable. */
function readSentinelCreatedAt(sentinel: string): number | null {
  try {
    const at = Date.parse((JSON.parse(fs.readFileSync(sentinel, 'utf8')) as { created_at?: string }).created_at ?? '');
    return Number.isNaN(at) ? null : at;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    return null;
  }
}

/** The minimal policy reconcile uses to finish a turn whose mode no longer resolves (removed or renamed upstream): finalize only reads its class. */
function policyForClass(policyClass: PolicyClass): ModePolicy {
  return { id: '', title: 'removed mode', policyClass, writeGlobs: [], network: [], scripts: [], bashRules: [], bashPrefixes: [], allowsTask: false };
}

function unstartedMeta(mode: string, target: SessionMeta['target'], model: string | null, error: string): SessionMeta {
  const now = new Date().toISOString();
  return { id: '', claudeSessionId: '', mode, policyClass: getModePolicy(mode)?.policyClass ?? 'read-only', target, model, status: 'error', createdAt: now, updatedAt: now, turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [], forkedFrom: null, error, reportNum: null, lastReason: error };
}

export function parseReservedRange(stdout: string): number[] {
  const m = stdout.trim().match(/(\d+)(?:\s*-\s*(\d+))?\s*$/);
  if (!m) return [];
  const a = parseInt(m[1]!, 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

export class BusyError extends Error {}
/** A turn whose run was started (and is now being stopped) but could not be recorded on its session. */
export class TurnStartedError extends Error {}
export class NotFoundError extends Error {}
/** The mode never runs as a session (sessionRefusal); the message says why and what to use instead. */
export class ModeRefusedError extends Error {}
/** The session predates the current confinement (SESSION_POLICY_VERSION): viewable, never resumed or forked. */
export class OutdatedSessionError extends Error {}

function assertCurrentPolicy(meta: SessionMeta): void {
  if ((meta.policyVersion ?? 1) < SESSION_POLICY_VERSION) throw new OutdatedSessionError(`session ${meta.id} started before read confinement; start a new session`);
}
