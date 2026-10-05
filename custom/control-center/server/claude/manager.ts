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
import { SessionStore, type SessionMeta, type StoredEvent } from './sessions.js';
import { StreamParser, type SessionEvent } from './stream-parse.js';
import { assertRootsConfinable, buildArgv, buildEnv, buildPermissions, buildPreamble, redact, toolResultsDirs, writePolicyFile, writeSettingsFile } from './invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, SESSION_POLICY_VERSION, getModePolicy, sessionRefusal, type ModePolicy } from './modes.js';
import { assertApprovedClaude } from './cli-version.js';
import { decideTurnOutcome, detectNewReports, ownReports, snapshotReports, type NewReport } from './honesty.js';
import { recordTurnAfter } from '../../supervisor/recovery.js';

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
  blacklistAllowed?: boolean;
}

interface TurnState {
  beforeReports: string[];
  filesOffset: number;
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
    const meta = this.store.create({ mode: input.mode, policyClass: policy.policyClass, target: input.target, model: input.model ?? null, reportNum: input.reportNum ?? null });
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
      return await this.runTurn(meta, policy, prompt, { resume: meta.turns.length > 0 || forkPending, fork: forkPending, blacklistAllowed: opts.blacklistAllowed });
    } finally {
      this.sending.delete(id);
    }
  }

  async fork(id: string, prompt: string): Promise<SessionMeta> {
    const src = this.must(id);
    assertCurrentPolicy(src);
    const policy = this.turnPolicy(src.mode);
    const forked = this.store.fork(id);
    return this.runTurn(forked, policy, prompt, { resume: true, fork: true });
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
        sessions.push(await this.start({ mode: input.mode, target: { type: 'url', value: url }, prompt: evaluatePrompt(url), model: input.model ?? null, reportNum: num }));
        handed.add(num);
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

  /** Server start: sessions left running by a previous process are re-attached or finalized. */
  reconcile(): void {
    for (const meta of this.store.list()) {
      if (meta.status !== 'running' && meta.status !== 'queued') continue;
      if (this.active.has(meta.id)) continue;
      const turn = meta.turns.at(-1);
      const run = turn ? this.runner.store.read(turn.runId) : null;
      if (!turn || !run) {
        this.store.setStatus(meta.id, 'error', 'run record missing after a restart');
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

  /** A turn that cannot start: the session says why, and its report reservation goes back to the pool. */
  private async failBeforeSpawn(meta: SessionMeta, message: string): Promise<SessionMeta> {
    this.store.setStatus(meta.id, 'error', message);
    this.emit(meta.id, { type: 'error', message });
    const num = this.store.read(meta.id)?.reportNum ?? null;
    if (num !== null) {
      this.store.setReportNum(meta.id, null);
      await this.releaseReportNum(num, false);
    }
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
      state = { beforeReports: [...snapshotReports(this.cfg.dataRoot)], filesOffset: this.filesLineCount(meta.id) };
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
    let denials = 0;
    let sawResult = false;
    let turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null = null;
    let finalText = '';
    const handle = (l: RawLine, emit: boolean) => {
      seq = l.seq;
      const events: SessionEvent[] = l.stream === 'stdout' ? parser.push(l.line) : [{ type: 'stderr', text: redact(l.line, token) }];
      for (const ev of events) {
        if (ev.type === 'envelope') envelopes++;
        if (ev.type === 'permission.denied') denials++;
        if (ev.type === 'turn.done') {
          turnDone = ev;
          sawResult = true;
        }
        if (ev.type === 'text.done') finalText = ev.text;
        // A fork's first turn reports the id --fork-session minted; later turns must resume that one.
        if (ev.type === 'session.init') this.store.adoptForkedClaudeSessionId(id, ev.claudeSessionId);
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
      void this.finalize(id, n, run, policy, state, { envelopes, denials, sawResult, turnDone, finalText: finalText || parser.text });
    }, this.deps.pollMs ?? 250);
    timer.unref();
    this.active.set(id, { timer });
  }

  private turnEnded(id: string, n: number): boolean {
    return Boolean(this.store.read(id)?.turns.find((t) => t.n === n)?.endedAt);
  }

  private async finalize(id: string, n: number, run: RunMeta, policy: ModePolicy, state: TurnState, r: { envelopes: number; denials: number; sawResult: boolean; turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; finalText: string }): Promise<void> {
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
    // A lost run (queued at a restart, or its process vanished) says why, instead of looking like a signal exit.
    const outcome = run.status === 'lost' && !cancelled ? { status: 'error' as const, reason: run.error ?? 'the run was lost without an exit record' } : decideTurnOutcome({
      modeId: meta.mode,
      policyClass: policy.policyClass,
      cancelled,
      exitCode: run.exitCode,
      isError: r.turnDone?.isError ?? false,
      sawResult: r.sawResult,
      finalText: r.finalText,
      envelopeCount: r.envelopes,
      newReports,
    });
    // The sentinel is dropped once the turn is over: a real report now holds the number, or it goes back to the pool.
    let reason = outcome.reason;
    const num = meta.reportNum;
    if (num !== null && outcome.status !== 'awaiting_user') {
      // Claimed before the await, so no other finalize of this turn can release the number again.
      this.store.setReportNum(id, null);
      reason += `; ${await this.releaseReportNum(num, newReports.some((x) => x.num === num))}`;
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

  /** Releases the reservation sentinel; the caller has already cleared (claimed) the session's reportNum. */
  private async releaseReportNum(num: number, used: boolean): Promise<string> {
    const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--release', String(num)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
    if (r.code !== 0) return `could not release the reservation for ${num}: ${(r.stderr || r.stdout).trim().slice(-200)}`;
    return used ? `report number ${num} is now held by the report` : `report number ${num} returned to the pool`;
  }
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
