// Session manager (spec 4.1 to 4.3): every Claude turn is a detached run
// through the runner (Claude slot cap applies), the Keychain token is read at
// spawn and only ever lives in the child's env, stdout is normalized into
// events.ndjson, and the honesty gate decides done / awaiting_user.
// What must always hold here (one owner per piece of state, across server processes): manager.invariants.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ServerConfig } from '../config.js';
import { pidAlive, type Runner } from '../runner/runner.js';
import { postingClaimFile, processClaimHeld, takeProcessClaim } from './process-claim.js';
import type { RawLine, RunMeta } from '../runner/store.js';
import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import { cliScriptPath, CONTRACT } from '../core/adapter.js';
import { conversationStarted, HELD_REPORT_NUMS_FILE, readHeldRecords, readSentinelIdentity, SessionStore, type SessionMeta, type StoredEvent } from './sessions.js';
import { StreamParser, type SessionEvent } from './stream-parse.js';
import type { EnvelopeKind } from './envelopes.js';
import { assertRootsConfinable, buildArgv, buildEnv, buildPermissions, buildPreamble, redact, toolResultsDirs, transcriptFiles, writePolicyFile, writeSettingsFile } from './invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, MODES, SESSION_POLICY_VERSION, getModePolicy, sessionRefusal, type ModePolicy, type PolicyClass } from './modes.js';
import { assertApprovedClaude } from './cli-version.js';
import { tokenize } from './guard-policy.mjs';
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
const UNREADABLE_RUN_WAIT_MS = 10 * 60_000;
/** A running turn's reservation sentinel older than this is refreshed: well inside the stale GC's four hours. */
const RESERVATION_REFRESH_AGE_MS = 60 * 60_000;
/** Releases or refreshes a sentinel only while it is still the session's, under the tracker lock (run as a child, never loaded here). */
const RESERVATION_SENTINEL_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reservation-sentinel.mjs');
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
  timer: NodeJS.Timeout | null;
  /** This process's track claim (TRACK_CLAIM_FILE), or null while another tracker holds it and this one stands by. */
  release: (() => void) | null;
  /** A settle step (finalize, its failure path, a kept reservation's settle) is in flight: it untracks when it ends. */
  settling: boolean;
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

/**
 * The report numbers a session holds, logged in its guard folder (outside every write scope): the app adds the one it
 * reserved for the session and the ones its own reserve-report-num.mjs runs printed, each naming its reservation by the
 * sentinel's created_at and allocator token (`+N=<ms>~<token>;`), and guard-hook.mjs, which lets a session release only
 * reservations it holds (reserve-report-num.mjs --release deletes whichever sentinels it names), removes each one it lets
 * go. A number released, collected or reserved again is another reservation, so a hold on it no longer matches. With `since` (when
 * the session got the numbers), a sentinel written after it is another reservation's and is not recorded.
 */
export { HELD_REPORT_NUMS_FILE };

export function recordHeldReportNums(sessionDir: string, nums: readonly number[], dataRoot: string, since?: number | null): void {
  const records = nums.flatMap((n) => {
    const id = readSentinelIdentity(dataRoot, n);
    return id === null || (since !== undefined && (since === null || id.at > since)) ? [] : [`\n+${n}=${id.key};`];
  });
  if (records.length === 0) return;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.appendFileSync(path.join(sessionDir, HELD_REPORT_NUMS_FILE), records.join(''));
}

/**
 * Gives back the holds a release took (guard-hook.mjs logs each as `-N@<tool id>;`) when that release failed, so the
 * session may retry it: the hook honours `+N@<tool id>;` only right after that same call's `-N@<tool id>;`.
 */
export function restoreHeldReportNums(sessionDir: string, nums: readonly number[], toolUseId: string): void {
  if (!TOOL_USE_ID.test(toolUseId)) return;
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.appendFileSync(path.join(sessionDir, HELD_REPORT_NUMS_FILE), nums.map((n) => `\n+${n}@${toolUseId};`).join(''));
}

/**
 * Gives back each hold a release let go whose sentinel is still the reservation it named: that release never ran, or
 * failed before deleting it (the CLI killed after the hook let it through leaves no result to restore it from). Only
 * between turns, while no release of the session's can be running. Records are read as guard-hook.mjs reads them.
 */
export function reconcileHeldReportNums(sessionDir: string, dataRoot: string): void {
  const records = readHeldRecords(sessionDir);
  if (records === null) return;
  const restored = [...records.letGo].flatMap(([n, { at }]) => (at !== null && readSentinelIdentity(dataRoot, n)?.key === at ? [`\n+${n}=${at};`] : []));
  if (restored.length) fs.appendFileSync(path.join(sessionDir, HELD_REPORT_NUMS_FILE), restored.join(''));
}

/** The tool ids the CLI hands out (toolu_...); anything else is never written into a hold record. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The numbers a reserve-report-num.mjs --release command names, as the script reads them; empty for any other command. */
function releasedReportNums(command: string): number[] {
  const tokens = tokenize(command);
  if (tokens === null || tokens[0] !== 'node' || tokens[1] !== 'reserve-report-num.mjs' || tokens[2] !== '--release') return [];
  const m = (tokens[3] ?? '').match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return [];
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 50) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/** The Bash commands of a stream-json assistant line by tool id, whole: a tool.use event keeps only their first 200 characters. */
export function bashCommandsIn(line: string): Map<string, string> {
  const out = new Map<string, string>();
  let obj: { type?: unknown; message?: { content?: unknown } };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return out;
  }
  if (obj?.type !== 'assistant' || !Array.isArray(obj.message?.content)) return out;
  for (const b of obj.message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown } }>) {
    if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') out.set(String(b.id), b.input.command);
  }
  return out;
}

/**
 * The text of each tool result in a user stream line, by tool id: the tool.result event keeps only a result's first 400
 * characters, and lines a reserve run printed before its reservation may push that out of it.
 */
export function toolResultsIn(line: string): Map<string, string> {
  const out = new Map<string, string>();
  let obj: { type?: unknown; message?: { content?: unknown } };
  try {
    obj = JSON.parse(line) as typeof obj;
  } catch {
    return out;
  }
  if (obj?.type !== 'user' || !Array.isArray(obj.message?.content)) return out;
  for (const b of obj.message.content as Array<{ type?: unknown; tool_use_id?: unknown; content?: unknown }>) {
    if (b?.type !== 'tool_result') continue;
    const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ type?: unknown; text?: unknown }>).flatMap((c) => (c?.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n') : null;
    if (text !== null) out.set(String(b.tool_use_id), text);
  }
  return out;
}

/** Whether a Bash command is a reserve-report-num.mjs run that reserves (the script reserves unless told to help, release or gc). */
function reservesReportNums(command: string): boolean {
  const tokens = tokenize(command);
  return tokens !== null && tokens[0] === 'node' && tokens[1] === 'reserve-report-num.mjs' && !['--help', '-h', '--release', '--gc'].includes(tokens[2] ?? '');
}

/** The numbers a reserve run printed: its last output line, `042` or `042-049`. */
export function printedReservation(output: string): number[] {
  // The CLI puts a run's stderr after its stdout: a warning may follow the line the allocator printed.
  const m = output
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)(?:-(\d+))?$/))
    .findLast((x) => x !== null);
  if (!m) return [];
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 50) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/**
 * Held in a session's guard folder while a process checks the session idle and starts its next turn (until beginTurn
 * marks it running): two server processes on one data root (blue/green) would otherwise both start a paid turn on it.
 */
const TURN_CLAIM_FILE = 'turn.claim';
/**
 * Held in a session's guard folder by the one tracker following its latest turn, from track() until the turn and what it
 * kept (report number, policy ack) are settled: every other process counts the session as still finishing meanwhile.
 */
const TRACK_CLAIM_FILE = 'track.claim';
/** How often a tracker standing by for another process's track claim asks for it again. */
const TRACK_STANDBY_RETRY_MS = 2000;
export { turnClaimGone } from './process-claim.js';

export interface ManagerDeps {
  readToken: TokenReader;
  exec: Exec;
  pollMs?: number;
  playwrightAvailable?: boolean;
  /** The home directory a root may not be or contain (tests point it at a temp root). */
  home?: string;
  /** The first delay before a failed policy-pass ack is tried again (POLICY_ACK_RETRY_MS by default). */
  policyAckRetryMs?: number;
  /** How long a stopped turn's session stays busy while its run record cannot be read (UNREADABLE_RUN_WAIT_MS by default). */
  unreadableRunWaitMs?: number;
}

/** A name that is entirely a date (a digest) is no report, as the allocator reads it (reserve-report-num.mjs). */
function isBareDateFile(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(name);
}

/** Scripts that rewrite data/pdf-index.tsv without a lock (generate-cover-letter.mjs through generate-pdf.mjs's renderer). */
const PDF_INDEX_WRITERS = ['generate-pdf.mjs', 'generate-cover-letter.mjs', 'sync-pdf-flags.mjs'];

/**
 * The runner resources a turn holds. A documents-class turn, or one whose mode file runs a pdf-index writer, holds
 * 'pdf-index', as docs.renderPdf and docs.coverPdf do, so the two never rewrite the manifest at once. Evaluations may run
 * generate-pdf.mjs too but hold nothing: holding it there would make the evaluations of a fan-out run one at a time.
 */
function turnResources(policy: ModePolicy): string[] {
  const scripts = MODES.find((m) => m.id === policy.id)?.scripts ?? [];
  return policy.policyClass === 'documents' || scripts.some((s) => PDF_INDEX_WRITERS.includes(s)) ? ['pdf-index'] : [];
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
  /** The postings (evaluation class and postingKey) this process holds the posting claim of, before their runs exist. */
  private postingHolds = new Set<string>();
  /** The postings a fan-out (Batch evaluate) is starting right now; a subset of postingHolds. */
  private batchStarting = new Set<string>();
  /** The postings a fan-out holding their claim is passing to start() right now: start() takes the claim over. */
  private handingOver = new Set<string>();
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
    const posting = postingKey(input.mode, input.target);
    // Handed over synchronously by the fan-out that holds the claim and is making this call: nothing runs between.
    const handed = posting !== null && this.handingOver.delete(`${evaluationClass(input.mode)}\0${posting}`);
    // Claimed across server processes until the session is recorded and its turn running: two that both found the
    // posting free would each start a paid evaluation of it.
    const unclaim = handed ? () => {} : this.claimReplay({ mode: input.mode, target: input.target }, null);
    try {
      return await this.startTurn(input, policy, onCreated);
    } finally {
      unclaim();
    }
  }

  private async startTurn(input: StartInput, policy: ModePolicy, onCreated?: (meta: SessionMeta) => void): Promise<SessionMeta> {
    const meta = this.store.create({ mode: input.mode, policyClass: policy.policyClass, target: input.target, model: input.model ?? null, reportNum: input.reportNum ?? null, policyBatch: input.policyBatch ?? null });
    onCreated?.(meta);
    return this.runTurn(meta, policy, input.prompt, { resume: false, fork: false, blacklistAllowed: input.blacklistAllowed, original: true });
  }

  /** True while a batch evaluate is starting this posting: a single start of it would write a second report and row. */
  isStartingInBatch(mode: string, target: SessionMeta['target']): boolean {
    const key = postingKey(mode, target);
    return key !== null && this.batchStarting.has(`${evaluationClass(mode)}\0${key}`);
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
    return LIVE_STATUSES.has(m.status) || this.stillFinishing(m);
  }

  async send(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    let meta = this.must(id);
    assertCurrentPolicy(meta);
    const policy = this.turnPolicy(meta.mode);
    // Checked and claimed synchronously: two requests racing past the token read would run two `claude --resume` on one session.
    this.assertIdle(meta);
    const unclaimTurn = this.claimTurn(id);
    try {
      // Read again under the claim: another server process may have started a turn since.
      meta = this.must(id);
      this.assertIdle(meta);
    } catch (err) {
      unclaimTurn();
      throw err;
    }
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
      unclaimTurn();
    }
  }

  async fork(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const first = this.must(id);
    assertCurrentPolicy(first);
    const policy = this.turnPolicy(first.mode);
    // A source with a turn starting or running would get a second paid run beside it, on the conversation it is writing.
    this.assertIdle(first, { finishing: false });
    const unclaimTurn = this.claimTurn(id);
    try {
      this.assertIdle(this.must(id), { finishing: false });
    } catch (err) {
      unclaimTurn();
      throw err;
    }
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
      unclaimTurn();
    }
  }

  /**
   * Runs `fn` on the session's record while no turn can start, run or finish on it in any server process: under its turn
   * claim, after the idle check (a turn still finishing included) on the record read under that claim. `fn` runs
   * synchronously, so nothing starts between the check and its act. Throws BusyError for a busy session; returns undefined,
   * without running `fn`, for one that no longer exists or cannot be read (a malformed id, a torn meta.json).
   */
  whileIdle<T>(id: string, fn: (meta: SessionMeta) => T): T | undefined {
    const before = this.read(id);
    if (before === null) return undefined;
    this.assertIdle(before);
    const unclaimTurn = this.claimTurn(id);
    try {
      // Read again under the claim: another server process may have started a turn since.
      const meta = this.read(id);
      if (meta === null) return undefined;
      this.assertIdle(meta);
      return fn(meta);
    } finally {
      unclaimTurn();
    }
  }

  /**
   * Takes the session's turn claim (TURN_CLAIM_FILE), or replaces one whose holder is gone; a live holder (another server
   * process starting a turn on it) is refused as busy. Returns the release, which removes this claim and only this one.
   */
  private claimTurn(id: string): () => void {
    const unclaim = this.takeSessionClaim(id, TURN_CLAIM_FILE);
    if (!unclaim) throw new BusyError(`session ${id} is starting a turn in another server process`);
    return unclaim;
  }

  /**
   * Takes one of the session's process claims (TURN_CLAIM_FILE, TRACK_CLAIM_FILE), or null while a live process holds it.
   * The release removes this claim and only this one.
   */
  private takeSessionClaim(id: string, name: string): (() => void) | null {
    const dir = this.store.guardDirOf(id);
    const unclaim = takeProcessClaim(path.join(dir, name));
    if (!unclaim) return null;
    return () => {
      unclaim();
      // A session another process deleted after it was read leaves no guard folder made only for this claim; one that
      // holds anything else is left as it is, as is one that cannot be read (a torn meta.json): it may still be there.
      try {
        if (this.store.read(id) !== null) return;
      } catch {
        return;
      }
      try {
        fs.rmdirSync(dir);
      } catch (err) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      }
    };
  }

  /** Whether a live process (this one or a peer) holds the session's turn claim: it is preparing a turn there. */
  private turnClaimHeld(id: string): boolean {
    return processClaimHeld(path.join(this.store.guardDirOf(id), TURN_CLAIM_FILE));
  }

  /** Whether a live process (this one or a peer) holds the session's track claim: its latest turn is not settled yet. */
  private trackClaimHeld(id: string): boolean {
    return processClaimHeld(path.join(this.store.guardDirOf(id), TRACK_CLAIM_FILE));
  }

  /**
   * Whether the session's last turn is still finishing anywhere: tracked here, tracked and not yet settled by another
   * server process (its track claim), or its run still stopping with nobody tracking it.
   */
  private stillFinishing(meta: SessionMeta): boolean {
    return this.active.has(meta.id) || this.trackClaimHeld(meta.id) || this.lastRunStillGoing(meta);
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
    // Another server process may be the one stopping it (a blue/green handover), which this one does not track.
    if (opts.finishing !== false && this.stillFinishing(meta)) throw new BusyError(`session ${meta.id} is still finishing its previous turn`);
  }

  /** Waits (up to RUN_END_WAIT_MS) for a session's ended turn to finish stopping and finalizing; refused when it does not. */
  private async untilFinished(id: string): Promise<void> {
    const deadline = Date.now() + RUN_END_WAIT_MS;
    while (this.stillFinishing(this.must(id))) {
      if (Date.now() > deadline) throw new BusyError(`session ${id} is still finishing its previous turn`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * A replayed original request starts the posting's evaluation again: refused while another session evaluates it, and
   * claimed (as a starting fan-out claims its URLs) until its turn is running, so no start slips in while it prepares.
   * `exceptId` is the session doing the replay, which does not count against itself. Returns the release.
   */
  private claimReplay(meta: Pick<SessionMeta, 'mode' | 'target'> & { id?: string }, exceptId: string | null = meta.id ?? null): () => void {
    const posting = postingKey(meta.mode, meta.target);
    if (posting === null) return () => {};
    const release = this.holdPosting(`${evaluationClass(meta.mode)}\0${posting}`);
    if (!release) throw new BusyError(meta.target.type === 'company' ? `another sponsorship check is already starting for ${meta.target.value?.trim()}` : `another evaluation is already starting ${meta.target.value}`);
    try {
      // Checked under the claim: a peer's session recorded before it let its claim go is seen here.
      const live = this.liveEvaluationFor(meta.mode, meta.target, exceptId ?? undefined);
      if (live) throw new BusyError(`session ${live} is already ${liveWorkOn(meta.target)}`);
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  /**
   * Claims a posting (its evaluation class and postingKey) for a start in this process, in memory and on disk so another
   * server process on the same roots (blue/green) sees it too. Null while either holds it; returns the release.
   */
  private holdPosting(key: string): (() => void) | null {
    if (this.postingHolds.has(key)) return null;
    const unclaim = takeProcessClaim(postingClaimFile(this.cfg.guardRoot, key));
    if (!unclaim) return null;
    this.postingHolds.add(key);
    return () => {
      this.postingHolds.delete(key);
      unclaim();
    };
  }

  /** Parallel evaluations: reserve N report numbers first, hand each session its number in the preamble. */
  async fanOut(input: { mode: string; urls: string[]; model?: string | null }): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
    this.turnPolicy(input.mode);
    // Each session gets a reserved report number for its posting's evaluation, which only a posting evaluation writes.
    if (!isReportGated(input.mode)) throw new ModeRefusedError(`a fan-out only evaluates postings; ${input.mode} is not a posting evaluation mode`);
    // A second evaluation of a posting a live session of the mode's class evaluates (one waiting for the user's reply
    // too: the reply finishes it), or another start is preparing, would write a second report and tracker row for it.
    const cls = evaluationClass(input.mode);
    const key = (url: string) => `${cls}\0${postingKey(input.mode, { type: 'url', value: url })}`;
    const releases = new Map<string, () => void>();
    try {
      // Two spellings of one posting in this batch (a tracking param, a trailing slash) are one evaluation: the first starts.
      const batch = new Map<string, string>();
      const unclaimed = new Set<string>();
      for (const url of input.urls) {
        if (batch.has(key(url))) continue;
        batch.set(key(url), url);
        const held = this.holdPosting(key(url));
        if (!held) {
          unclaimed.add(url);
          continue;
        }
        const posting = key(url);
        this.batchStarting.add(posting);
        releases.set(url, () => {
          this.batchStarting.delete(posting);
          held();
        });
      }
      // Read under the claims: a peer's session recorded before it let its claim go is seen here.
      const live = new Map<string, string>();
      for (const m of this.store.list()) if (evaluationClass(m.mode) === cls && m.target.type === 'url' && m.target.value && this.isLive(m)) live.set(key(m.target.value), m.id);
      const refused: SessionMeta[] = [];
      const urls: string[] = [];
      for (const url of input.urls) {
        const holder = live.get(key(url));
        const twin = batch.get(key(url));
        const why = holder ? `not started: session ${holder} is already evaluating ${url}` : twin !== url ? `not started: ${twin} in this batch is the same posting` : unclaimed.has(url) ? `not started: another evaluation is already starting ${url}` : null;
        if (why) refused.push(unstartedMeta(input.mode, { type: 'url', value: url }, input.model ?? null, why));
        else urls.push(url);
      }
      if (urls.length === 0) return { sessions: refused, reserved: [] };
      // The i-th reserved number goes to the i-th session, so the refused ones come after the started ones.
      const out = await this.startFanOut({ ...input, urls });
      return { sessions: [...out.sessions, ...refused], reserved: out.reserved };
    } finally {
      for (const release of releases.values()) release();
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
        // This fan-out holds the posting's claim: start() takes it over instead of being refused by it.
        const posting = `${evaluationClass(input.mode)}\0${postingKey(input.mode, target)}`;
        this.handingOver.add(posting);
        try {
          sessions.push(await this.start({ mode: input.mode, target, prompt: evaluatePrompt(url), model: input.model ?? null, reportNum: num }, recorded));
          handed.add(num);
        } catch (err) {
          this.handingOver.delete(posting);
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
            try {
              sessions.push(await this.failBeforeSpawn(recorded, message));
            } catch (failErr) {
              // Its record could not be settled either: the others still start, and deleting this one settles it.
              console.warn(`[sessions] session ${recorded.id}: could not record why its first turn did not start: ${(failErr as Error).message}`);
              sessions.push(this.read(recorded.id) ?? { ...recorded, status: 'error', error: message, lastReason: message });
            }
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
    // Another server process preparing a turn here holds its claim and decides alone whether it spawns: answering with the
    // unchanged session would let the turn the user cancelled start. Once it runs, a cancel here stops it. This process's
    // own claim (a fork waiting for its source's cancelled turn to finish) is not that.
    if (!this.sending.has(id) && this.turnClaimHeld(id)) throw new BusyError(`session ${id} is starting a turn in another server process; cancel again once it is running`);
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
    const current = this.store.read(id);
    if (current === null) return this.store.delete(id);
    // A turn another server process runs: only its own process tracks it, so the record is all this one can see. One
    // still queued is preparing under the turn claim taken below.
    this.assertNotRunningElsewhere(current);
    // Another server process starting a turn on the session holds its claim: deleting it now leaves that turn starting
    // on a session that no longer exists.
    const unclaimTurn = this.claimTurn(id);
    try {
      // Read again under the claim: another server process may have started a turn since.
      const claimed = this.store.read(id);
      if (claimed !== null) this.assertNotRunningElsewhere(claimed);
      return await this.deleteClaimed(id);
    } finally {
      unclaimTurn();
    }
  }

  /**
   * Refuses a session whose last turn runs, or was cancelled (here or in another server process) and is still stopping:
   * its Claude process lives until SIGKILL and may yet write the report under the number a delete would release.
   */
  private assertNotRunningElsewhere(meta: SessionMeta): void {
    if (meta.status === 'running') throw new BusyError(`session ${meta.id} is running`);
    if (this.stillFinishing(meta)) throw new BusyError(`session ${meta.id} is still finishing its previous turn`);
  }

  /**
   * Whether the session's last turn has not ended and its run (in this process or another) has not either: a cancelled
   * run keeps its Claude process until SIGKILL. Delete, reply and fork all refuse or wait on it.
   */
  private lastRunStillGoing(meta: SessionMeta): boolean {
    const turn = meta.turns.at(-1);
    if (!turn || turn.endedAt !== null) return false;
    const run = this.runner.store.read(turn.runId);
    if (run === null || run.endedAt !== null || this.runner.store.readExit(turn.runId) !== null) return false;
    // A cancelled run left by a stopped process is taken over here and settled, or followed until it exits.
    return run.status !== 'cancelled' || this.runner.ending(turn.runId);
  }

  private async deleteClaimed(id: string): Promise<boolean> {
    const meta = this.store.read(id);
    const batch = meta?.policyBatch ?? null;
    const num = meta?.reportNum ?? null;
    const credited = num !== null && this.creditedHolds(meta!, num);
    // Taken before the delete removes the record of when the session got the number. A report under the number may be
    // another reservation's (the credited one renamed or deleted, the number collected and claimed again), so the
    // release is always ownership-checked.
    const since = num !== null ? this.ownedSince(meta!, num) : undefined;
    // Claimed before the delete and the await, as finalize does, so the number is released once.
    if (num !== null) this.store.setReportNum(id, null);
    let deleted: boolean;
    try {
      deleted = this.store.delete(id);
    } finally {
      if (num !== null) {
        const released = await this.releaseReportNum(num, credited, since);
        if (released.startsWith('could not') || released.includes('already lost') || released.includes('cannot be read') || released.includes('release attempt that failed')) console.warn(`[sessions] session ${id} deleted: ${released}`);
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
      // One session that cannot be settled must not stop the server's start, the other sessions or the policy-pass acks.
      try {
        this.reconcileSession(meta);
      } catch (err) {
        console.error(`[sessions] session ${meta.id} could not be reconciled: ${(err as Error).stack ?? String(err)}`);
      }
    }
    this.runLeftoverPolicyAcks();
  }

  private reconcileSession(meta: SessionMeta): void {
    const live = meta.status === 'running' || meta.status === 'queued';
    const turn = meta.turns.at(-1);
    if (!live && (!turn || turn.endedAt)) return;
    if (this.active.has(meta.id)) return;
    // A turn this process is preparing is tracked once it spawns: settling it now would release the number it was given.
    if (this.preparing.has(meta.id) || this.sending.has(meta.id)) return;
    let recorded: boolean;
    try {
      recorded = turn !== undefined && this.runner.store.read(turn.runId) !== null;
    } catch {
      // A run record that exists but cannot be read (half-written, unreadable): the turn is tracked all the same, and
      // the tracker's first tick ends it in error while the session keeps its number, as when the read fails mid-turn.
      recorded = true;
    }
    if (!turn || !recorded) {
      // Already settled (a status other than running or queued) with no run to follow: nothing more to record.
      if (!live) return;
      this.settleUnrecorded(meta.id, turn?.runId ?? null);
      return;
    }
    const policy = this.effectivePolicy(meta.mode) ?? policyForClass(meta.policyClass);
    const state = this.readTurnState(meta.id, turn.n);
    this.track(meta.id, turn.n, turn.runId, policy, state, '', { spawned: false });
  }

  /**
   * Ends in error a running session whose last turn (`runId`, null for none) has no run record, under its turn claim
   * with no await inside: another server process (blue/green) preparing its turn holds that claim, one following it holds
   * the track claim, and either settles it. The record is read again under the claim, so a session a peer started again
   * or settled since it was listed is left as that peer recorded it.
   */
  private settleUnrecorded(id: string, runId: string | null): void {
    const unclaimTurn = this.takeSessionClaim(id, TURN_CLAIM_FILE);
    if (!unclaimTurn) return;
    try {
      if (this.trackClaimHeld(id)) return;
      const meta = this.store.read(id);
      const turn = meta?.turns.at(-1);
      if (!meta || !(meta.status === 'running' || meta.status === 'queued') || (turn?.runId ?? null) !== runId) return;
      const reason = 'run record missing after a restart';
      this.store.setStatus(id, 'error', reason);
      // No turn will finalize this session: its reservation goes back to the pool (claimed first, as finalize does).
      if (meta.reportNum !== null) {
        const since = this.ownedSince(meta, meta.reportNum);
        this.store.setReportNum(id, null);
        void this.releaseReportNum(meta.reportNum, false, since);
      }
      this.emit(id, { type: 'status', status: 'error', reason, ...(turn ? { turn: turn.n } : {}) });
    } finally {
      unclaimTurn();
    }
  }

  close(): void {
    // A settle step in flight keeps its track claim until it ends (its own untrack releases it): a peer must not start a
    // turn its late writes would land on.
    for (const [id, tracked] of [...this.active]) {
      if (tracked.timer) clearInterval(tracked.timer);
      tracked.timer = null;
      if (!tracked.settling) this.untrack(id);
    }
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

  /** An event the session record already says: one that cannot be appended is warned of, not thrown. */
  private emitBestEffort(sessionId: string, event: SessionEvent): void {
    try {
      this.emit(sessionId, event);
    } catch (err) {
      console.warn(`[sessions] session ${sessionId}: could not record its ${event.type} event: ${(err as Error).message}`);
    }
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
    const current = this.store.read(meta.id);
    const num = current?.reportNum ?? null;
    // Before any event: an event log that cannot be appended to must not keep the number reserved.
    if (num !== null && meta.turns.length === 0) {
      // Only while still the session's: the stale GC may have collected it and another reservation claimed it since.
      const since = this.ownedSince(current!, num);
      this.store.setReportNum(meta.id, null);
      await this.releaseReportNum(num, false, since);
    }
    this.emitBestEffort(meta.id, { type: 'error', message });
    // Last, so a stream consumer that reloads the session on a terminal status sees the reservation released.
    this.emitBestEffort(meta.id, { type: 'status', status: 'error', reason: message });
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
    if (await this.keepsReservation(meta, num)) {
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
   * Whether a later turn keeps `num`: a sentinel still the session's is refreshed, unless it is younger than the refresh
   * age (no GC collects it before the turn's own ticks refresh it). One whose refresh could not run (the tracker lock
   * stayed busy) was the session's a moment ago, so it is kept as it is rather than failing the reply.
   */
  private async keepsReservation(meta: SessionMeta, num: number): Promise<boolean> {
    const sentinel = this.sentinelPath(num);
    if (readSentinelCreatedAt(sentinel) === null || !this.sentinelOwned(num, this.reservedAt(meta, num))) return false;
    if (Date.now() - (fs.statSync(sentinel, { throwIfNoEntry: false })?.mtimeMs ?? 0) < RESERVATION_REFRESH_AGE_MS) return true;
    try {
      return await this.refreshReservation(meta, num);
    } catch (err) {
      console.warn(`[sessions] session ${meta.id}: could not refresh its reservation of report number ${num}, kept as it is: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * Refreshes `num`'s sentinel when it is still the session's (written no later than the session got the number); false
   * when it is not. The check and the touch run under the tracker lock the stale GC takes, so a sentinel it is collecting
   * is never refreshed after its age was read. Throws when the refresh could not be run (the tracker lock stayed busy).
   */
  private async refreshReservation(meta: SessionMeta, num: number): Promise<boolean> {
    // A sentinel gone or unreadable is not the session's, whatever its record of when it got the number says.
    if (readSentinelCreatedAt(this.sentinelPath(num)) === null) return false;
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
          // A number the turn gave back while the refresh waited for the lock is no loss.
          else if (this.store.read(id)?.reportNum === num) this.warnReservationLost(id, num, readSentinelCreatedAt(sentinel) === null && fs.existsSync(sentinel) ? 'cannot be read, so it is not refreshed or released' : 'was collected while its turn runs; the number may be handed out again');
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
   * report renamed): it holds the number. Once the user deleted it, nothing does. A reports folder that cannot be read
   * proves no report there: the number is then handled as one no report holds (released only while still the session's).
   */
  private creditedHolds(meta: SessionMeta, num: number): boolean {
    if (meta.creditedReport?.num !== num) return false;
    let files: Set<string>;
    try {
      files = snapshotReports(this.cfg.dataRoot);
    } catch (err) {
      // Said once: the tracker asks every tick.
      this.warnOnce(`${meta.id}\0reports`, `[sessions] session ${meta.id}: could not read the reports folder to check report number ${num}: ${(err as Error).message}`);
      return false;
    }
    this.reservationWarned.delete(`${meta.id}\0reports`);
    for (const file of files) if (!isBareDateFile(file) && reportNumberOf(file) === num) return true;
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
    // A send holds the claim already; a new session's (or fork's) is taken here, so another server process refuses to
    // delete it while it prepares.
    const unclaimTurn = claimed ? this.claimTurn(meta.id) : () => {};
    try {
      // Read again under the claim, as send does: another server process may have deleted the session before it.
      if (claimed) this.must(meta.id);
    } catch (err) {
      unclaimTurn();
      throw err;
    }
    if (claimed) this.sending.add(meta.id);
    this.preparing.add(meta.id);
    try {
      return await this.prepareAndSpawn(meta, policy, prompt, opts);
    } finally {
      unclaimTurn();
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
    const current = this.store.read(meta.id);
    const num = current?.reportNum ?? null;
    if (num !== null && meta.turns.length === 0) {
      // Only while still the session's: the stale GC may have collected it and another reservation claimed it since.
      const since = this.ownedSince(current!, num);
      this.store.setReportNum(meta.id, null);
      const reason = `cancelled by the user before the turn started; ${await this.releaseReportNum(num, false, since)}`;
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
      // A later turn, or a reply to a session whose first turn never ran: either may have held its number past the stale
      // GC. Only a new session's own first turn got it a moment ago.
      if (n > 1 || opts.original !== true) meta = await this.reassertReservation(meta);
      // Only a sentinel written no later than the session got the number is its reservation: a first turn that waited past
      // the GC may find another evaluation's sentinel under it.
      // A hold that cannot be recorded only means the hook refuses that release: the turn goes on.
      try {
        reconcileHeldReportNums(sessionDir, this.cfg.dataRoot);
        if (meta.reportNum !== null) recordHeldReportNums(sessionDir, [meta.reportNum], this.cfg.dataRoot, this.ownedSince(meta, meta.reportNum));
      } catch (err) {
        console.warn(`[sessions] session ${meta.id}: could not record the report number it holds: ${(err as Error).message}`);
      }
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
    // A first turn settled by someone else while it prepared (its status changed, its number released) never spawns.
    if (meta.turns.length === 0) {
      const current = this.store.read(meta.id);
      if (current === null || current.status !== meta.status || current.reportNum !== meta.reportNum) {
        this.preparing.delete(meta.id);
        return this.failBeforeSpawn(meta, 'the session was settled while its first turn was being prepared');
      }
    }
    // From here a cancel stops the run like any other.
    this.preparing.delete(meta.id);
    let run: RunMeta;
    try {
      run = this.runner.start({
        actionId: `session.${meta.mode}`,
        label: `${policy.title}: turn ${n}`,
        cost: 'tokens',
        resources: turnResources(policy),
        claude: true,
        params: { sessionId: meta.id, turn: n },
        cmd: { bin: this.cfg.claudeBin, args: argv, cwd: this.cfg.codeRoot },
        env,
      });
    } catch (err) {
      // Nothing was spawned (its run record could not be created): the turn fails like any other that cannot start.
      return this.failBeforeSpawn(meta, (err as Error).message);
    }
    let began: SessionMeta;
    try {
      began = this.store.beginTurn(meta.id, { runId: run.id, userText: prompt });
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
        const current = this.store.read(meta.id);
        const num = current?.reportNum ?? null;
        if (stopped && num !== null && meta.turns.length === 0) {
          const since = this.ownedSince(current!, num);
          this.store.setReportNum(meta.id, null);
          await this.releaseReportNum(num, false, since);
        }
      } catch {
        /* the session record cannot be written either: the next reconcile settles it */
      }
      throw new TurnStartedError(message);
    }
    // The turn is recorded: it is followed (and finalized once) whatever else fails, or a reply would leave it open.
    this.track(meta.id, n, run.id, policy, state, token, { spawned: true });
    try {
      this.emit(meta.id, { type: 'status', status: 'running', turn: n });
      this.bus.publish('session.status', { sessionId: meta.id, status: 'running', mode: meta.mode, turn: n });
    } catch (err) {
      console.error(`[sessions] session ${meta.id} turn ${n}: could not record its running status: ${(err as Error).message}`);
    }
    return began;
  }

  /** `spawned`: the turn is one this process just spawned, under the session's turn claim it still holds. */
  private track(id: string, n: number, runId: string, policy: ModePolicy, state: TurnState, token: string, opts: { spawned: boolean }): void {
    if (this.active.has(id)) return;
    const tracked: Tracked = { timer: null, release: this.claimTrack(id, opts.spawned), settling: false };
    this.active.set(id, tracked);
    const progressFile = path.join(this.store.guardDirOf(id), 'turns', String(n), 'progress.json');
    const parser = new StreamParser();
    let seq = 0;
    let offset = 0;
    let envelopes = 0;
    // Bash calls of this turn that reserve report numbers, until their result shows which.
    const reserveRuns = new Set<string>();
    // Bash calls of this turn that release report numbers, by tool id: a failed one gives its holds back.
    const releaseRuns = new Map<string, number[]>();
    const envelopeKinds: Partial<Record<EnvelopeKind, number>> = {};
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
      const commands = l.stream === 'stdout' && l.line.includes('"tool_use"') ? bashCommandsIn(l.line) : null;
      const results = l.stream === 'stdout' && l.line.includes('"tool_result"') ? toolResultsIn(l.line) : null;
      for (const ev of events) {
        if (ev.type === 'envelope') {
          envelopes++;
          const kind = ev.kind as EnvelopeKind;
          envelopeKinds[kind] = (envelopeKinds[kind] ?? 0) + 1;
        }
        if (ev.type === 'permission.denied') denials++;
        if (ev.type === 'tool.use' && ev.name === 'Bash') {
          const command = commands?.get(ev.id) ?? ev.summary;
          if (reservesReportNums(command)) reserveRuns.add(ev.id);
          const released = releasedReportNums(command);
          if (released.length) releaseRuns.set(ev.id, released);
        }
        if (ev.type === 'tool.result') {
          const sessionDir = this.store.guardDirOf(id);
          const nums = reserveRuns.delete(ev.id) && ev.ok ? printedReservation(results?.get(ev.id) ?? ev.summary) : [];
          const released = releaseRuns.get(ev.id);
          releaseRuns.delete(ev.id);
          // A replayed result's holds were settled by the server that handled it: the sentinel under a number now may be
          // another evaluation's. For the same reason a hold names only a sentinel written before its output was, and a
          // hold that cannot be recorded only means the hook refuses that release: the turn goes on.
          try {
            if (emit && nums.length) recordHeldReportNums(sessionDir, nums, this.cfg.dataRoot, Date.parse(l.ts));
            if (emit && released && !ev.ok) restoreHeldReportNums(sessionDir, released, ev.id);
          } catch (err) {
            console.warn(`[sessions] session ${id}: could not record the report numbers it holds: ${(err as Error).message}`);
          }
        }
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
    const resume = () => {
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
    };
    if (tracked.release) resume();
    let standbyNextAt = Date.now() + TRACK_STANDBY_RETRY_MS;
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
      // Another tracker (a peer server process) follows and settles this turn: this one stands by, and takes over only
      // once that holder is gone, from where its saved progress got to.
      if (!tracked.release) {
        // Asking costs a ps of the holder, so a standby asks every few seconds rather than on every tick.
        if (Date.now() < standbyNextAt) return;
        standbyNextAt = Date.now() + TRACK_STANDBY_RETRY_MS;
        // A turn the holder settled (or a session deleted) is let go, never claimed: there is nothing left to settle.
        // Null when the session cannot be read (a torn meta.json): the standby asks again on its next try.
        const settled = (): boolean | null => {
          try {
            const meta = this.store.read(id);
            return !meta || Boolean(meta.turns.find((t) => t.n === n)?.endedAt);
          } catch (err) {
            console.warn(`[sessions] session ${id}: could not read it while standing by for its turn ${n}, so it is asked again: ${(err as Error).message}`);
            return null;
          }
        };
        const before = settled();
        if (before === null) return;
        if (before) return this.untrack(id);
        tracked.release = this.claimTrack(id, false);
        if (!tracked.release) return;
        // Asked again under the claim: the holder may have settled it and let go between the two.
        const after = settled();
        if (after === null) {
          // Gives the claim back and stands by again, rather than take over a turn it cannot tell is still open.
          const release = tracked.release;
          tracked.release = null;
          try {
            release();
          } catch (err) {
            console.warn(`[sessions] session ${id}: could not give back the track claim it took while standing by for its turn ${n}: ${(err as Error).message}`);
          }
          return;
        }
        if (after) return this.untrack(id);
        resume();
      }
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
        this.settling(id, () => this.finalizeFailed(id, n, null, { turnDone, denials, failure, keepReservation: true }, err), () => this.untilRunStops(id, runId, state.beforeReports));
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
        this.settling(id, () => this.finalizeFailed(id, n, null, { turnDone, denials, failure }, new Error(`the run record ${runId} is gone`)));
        return;
      }
      if (run.endedAt === null) return;
      clearInterval(timer);
      safePull();
      const ended = run;
      this.settling(id, () => this.finalize(id, n, ended, policy, state, { envelopes, envelopeKinds, denials, sawResult, turnDone, finalText: sawResult ? finalText : parser.text, failure }).catch((err: unknown) => this.finalizeFailed(id, n, ended, { turnDone, denials, failure }, err)));
    }, this.deps.pollMs ?? 250);
    timer.unref();
    tracked.timer = timer;
  }

  /**
   * Takes the session's track claim, or null (the tracker stands by and asks again) while another live tracker holds it.
   * A tracker starts only under the session's turn claim, the one every idle check (send, fork, delete, whileIdle) holds
   * while it trusts that no track claim is held: a turn this process just `spawned` holds it already, and any other
   * tracker (a reconcile, a standby taking over) takes it first, standing by while another process holds it.
   * A track claim that cannot be written (a full disk, a guard folder gone read-only) is warned of: a turn this process
   * just spawned is followed without it (left unfollowed it would never end) unless a live tracker holds the claim, and
   * any other tracker stands by, since it cannot tell whether a live peer is following the turn.
   */
  private claimTrack(id: string, spawned: boolean): (() => void) | null {
    let unclaimTurn: (() => void) | null = null;
    if (!spawned) {
      try {
        unclaimTurn = this.takeSessionClaim(id, TURN_CLAIM_FILE);
      } catch (err) {
        console.warn(`[sessions] session ${id}: could not take its turn claim to follow its turn, so it stands by and asks again: ${(err as Error).message}`);
        return null;
      }
      if (!unclaimTurn) return null;
    }
    try {
      return this.takeSessionClaim(id, TRACK_CLAIM_FILE);
    } catch (err) {
      if (!spawned || this.trackClaimMaybeHeld(id)) {
        console.warn(`[sessions] session ${id}: could not take its track claim, so it stands by and asks again: ${(err as Error).message}`);
        return null;
      }
      console.warn(`[sessions] session ${id}: could not take its track claim, so another server process cannot see it finishing: ${(err as Error).message}`);
      return () => {};
    } finally {
      try {
        unclaimTurn?.();
      } catch (err) {
        console.warn(`[sessions] session ${id}: could not give back the turn claim it took to follow its turn: ${(err as Error).message}`);
      }
    }
  }

  /** Whether a live process may hold the session's track claim: true when that cannot be told either. */
  private trackClaimMaybeHeld(id: string): boolean {
    try {
      return this.trackClaimHeld(id);
    } catch {
      return true;
    }
  }

  /** Runs one settle step of a tracked session, then `next` (by default, untracking it), whether the step failed or not. */
  private settling(id: string, step: () => Promise<void>, next: () => void = () => this.untrack(id)): void {
    const tracked = this.active.get(id);
    if (tracked) tracked.settling = true;
    void step().finally(() => {
      if (tracked) tracked.settling = false;
      next();
    });
  }

  /** The one way a tracked session stops being tracked: its timer stops and its track claim goes. */
  private untrack(id: string): void {
    const tracked = this.active.get(id);
    if (!tracked) return;
    if (tracked.timer) clearInterval(tracked.timer);
    this.active.delete(id);
    try {
      tracked.release?.();
    } catch (err) {
      console.warn(`[sessions] session ${id}: could not remove its track claim: ${(err as Error).message}`);
    }
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
        const since = this.ownedSince(meta, num);
        this.store.setReportNum(id, null);
        reason += `; ${await this.releaseReportNum(num, this.creditedHolds(meta, num) ? true : null, since)}`;
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
   * Keeps the session in `active` while the runner still follows the run's process, then settles the number it kept and
   * drops it. Meanwhile the stop that failed while the record could not be read is tried again, and the number the
   * session kept stays reserved.
   */
  private untilRunStops(id: string, runId: string, beforeReports: string[]): void {
    if (this.closed) return this.untrack(id);
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
        const ending = this.runner.ending(runId);
        unreadableSince = null;
        return ending;
      } catch {
        // Its record is unreadable and the runner does not follow it: nothing here can tell it stopped, so the number is
        // kept (and refreshed) until an exit can be read.
        unreadableSince ??= Date.now();
        return true;
      }
    };
    let unreadableSince: number | null = null;
    const tracked = this.active.get(id);
    if (!tracked) return;
    const settle = () => this.settling(id, () => this.settleKeptReservation(id, beforeReports));
    if (!following()) {
      settle();
      return;
    }
    const timer = setInterval(() => {
      if (unreadableSince !== null && Date.now() - unreadableSince > (this.deps.unreadableRunWaitMs ?? UNREADABLE_RUN_WAIT_MS)) {
        // Still unreadable long after: the session is no longer kept busy by it. Its number stays reserved, no longer
        // refreshed, so the allocator's stale GC frees it once any process that could still write it is long gone.
        clearInterval(timer);
        console.warn(`[sessions] session ${id}: the run record ${runId} still cannot be read; its report number is left to the stale reservation GC`);
        // A report the run already wrote under the number is credited now; nothing would look for it later.
        this.settling(id, () => this.settleKeptReservation(id, beforeReports, false));
        return;
      }
      this.keepReservationFresh(id);
      if (following()) return;
      clearInterval(timer);
      settle();
    }, this.deps.pollMs ?? 250);
    timer.unref();
    tracked.timer = timer;
  }

  /**
   * The number a turn that ended in error kept while its process could still write, settled once that process stopped.
   * Only while the sentinel is still the session's is a report the turn wrote under the number (one not there before
   * the turn) credited, and the sentinel released; a number the stale GC collected may be another reservation's, with
   * that reservation's report, so it is let go without touching either.
   */
  private async settleKeptReservation(id: string, beforeReports: string[], release = true): Promise<void> {
    try {
      const meta = this.store.read(id);
      const num = meta?.reportNum ?? null;
      if (!meta || num === null) return;
      const credited = this.creditedHolds(meta, num);
      const since = this.ownedSince(meta, num);
      const found = credited ? null : (detectNewReports(this.cfg.dataRoot, new Set(beforeReports)).find((x) => x.num === num && !isBareDateFile(x.file)) ?? null);
      // Asked after the scan: a sentinel still the session's now was its own when that report was written.
      const written = found !== null && this.sentinelOwned(num, since ?? null) ? found : null;
      // Claimed before the await, as finalize does, so the number is released once. Not released: the number stays the
      // session's, and a later delete or reply settles it.
      if (release) this.store.setReportNum(id, null);
      if (written) {
        this.store.setCreditedReport(id, written);
        this.emit(id, { type: 'evaluation', reports: [written] });
        this.bus.publish('data.changed', { domain: 'reports' });
      }
      if (!release) return;
      console.warn(`[sessions] session ${id}: its stopped run left report number ${num} behind: ${await this.releaseReportNum(num, credited || written !== null, since)}`);
    } catch (err) {
      console.error(`[sessions] session ${id}: could not settle the report number its stopped run kept: ${(err as Error).message}`);
    }
  }

  private turnEnded(id: string, n: number): boolean {
    return Boolean(this.store.read(id)?.turns.find((t) => t.n === n)?.endedAt);
  }

  private async finalize(id: string, n: number, run: RunMeta, policy: ModePolicy, state: TurnState, r: { envelopes: number; envelopeKinds: Partial<Record<EnvelopeKind, number>>; denials: number; sawResult: boolean; turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; finalText: string; failure: string | null }): Promise<void> {
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
    // A bare-date digest reads as report #YYYY, as the allocator reads it too: it is never this turn's report.
    const found = detectNewReports(this.cfg.dataRoot, new Set(state.beforeReports)).filter((x) => !isBareDateFile(x.file));
    const newReports: NewReport[] = ownReports(found, { reportNum: meta.reportNum, turnFiles: changed });
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
      envelopeKinds: r.envelopeKinds,
      newReports,
      resumed: state.resumed ?? n > 1,
      // Read before this turn's own answers are recorded: a turn that delivers them is done by its envelope.
      answersSeen: meta.answersSeen === true,
      reportProduced: meta.creditedReport !== undefined,
    });
    if ((r.envelopeKinds.answers ?? 0) > 0) this.store.markAnswersSeen(id);
    if (newReports[0]) this.store.setCreditedReport(id, newReports[0]);
    // The sentinel is dropped once the turn is over: a real report now holds the number, or it goes back to the pool.
    let reason = outcome.reason;
    const num = meta.reportNum;
    if (num !== null && outcome.status !== 'awaiting_user') {
      // An earlier turn's credited report holds the number as well as this turn's own new one, while it is still there.
      const creditedHeld = this.creditedHolds(meta, num);
      const used = newReports.some((x) => x.num === num) || creditedHeld;
      // The stale GC may have collected the number and another reservation claimed it (and written a report under it):
      // the sentinel now there, or the one a reservation writes before the release runs, is then someone else's.
      const since = this.ownedSince(meta, num);
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
    // An attempt that failed may have failed after its unlink (the lock release, a timeout): a sentinel gone since then
    // was most likely released by it, not collected.
    const notOwned = () => {
      if (failure && !fs.existsSync(this.sentinelPath(num))) return `the reservation for report number ${num} is gone after a release attempt that failed (${failure}): it was most likely released then`;
      // A report holds the number: its reservation, whoever's it is now, is not this session's to release.
      return used === true ? `report number ${num} is held by a report; its reservation is not the session's, so it is not released` : lost;
    };
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS * (attempt - 1)));
      if (since !== undefined && !this.sentinelOwned(num, since)) return notOwned();
      if (since === undefined) {
        failure = await this.tryReleaseReportNum(num);
      } else {
        const r = await this.settleSentinel('release', num, since!);
        // An unreadable sentinel is still there: whose it is cannot be told, so it is left in place.
        if (r.outcome === 'unreadable') return `the reservation of report number ${num} cannot be read, so it is not released`;
        if (r.outcome && r.outcome !== 'released') return notOwned();
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
export function evaluationClass(mode: string): string {
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
export function postingKey(mode: string, target: SessionMeta['target']): string | null {
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
