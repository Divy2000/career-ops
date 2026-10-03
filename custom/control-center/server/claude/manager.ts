// Session manager (spec 4.1 to 4.3): every Claude turn is a detached run
// through the runner (Claude slot cap applies), the Keychain token is read at
// spawn and only ever lives in the child's env, stdout is normalized into
// events.ndjson, and the honesty gate decides done / awaiting_user.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { ServerConfig } from '../config.js';
import type { Runner } from '../runner/runner.js';
import type { RunMeta } from '../runner/store.js';
import type { EventBus } from '../watch/bus.js';
import type { Exec } from '../routes/system.js';
import { cliScriptPath, CONTRACT } from '../core/adapter.js';
import { SessionStore, type SessionMeta, type StoredEvent } from './sessions.js';
import { StreamParser, type SessionEvent } from './stream-parse.js';
import { buildArgv, buildEnv, buildPreamble, redact, writePolicyFile, writeSettingsFile } from './invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, getModePolicy, type ModePolicy } from './modes.js';
import { decideTurnOutcome, detectNewReports, snapshotReports, type NewReport } from './honesty.js';

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

export interface ManagerDeps {
  readToken: TokenReader;
  exec: Exec;
  pollMs?: number;
  playwrightAvailable?: boolean;
}

export class SessionManager {
  readonly store: SessionStore;
  private listeners = new Set<(sessionId: string, ev: StoredEvent) => void>();
  private active = new Map<string, Tracked>();
  readonly playwrightAvailable: boolean;

  constructor(
    private cfg: ServerConfig,
    private runner: Runner,
    private bus: EventBus,
    private deps: ManagerDeps,
  ) {
    this.store = new SessionStore(cfg.dataRoot);
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

  async start(input: StartInput): Promise<SessionMeta> {
    const policy = this.effectivePolicy(input.mode);
    if (!policy) throw new Error(`unknown mode ${input.mode}`);
    const meta = this.store.create({ mode: input.mode, policyClass: policy.policyClass, target: input.target, model: input.model ?? null, reportNum: input.reportNum ?? null });
    return this.runTurn(meta, policy, input.prompt, { resume: false, fork: false, blacklistAllowed: input.blacklistAllowed });
  }

  async send(id: string, prompt: string, opts: { blacklistAllowed?: boolean } = {}): Promise<SessionMeta> {
    const meta = this.must(id);
    if (meta.status === 'running' || meta.status === 'queued') throw new BusyError(`session ${id} is ${meta.status}`);
    const policy = this.effectivePolicy(meta.mode);
    if (!policy) throw new Error(`unknown mode ${meta.mode}`);
    return this.runTurn(meta, policy, prompt, { resume: meta.turns.length > 0, fork: false, blacklistAllowed: opts.blacklistAllowed });
  }

  async fork(id: string, prompt: string): Promise<SessionMeta> {
    const src = this.must(id);
    const policy = this.effectivePolicy(src.mode);
    if (!policy) throw new Error(`unknown mode ${src.mode}`);
    const forked = this.store.fork(id);
    return this.runTurn(forked, policy, prompt, { resume: true, fork: true });
  }

  /** Parallel evaluations: reserve N report numbers first, hand each session its number in the preamble. */
  async fanOut(input: { mode: string; urls: string[]; model?: string | null }): Promise<{ sessions: SessionMeta[]; reserved: number[] }> {
    const policy = this.effectivePolicy(input.mode);
    if (!policy) throw new Error(`unknown mode ${input.mode}`);
    const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--count', String(input.urls.length)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
    if (r.code !== 0) throw new Error(`reserve-report-num failed (exit ${r.code}): ${r.stderr.trim().slice(-400)}`);
    const reserved = parseReservedRange(r.stdout);
    if (reserved.length !== input.urls.length) throw new Error(`reserve-report-num returned ${reserved.length} numbers for ${input.urls.length} postings: ${r.stdout.trim()}`);
    const sessions: SessionMeta[] = [];
    for (const [i, url] of input.urls.entries()) {
      sessions.push(await this.start({ mode: input.mode, target: { type: 'url', value: url }, prompt: evaluatePrompt(url), model: input.model ?? null, reportNum: reserved[i]! }));
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
    if (this.active.has(id)) throw new BusyError(`session ${id} is still running`);
    return this.store.delete(id);
  }

  /** Server start: sessions left running by a previous process are re-attached or finalized. */
  reconcile(): void {
    for (const meta of this.store.list()) {
      if (meta.status !== 'running' && meta.status !== 'queued') continue;
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
    return path.join(this.store.dirOf(id), 'turns', String(n), 'turn.json');
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
      return fs.readFileSync(path.join(this.store.dirOf(id), 'files.ndjson'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  private async runTurn(meta: SessionMeta, policy: ModePolicy, prompt: string, opts: { resume: boolean; fork: boolean; blacklistAllowed?: boolean }): Promise<SessionMeta> {
    const sessionDir = this.store.dirOf(meta.id);
    const baseDeny = policy.policyClass === 'devchat' ? DEVCHAT_DENIED_WRITES : ALWAYS_DENIED_WRITES;
    const deny = opts.blacklistAllowed ? baseDeny.filter((p) => p !== 'data/blacklist.md') : [...baseDeny];
    const policyFile = writePolicyFile(sessionDir, { codeRoot: this.cfg.codeRoot, dataRoot: this.cfg.dataRoot, policy, extraAllow: opts.blacklistAllowed ? ['data/blacklist.md'] : [], deny });
    const settingsFile = writeSettingsFile(sessionDir);
    const preamble = buildPreamble({ policy, outputLanguage: readOutputLanguage(this.cfg.dataRoot), reportNum: meta.reportNum ?? undefined, blacklistAllowed: opts.blacklistAllowed });
    let token: string;
    try {
      token = await this.deps.readToken();
    } catch (err) {
      const message = (err as Error).message;
      this.store.setStatus(meta.id, 'error', message);
      this.emit(meta.id, { type: 'error', message });
      this.bus.publish('session.status', { sessionId: meta.id, status: 'error', mode: meta.mode });
      return this.store.read(meta.id)!;
    }
    const n = meta.turns.length + 1;
    const env = buildEnv({}, { token, dataRoot: this.cfg.dataRoot, policyFile, sessionDir });
    env.CC_MODE = meta.mode;
    env.CC_TURN_DIR = path.join(sessionDir, 'turns', String(n));
    env.NO_COLOR = '1';
    fs.mkdirSync(env.CC_TURN_DIR, { recursive: true });
    const argv = buildArgv({
      claudeBin: this.cfg.claudeBin,
      codeRoot: this.cfg.codeRoot,
      dataRoot: this.cfg.dataRoot,
      sessionDir,
      policyFile,
      settingsFile,
      policy,
      userMessage: prompt,
      claudeSessionId: meta.claudeSessionId,
      resume: opts.resume,
      fork: opts.fork,
      model: meta.model ?? undefined,
      preamble,
    });
    const state: TurnState = { beforeReports: [...snapshotReports(this.cfg.dataRoot)], filesOffset: this.filesLineCount(meta.id) };
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
    fs.writeFileSync(this.turnStatePath(meta.id, n), JSON.stringify(state));
    this.emit(meta.id, { type: 'status', status: 'running', turn: n });
    this.bus.publish('session.status', { sessionId: meta.id, status: 'running', mode: meta.mode, turn: n });
    this.track(meta.id, n, run.id, policy, state, token);
    return began;
  }

  private track(id: string, n: number, runId: string, policy: ModePolicy, state: TurnState, token: string): void {
    const parser = new StreamParser();
    let seq = 0;
    let offset = 0;
    let envelopes = 0;
    let denials = 0;
    let sawResult = false;
    let turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null = null;
    let finalText = '';
    const pull = () => {
      const { lines, offset: next } = this.runner.store.readRaw(runId, seq, offset);
      offset = next;
      for (const l of lines) {
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
          this.emit(id, ev);
        }
      }
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

  private async finalize(id: string, n: number, run: RunMeta, policy: ModePolicy, state: TurnState, r: { envelopes: number; denials: number; sawResult: boolean; turnDone: Extract<SessionEvent, { type: 'turn.done' }> | null; finalText: string }): Promise<void> {
    const meta = this.store.read(id);
    if (!meta) return;
    const changed = this.changedFiles(id, state.filesOffset);
    if (changed.length) {
      this.emit(id, { type: 'files.changed', paths: changed });
      this.store.addFilesChanged(id, changed);
    }
    const newReports: NewReport[] = detectNewReports(this.cfg.dataRoot, new Set(state.beforeReports));
    if (newReports.length) this.emit(id, { type: 'evaluation', reports: newReports });
    const cancelled = meta.status === 'cancelled' || run.status === 'cancelled';
    const outcome = decideTurnOutcome({
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
    if (meta.reportNum !== null && outcome.status !== 'awaiting_user') reason += `; ${await this.releaseReportNum(id, meta.reportNum, newReports.some((x) => x.num === meta.reportNum))}`;
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
      text = fs.readFileSync(path.join(this.store.dirOf(id), 'files.ndjson'), 'utf8');
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

  private async releaseReportNum(id: string, num: number, used: boolean): Promise<string> {
    const r = await this.deps.exec(process.execPath, [cliScriptPath(this.cfg.codeRoot, 'reserveReportNum'), '--release', String(num)], { cwd: this.cfg.codeRoot, timeoutMs: 20_000, env: { CAREER_OPS_ROOT: this.cfg.dataRoot, NO_COLOR: '1' } });
    const meta = this.store.read(id);
    if (meta) {
      meta.reportNum = null;
      this.store.write(meta);
    }
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
