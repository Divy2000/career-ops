// Session manager (spec 4.1 to 4.3): every Claude turn is a detached run
// through the runner (Claude slot cap applies), the Keychain token is read at
// spawn and only ever lives in the child's env, stdout is normalized into
// events.ndjson, and the honesty gate decides done / awaiting_user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { ServerConfig } from '../config.js';
import type { Runner } from '../runner/runner.js';
import type { RawLine, RunMeta } from '../runner/store.js';
import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import { cliScriptPath, CONTRACT } from '../core/adapter.js';
import { conversationStarted, SessionStore, type SessionMeta, type StoredEvent } from './sessions.js';
import { StreamParser, type SessionEvent } from './stream-parse.js';
import { assertRootsConfinable, buildArgv, buildEnv, buildPermissions, buildPreamble, redact, toolResultsDirs, transcriptFiles, writePolicyFile, writeSettingsFile } from './invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, SESSION_POLICY_VERSION, getModePolicy, sessionRefusal, type ModePolicy } from './modes.js';
import { assertApprovedClaude } from './cli-version.js';
import { decideTurnOutcome, detectNewReports, isReportGated, ownReports, snapshotReports, type NewReport } from './honesty.js';
import { markPipelineEvaluated } from '../domains/pipelineProcessed.js';
import { localJdPath } from '../../shared/local-jd.js';
import { recordTurnAfter } from '../../supervisor/recovery.js';
import { ackPolicyPass } from '../domains/policyPass.js';

export type TokenReader = () => Promise<string>;

const KEYCHAIN_HELP = 'Keychain item career-ops-claude-token not found. Run: claude setup-token, then security add-generic-password -U -a "$USER" -s career-ops-claude-token -w';

/** Reads the OAuth token from the Keychain at spawn time; the value never leaves the process except into the child's env. */
export function keychainTokenReader(exec: Exec): TokenReader {
  return async () => {
    if (process.env.NODE_ENV === 'test' && process.env.CC_FAKE_TOKEN) return process.env.CC_FAKE_TOKEN;
    const r = await exec('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'], { timeoutMs: 5000 });
    if (r.code !== 0 || !r.stdout.trim()) throw new Error(KEYCHAIN_HELP);
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

function readProgress(file: string): TurnProgress | null {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TurnProgress>;
    return typeof p.rawSeq === 'number' && typeof p.rawOffset === 'number' ? { rawSeq: p.rawSeq, rawOffset: p.rawOffset } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function writeProgress(file: string, p: TurnProgress): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(p));
  fs.renameSync(`${file}.tmp`, file);
}

export interface ManagerDeps {
  readToken: TokenReader;
  exec: Exec;
  pollMs?: number;
  playwrightAvailable?: boolean;
  /** The home directory a root may not be or contain (tests point it at a temp root). */
  home?: string;
}

export class SessionManager {
  readonly store: SessionStore;
  private listeners = new Set<(sessionId: string, ev: StoredEvent) => void>();
  private active = new Map<string, Tracked>();
  /** Sessions whose next turn is being prepared (before beginTurn marks them running). */
  private sending = new Set<string>();
  readonly playwrightAvailable: boolean;

  constructor(
    private cfg: ServerConfig,
    private runner: Runner,
    private bus: EventBus,
    private deps: ManagerDeps,
  ) {
    this.store = new SessionStore(cfg.dataRoot, cfg.guardRoot);
    this.playwrightAvailable = deps.playwrightAvailable ?? CONTRACT.playwrightMcp.probed === true;
  }

  onEvent(cb: (sessionId: string, ev: StoredEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  list(): SessionMeta[] {
    return this.store.list();
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

  async start(input: StartInput): Promise<SessionMeta> {
    const policy = this.turnPolicy(input.mode);
    const meta = this.store.create({ mode: input.mode, policyClass: policy.policyClass, target: input.target, model: input.model ?? null, reportNum: input.reportNum ?? null, policyBatch: input.policyBatch ?? null });
    return this.runTurn(meta, policy, input.prompt, { resume: false, fork: false, blacklistAllowed: input.blacklistAllowed });
  }

  async send(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const meta = this.must(id);
    assertCurrentPolicy(meta);
    const policy = this.turnPolicy(meta.mode);
    // Checked and claimed synchronously: two requests racing past the token read would run two `claude --resume` on one session.
    if (this.sending.has(id)) throw new BusyError(`session ${id} is starting a turn`);
    if (meta.status === 'running' || meta.status === 'queued') throw new BusyError(`session ${id} is ${meta.status}`);
    this.sending.add(id);
    try {
      // A fork that never reported its own Claude id (even one whose first turn never started) forks the source again;
      // it must never start a fresh conversation under the source's id or append to it.
      const forkPending = meta.forkPending === true;
      return await this.runTurn(meta, policy, prompt, { resume: this.hasConversation(meta) || forkPending, fork: forkPending, blacklistAllowed: opts.blacklistAllowed });
    } finally {
      this.sending.delete(id);
    }
  }

  async fork(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const src = this.must(id);
    assertCurrentPolicy(src);
    const policy = this.turnPolicy(src.mode);
    // A source whose turns never started a conversation has nothing to fork: the copy starts its own.
    if (!this.hasConversation(src)) {
      const fresh = this.store.create({ mode: src.mode, policyClass: src.policyClass, target: src.target, model: src.model, forkedFrom: src.id });
      return this.runTurn(fresh, policy, prompt, { resume: false, fork: false, blacklistAllowed: opts.blacklistAllowed });
    }
    const forked = this.store.fork(id);
    return this.runTurn(forked, policy, prompt, { resume: true, fork: true, blacklistAllowed: opts.blacklistAllowed });
  }

  /** Parallel evaluations: reserve N report numbers first, hand each session its number in the preamble. */
  async fanOut(input: { mode: string; urls: string[]; model?: string | null }): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
    this.turnPolicy(input.mode);
    const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--count', String(input.urls.length)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
    if (r.code !== 0) throw new Error(`reserve-report-num failed (exit ${r.code}): ${r.stderr.trim().slice(-400)}`);
    const reserved = parseReservedRange(r.stdout);
    if (reserved.length !== input.urls.length) {
      for (const num of reserved) await this.releaseReportNum(num, false);
      throw new Error(`reserve-report-num returned ${reserved.length} numbers for ${input.urls.length} postings: ${r.stdout.trim()}`);
    }
    const sessions: SessionMeta[] = [];
    const handed = new Set<number>();
    try {
      for (const [i, url] of input.urls.entries()) {
        const num = reserved[i]!;
        const target = { type: 'url' as const, value: url };
        try {
          sessions.push(await this.start({ mode: input.mode, target, prompt: evaluatePrompt(url), model: input.model ?? null, reportNum: num }));
          handed.add(num);
        } catch (err) {
          // One URL that cannot start must not hide the ones that did: the caller keeps only the failed URLs for a retry.
          const message = (err as Error).message;
          const created = this.store.list().find((m) => m.reportNum === num && m.target.value === url && m.turns.length === 0);
          if (created) {
            handed.add(num);
            sessions.push(await this.failBeforeSpawn(created, message));
          } else {
            sessions.push(unstartedMeta(input.mode, target, input.model ?? null, message));
          }
        }
      }
    } finally {
      // A session releases its own number; the ones never handed to a session go straight back to the pool.
      for (const num of reserved) if (!handed.has(num)) await this.releaseReportNum(num, false);
    }
    return { sessions, reserved };
  }

  cancel(id: string): SessionMeta {
    const meta = this.must(id);
    const turn = meta.turns.at(-1);
    if (turn && (meta.status === 'running' || meta.status === 'queued')) {
      this.runner.cancel(turn.runId);
      this.store.setStatus(id, 'cancelled');
      this.emit(id, { type: 'status', status: 'cancelled', turn: turn.n, reason: 'cancel requested' });
      this.bus.publish('session.status', { sessionId: id, status: 'cancelled', mode: meta.mode });
    }
    return this.store.read(id)!;
  }

  delete(id: string): boolean {
    if (this.active.has(id) || this.sending.has(id)) throw new BusyError(`session ${id} is still running`);
    return this.store.delete(id);
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
          this.store.setReportNum(meta.id, null);
          void this.releaseReportNum(meta.reportNum, false);
        }
        this.emit(meta.id, { type: 'status', status: 'error', reason, ...(turn ? { turn: turn.n } : {}) });
        continue;
      }
      const policy = this.effectivePolicy(meta.mode);
      if (!policy) continue;
      const state = this.readTurnState(meta.id, turn.n);
      this.track(meta.id, turn.n, run.id, policy, state, '');
    }
  }

  close(): void {
    for (const t of this.active.values()) clearInterval(t.timer);
    this.active.clear();
  }

  /**
   * Whether the CLI has a conversation under the session's id to resume: a turn reported session.init, or the CLI
   * saved its transcript (a turn that died before its init event). Neither means a turn starts it with --session-id;
   * if that is ever wrong the CLI refuses the reused id and the transcript is left as it was.
   */
  private hasConversation(meta: SessionMeta): boolean {
    return conversationStarted(meta) || transcriptFiles(this.cfg.claudeProjectsDir, this.cfg.codeRoot, meta.claudeSessionId).some((f) => fs.existsSync(f));
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

  private async runTurn(meta: SessionMeta, policy: ModePolicy, prompt: string, opts: { resume: boolean; fork: boolean; blacklistAllowed?: boolean }): Promise<SessionMeta> {
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
      assertRootsConfinable(this.cfg.codeRoot, this.cfg.dataRoot, this.deps.home ?? os.homedir());
      // The CLI that runs this turn must be a version whose confinement was probed (cached on the binary's stat).
      await assertApprovedClaude(this.cfg.claudeBin, this.cfg.nodeEnv);
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
      return this.failBeforeSpawn(meta, (err as Error).message);
    }
    const run = this.runner.start({
      actionId: `session.${meta.mode}`,
      label: `${policy.title}: turn ${n}`,
      cost: 'tokens',
      resources: [],
      claude: true,
      params: { sessionId: meta.id, turn: n },
      cmd: { bin: this.cfg.claudeBin, args: argv, cwd: this.cfg.codeRoot },
      env,
    });
    const began = this.store.beginTurn(meta.id, { runId: run.id, userText: prompt });
    this.emit(meta.id, { type: 'status', status: 'running', turn: n });
    this.bus.publish('session.status', { sessionId: meta.id, status: 'running', mode: meta.mode, turn: n });
    this.track(meta.id, n, run.id, policy, state, token);
    return began;
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
    const handle = (l: RawLine, emit: boolean) => {
      seq = l.seq;
      if (failure) return;
      try {
        handleLine(l, emit);
      } catch (err) {
        failure = `could not process the session output: ${(err as Error).message}`;
        this.runner.cancel(runId);
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
        if (ev.type === 'text.done') finalText = parser.lastVisibleText;
        // A fork's first turn reports the id --fork-session minted; later turns must resume that one.
        if (ev.type === 'session.init') {
          this.store.adoptForkedClaudeSessionId(id, ev.claudeSessionId);
          this.store.markConversationStarted(id);
        }
        if (emit) this.emit(id, ev);
      }
    };
    // A previous server already turned part of this log into events: rebuild the counters silently and go on from there.
    const saved = readProgress(progressFile);
    if (saved) {
      for (const l of this.runner.store.readRaw(runId).lines) if (l.seq <= saved.rawSeq) handle(l, false);
      seq = saved.rawSeq;
      offset = saved.rawOffset;
    }
    const pull = () => {
      const { lines, offset: next } = this.runner.store.readRaw(runId, seq, offset);
      offset = next;
      for (const l of lines) handle(l, true);
      if (lines.length) writeProgress(progressFile, { rawSeq: seq, rawOffset: offset });
    };
    const timer = setInterval(() => {
      pull();
      const run = this.runner.store.read(runId);
      if (!run || run.status === 'running' || run.status === 'queued') return;
      clearInterval(timer);
      this.active.delete(id);
      pull();
      this.finalize(id, n, run, policy, state, { envelopes, answers, denials, sawResult, turnDone, finalText: finalText || parser.text, failure }).catch((err: unknown) => this.finalizeFailed(id, n, run, { turnDone, denials }, err));
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
  private async finalizeFailed(id: string, n: number, run: RunMeta, r: { turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; denials: number }, err: unknown): Promise<void> {
    const why = `the turn could not be finalized: ${(err as Error).message}`;
    console.error(`[sessions] session ${id} turn ${n}: ${(err as Error).stack ?? why}`);
    try {
      const meta = this.store.read(id);
      if (!meta || this.turnEnded(id, n)) return;
      const cancelled = meta.status === 'cancelled' || run.status === 'cancelled';
      let reason = cancelled ? `cancelled by the user; ${why}` : why;
      const num = meta.reportNum;
      if (num !== null) {
        // Claimed before the await, as finalize does, so the number is released once.
        this.store.setReportNum(id, null);
        reason += `; ${await this.releaseReportNum(num, null)}`;
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
      // Claimed before the await, so no other finalize of this turn can release the number again.
      this.store.setReportNum(id, null);
      reason += `; ${await this.releaseReportNum(num, newReports.some((x) => x.num === num))}`;
    }
    // Only a pass that ends done acknowledges the items it was given; any other outcome leaves them queued for the next run.
    const batch = meta.policyBatch ?? null;
    if (batch !== null && outcome.status === 'done') {
      // Claimed before the await, as the report number is.
      this.store.setPolicyBatch(id, null);
      reason += `; ${await ackPolicyPass(this.deps.exec, this.cfg.codeRoot, this.cfg.dataRoot, batch)}`;
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
  private async releaseReportNum(num: number, used: boolean | null): Promise<string> {
    let r: Awaited<ReturnType<Exec>>;
    try {
      r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--release', String(num)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
    } catch (err) {
      // The number is already let go on the session: a rejection is reported as a failed release is, not thrown.
      return `could not release the reservation for ${num}: ${(err as Error).message}`;
    }
    if (r.code !== 0) return `could not release the reservation for ${num}: ${(r.stderr || r.stdout).trim().slice(-200)}`;
    if (used === null) return `the reservation for report number ${num} was released`;
    return used ? `report number ${num} is now held by the report` : `report number ${num} returned to the pool`;
  }
}

/** What a fan-out answers for a URL whose session could not even be recorded: an error with the reason, saved nowhere. */
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
export class NotFoundError extends Error {}
/** The mode never runs as a session (sessionRefusal); the message says why and what to use instead. */
export class ModeRefusedError extends Error {}
/** The session predates the current confinement (SESSION_POLICY_VERSION): viewable, never resumed or forked. */
export class OutdatedSessionError extends Error {}

function assertCurrentPolicy(meta: SessionMeta): void {
  if ((meta.policyVersion ?? 1) < SESSION_POLICY_VERSION) throw new OutdatedSessionError(`session ${meta.id} started before read confinement; start a new session`);
}
