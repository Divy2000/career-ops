import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../watch/bus.js';
import { RunStore, runsDir, type ExitMeaning, type RunMeta, type RunRequest } from './store.js';
import { createWhole, readOrNull, removeIf, UNREADABLE_LOCK_GRACE_MS } from '../../supervisor/instance-lock.js';
import { childEnv } from '../system/child-env.js';
import { removeTmpInputs } from '../actions/tmp-inputs.js';

export const WRAPPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wrapper.mjs');

/** The one secret a run's env may carry that another process can supply again: a session's Claude token (readToken). */
const TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
/** Names of env variables never written to a run's start request when they hold a value. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;

/**
 * Held (in the runs folder) while a process picks the runs it can start and moves them from queued to running, so
 * two server processes (blue/green) never both count a slot or a resource as free and start a run each.
 */
const SCHEDULE_LOCK = '.schedule.lock';
/** Written in a run's folder just before its wrapper is spawned: a process that dies after it may have started it. */
const STARTING_FILE = 'starting';

/** The process a claim or the schedule lock names: a bare PID in the earlier claim format; null when unreadable. */
function parseHolder(text: string): { pid: number; start: number | null } | null {
  const trimmed = text.trim();
  if (/^[1-9]\d*$/.test(trimmed)) return { pid: Number(trimmed), start: null };
  try {
    const h = JSON.parse(trimmed) as { pid?: unknown; start?: unknown };
    if (!Number.isInteger(h.pid) || (h.pid as number) <= 0) return null;
    return { pid: h.pid as number, start: typeof h.start === 'number' && Number.isFinite(h.start) ? h.start : null };
  } catch {
    return null;
  }
}

export interface StartRequest {
  actionId: string;
  label: string;
  cost: RunMeta['cost'];
  resources: string[];
  claude: boolean;
  params: unknown;
  cmd: { bin: string; args: string[]; cwd: string };
  env?: NodeJS.ProcessEnv;
  /** Input files the app wrote for this run (an argument or only an env value names them); removed when it ends. */
  tmpInputs?: string[];
  /** What one exit code of the command means, when it is not simply failed. */
  exitMeaning?: ExitMeaning;
}

/**
 * kill(pid, 0): 'own' when it succeeds, 'other' when refused (EPERM: the PID runs as another user), 'gone' otherwise.
 * A run's wrapper and child run as this user, so only 'own' can be one of our runs; 'other' is a reused PID.
 */
export function pidLiveness(pid: number, kill: (pid: number, signal: 0) => void = (p, signal) => process.kill(p, signal)): 'own' | 'other' | 'gone' {
  try {
    kill(pid, 0);
    return 'own';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? 'other' : 'gone';
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A process's start in seconds since the epoch; 'unknown' when it runs but its start cannot be read; null when it does not run. */
export type ProcessStart = number | 'unknown' | null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `ps -o lstart` in the C locale: "Mon Oct  5 17:09:12 2026". */
const LSTART = /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** /bin/ps -o lstart= for one PID, in the C locale and UTC whatever this process's environment is. */
const runPs = (pid: number): string =>
  execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });

/**
 * When a process started, so a later check can tell a reused PID apart (PIDs are reused, after a reboot especially;
 * start times are not). ps prints the start in the caller's TZ and locale, so it runs pinned (LC_ALL=C, TZ=UTC) and the
 * answer is seconds since the epoch: a server restarted under another TZ or LANG reads the same number for a live run.
 * ps's own "no such process" (exit 1, nothing printed) is null; when ps cannot answer otherwise, kill(pid, 0) decides
 * between null and 'unknown'; output that does not parse is 'unknown'. Callers treat 'unknown' as running.
 */
export function processStartTime(pid: number, ps: (pid: number) => string = runPs, kill?: (pid: number, signal: 0) => void): ProcessStart {
  let out: string;
  try {
    out = ps(pid).trim();
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; stdout?: string };
    if (e.status === 1 && !e.signal && !String(e.stdout ?? '').trim()) return null;
    return pidLiveness(pid, kill) === 'own' ? 'unknown' : null;
  }
  if (!out) return null;
  const m = LSTART.exec(out);
  const month = m ? MONTHS.indexOf(m[1]!) : -1;
  if (!m || month === -1) return 'unknown';
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000;
}

/**
 * Starts detached runs through wrapper.mjs, tracks them by polling the run
 * directory, orders the app's own writers by resource, and caps Claude runs.
 */
export class Runner {
  readonly store: RunStore;
  private queue: Array<{ meta: RunMeta; env: NodeJS.ProcessEnv }> = [];
  private active = new Map<string, { meta: RunMeta; timer: NodeJS.Timeout }>();
  private envById = new Map<string, NodeJS.ProcessEnv>();
  /** Queued runs another process left, being rebuilt (their token read) before they join the queue. */
  private adopting = new Set<string>();
  /** A later pump, while the queue waits on another process (its runs, its claim, or the schedule lock it holds). */
  private retryTimer: NodeJS.Timeout | null = null;
  /** This process as claims and the schedule lock name it, read once. */
  private self: { pid: number; start: number | null } | null = null;

  private procStart: (pid: number) => ProcessStart;

  constructor(
    private dataRoot: string,
    private bus: EventBus,
    /** readToken: the Claude token, read again to start a session run another process queued (its token is never stored). */
    private opts: { claudeSlots?: number; pollMs?: number; retention?: number; procStart?: (pid: number) => ProcessStart; kill?: (pid: number, signal: 0) => void; nodePath?: string; readToken?: () => Promise<string> } = {},
  ) {
    this.store = new RunStore(dataRoot, opts.retention);
    this.procStart = opts.procStart ?? ((pid) => processStartTime(pid, undefined, opts.kill));
  }

  /**
   * true: the PID is ours and started when we recorded; false: it is gone, or
   * it now belongs to another process (another user's, which kill(pid, 0)
   * refuses, included); null: it is ours but only that is known, because no
   * start time was recorded, the recorded one is in the earlier format (ps text
   * in that server's TZ and locale, which cannot be compared), or ps cannot
   * read the start now.
   */
  private identity(pid: number | null | undefined, startedAt: RunMeta['wrapperStartedAt']): boolean | null {
    if (!pid || !this.ours(pid)) return false;
    if (typeof startedAt !== 'number') return null;
    const now = this.procStart(pid);
    // ps says "no such process" although the PID just answered: it decides only if it is still ours now.
    if (now === null) return this.ours(pid) ? null : false;
    return now === 'unknown' ? null : now === startedAt;
  }

  private liveness(pid: number): 'own' | 'other' | 'gone' {
    return pidLiveness(pid, this.opts.kill);
  }

  /** A process that can be one of our runs: kill(pid, 0) succeeds (a PID another user owns now is not ours). */
  private ours(pid: number): boolean {
    return this.liveness(pid) === 'own';
  }

  /** The start to record for a new PID: a number, or null when it cannot be read. */
  private recordStart(pid: number): number | null {
    const start = this.procStart(pid);
    return typeof start === 'number' ? start : null;
  }

  private holderText(): string {
    this.self ??= { pid: process.pid, start: this.recordStart(process.pid) };
    return JSON.stringify({ ...this.self, nonce: crypto.randomUUID() });
  }

  /**
   * Whether the process a claim or the schedule lock names is gone for good: its PID does not run, or runs a process
   * that started at another time. One that cannot be told apart (no start recorded, ps cannot answer) counts as live.
   * Content that does not parse (a claim cut short by a crash) is gone once it is older than UNREADABLE_LOCK_GRACE_MS.
   */
  private holderGone(file: string, text: string): boolean {
    const holder = parseHolder(text);
    if (!holder) {
      try {
        return Date.now() - fs.statSync(file).mtimeMs >= UNREADABLE_LOCK_GRACE_MS;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    }
    if (holder.pid === process.pid) {
      this.self ??= { pid: process.pid, start: this.recordStart(process.pid) };
      return holder.start !== null && this.self.start !== null && holder.start !== this.self.start;
    }
    const live = this.identity(holder.pid, holder.start);
    if (live !== null) return !live;
    // No start to compare (a bare PID, or none could be read): a process that started after the file was written
    // cannot have written it, so its PID was reused.
    const now = this.procStart(holder.pid);
    if (typeof now !== 'number') return false;
    try {
      return now > fs.statSync(file).mtimeMs / 1000;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * The schedule lock, taken whole (or in place of one whose holder is gone); null while a live process holds it.
   * Returns its release, which removes this lock and only this one.
   */
  private lockSchedule(): (() => void) | null {
    const file = path.join(runsDir(this.dataRoot), SCHEDULE_LOCK);
    const text = this.holderText();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (createWhole(file, text)) {
        return () => {
          if (readOrNull(file) === text) removeIf(file, text);
        };
      }
      const seen = readOrNull(file);
      if (seen === null) continue;
      if (!this.holderGone(file, seen)) return null;
      removeIf(file, seen);
    }
    return null;
  }

  /**
   * Exactly one process ever moves a queued run on: spawning it, cancelling it and marking it lost all take this claim
   * first (created whole, naming this process), so two server processes (blue/green) can never both start it.
   * 'claimed': it was free. 'recovered': the process that held it is gone (it died between claiming the run and
   * settling it); the claim is replaced under the schedule lock (`scheduling`: the caller holds it), so two processes
   * never both replace it, and the caller settles what that process may have begun. 'held': a live process holds it,
   * or the schedule lock it would be replaced under is busy.
   */
  private claim(id: string, scheduling = false): 'claimed' | 'recovered' | 'held' {
    const file = path.join(this.store.dirOf(id), 'claim');
    const text = this.holderText();
    if (createWhole(file, text)) return 'claimed';
    const seen = readOrNull(file);
    if (seen === null || !this.holderGone(file, seen)) return 'held';
    const unlock = scheduling ? null : this.lockSchedule();
    if (!scheduling && !unlock) return 'held';
    try {
      removeIf(file, seen);
      return createWhole(file, text) ? 'recovered' : 'held';
    } finally {
      unlock?.();
    }
  }

  /**
   * A queued run whose claim was taken over from a process that is gone, which may have begun starting it. Null when
   * it never spawned a wrapper: start it as usual. Otherwise it is never started again: its wrapper's exit settles it,
   * a wrapper that recorded itself is tracked as running, and one that recorded nothing yet is told to stop (it reads
   * the cancel file before it spawns the command and again after) and the run ends lost.
   */
  private resumeInterruptedStart(meta: RunMeta): RunMeta | null {
    if (!fs.existsSync(path.join(this.store.dirOf(meta.id), STARTING_FILE))) return null;
    const wrapper = this.store.readWrapper(meta.id);
    const exit = this.store.readExit(meta.id);
    const begun: RunMeta = { ...meta, startedAt: meta.startedAt ?? new Date().toISOString(), wrapperPid: wrapper?.wrapperPid ?? null, childPid: wrapper?.childPid ?? null };
    if (exit) {
      this.finalize(begun, exit);
      return this.store.read(meta.id) ?? begun;
    }
    if (wrapper) {
      const running: RunMeta = { ...begun, status: 'running', wrapperStartedAt: this.recordStart(wrapper.wrapperPid), childStartedAt: wrapper.childPid ? this.recordStart(wrapper.childPid) : null };
      this.store.write(running);
      this.bus.publish('run.status', { runId: meta.id, status: 'running', actionId: meta.actionId });
      this.track(running);
      return running;
    }
    this.store.requestCancel(meta.id);
    const lost: RunMeta = {
      ...meta,
      status: 'lost',
      endedAt: new Date().toISOString(),
      error: 'the server stopped while starting this run, before its wrapper recorded anything; the wrapper was told to stop and the run was not started again, so start it again',
    };
    this.store.write(lost);
    this.envById.delete(meta.id);
    this.dropInputs(lost);
    this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
    return lost;
  }

  /** A run that ended (any way) no longer needs the input files the app wrote for it: those recorded, and any its arguments name. */
  private dropInputs(meta: RunMeta): void {
    removeTmpInputs(this.dataRoot, [...(meta.tmpInputs ?? []), ...meta.cmd.args]);
  }

  get claudeSlots(): number {
    return this.opts.claudeSlots ?? 2;
  }

  /**
   * Server start: pick up runs left running by a previous process, and the runs it still had queued (a blue/green reload
   * drains the old server, whose queue lived in memory): each is queued here again, its env rebuilt from the start
   * request it recorded and a session's token read anew, so it starts once a slot frees, as it would have. A queued run
   * that cannot be rebuilt (recorded by an earlier version, a secret this process cannot supply) ends lost and its
   * session finalizes instead of waiting forever. Claiming decides which process starts a run, so it runs once.
   */
  reconcile(): void {
    for (const meta of this.store.list()) {
      if (meta.status === 'queued') {
        this.adopt(meta);
        continue;
      }
      if (meta.status !== 'running' || this.active.has(meta.id)) continue;
      const exit = this.store.readExit(meta.id);
      const wrapper = this.identity(meta.wrapperPid, meta.wrapperStartedAt);
      if (exit) {
        this.finalize(meta, exit);
      } else if (wrapper !== false) {
        this.track(meta);
      } else {
        // The PID still runs, as ours with another start or as another user's: reused, not just gone.
        const now = meta.wrapperPid ? this.liveness(meta.wrapperPid) : 'gone';
        const error =
          now === 'other'
            ? "the wrapper PID now belongs to another user's process; the run is gone"
            : now === 'own'
              ? 'the wrapper PID now belongs to another process (its start time differs); the run is gone'
              : 'wrapper process disappeared without an exit record';
        this.store.write({ ...meta, status: 'lost', endedAt: new Date().toISOString(), error });
        this.dropInputs(meta);
        this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
      }
    }
  }

  /** Queues a run another process left queued, once its env is rebuilt; one it cannot rebuild ends lost. */
  private adopt(meta: RunMeta): void {
    if (this.queue.some((q) => q.meta.id === meta.id) || this.adopting.has(meta.id)) return;
    let request: RunRequest | null;
    try {
      request = this.store.readRequest(meta.id);
    } catch (err) {
      this.loseQueued(meta, `queued when the server restarted, and its start request could not be read (${(err as Error).message}); start it again`);
      return;
    }
    if (!request) {
      this.loseQueued(meta, 'queued when the server restarted; it never started, so start it again');
      return;
    }
    const missing = request.secrets.filter((k) => k !== TOKEN_VAR || !this.opts.readToken);
    if (missing.length) {
      this.loseQueued(meta, `queued when the server restarted, and ${missing.join(', ')} cannot be supplied again here; start it again`);
      return;
    }
    this.adopting.add(meta.id);
    const given = request;
    const rebuild = async (): Promise<NodeJS.ProcessEnv> => ({ ...given.env, ...(given.secrets.includes(TOKEN_VAR) ? { [TOKEN_VAR]: await this.opts.readToken!() } : {}) });
    rebuild().then(
      (extra) => {
        this.adopting.delete(meta.id);
        const current = this.store.read(meta.id);
        // Settled meanwhile (cancelled, or claimed by the process that queued it): nothing to queue.
        if (current?.status !== 'queued' || this.queue.some((q) => q.meta.id === meta.id)) return;
        const env = childEnv(extra);
        this.envById.set(meta.id, env);
        this.queue.push({ meta: current, env });
        // First in, first out: an adopted run keeps its place ahead of runs queued here later.
        this.queue.sort((x, y) => (x.meta.createdAt < y.meta.createdAt ? -1 : x.meta.createdAt > y.meta.createdAt ? 1 : 0));
        this.pump();
      },
      (err: unknown) => {
        this.adopting.delete(meta.id);
        this.loseQueued(meta, `queued when the server restarted, and the Claude token could not be read to start it (${(err as Error).message}); start it again`);
      },
    );
  }

  /** A queued run that will never start ends lost, unless another process claimed it first (it starts or settled there). */
  private loseQueued(meta: RunMeta, error: string): void {
    const claim = this.claim(meta.id);
    if (claim === 'held') return;
    const current = this.store.read(meta.id) ?? meta;
    if (current.status !== 'queued' || (claim === 'recovered' && this.resumeInterruptedStart(current))) return;
    this.store.write({ ...current, status: 'lost', endedAt: new Date().toISOString(), error });
    this.dropInputs(meta);
    this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
  }

  start(req: StartRequest): RunMeta {
    const meta = this.store.create({
      actionId: req.actionId,
      label: req.label,
      cost: req.cost,
      resources: req.resources,
      claude: req.claude,
      cmd: req.cmd,
      params: req.params,
      tmpInputs: req.tmpInputs ?? [],
      ...(req.exitMeaning ? { exitMeaning: req.exitMeaning } : {}),
    });
    // Recorded so another process can start it if this one drains first: the env given, every secret named, never stored.
    const given = Object.entries(req.env ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
    const secret = ([k, v]: [string, string]) => k === TOKEN_VAR || (v !== '' && SECRET_NAME.test(k));
    this.store.writeRequest(meta.id, { env: Object.fromEntries(given.filter((e) => !secret(e))), secrets: given.filter(secret).map(([k]) => k) });
    const env = childEnv(req.env);
    this.envById.set(meta.id, env);
    this.queue.push({ meta, env });
    this.bus.publish('run.status', { runId: meta.id, status: 'queued', actionId: meta.actionId });
    this.pump();
    return meta;
  }

  /**
   * The runs that hold resources and Claude slots: this process's own, and those running on disk for another process
   * (the old server during a blue/green handover, before this one is activated), so neither runs past the cap.
   */
  private holders(): RunMeta[] {
    const runs = new Map<string, RunMeta>();
    for (const m of this.store.list()) if (m.status === 'running') runs.set(m.id, m);
    for (const { meta } of this.active.values()) runs.set(meta.id, meta);
    return [...runs.values()];
  }

  /** Starts what the queue can start now: after a settings change raised the Claude slot cap, say. */
  reschedule(): void {
    this.pump();
  }

  /**
   * FIFO: a queued run starts when its resources are free and a Claude slot is free if it needs one. The count and the
   * starts happen under the schedule lock, so another process never counts the same slot free meanwhile. While the
   * queue waits on another process (the lock, a claim, or runs only that process tracks), it is pumped again later.
   */
  private pump(): void {
    if (this.queue.length === 0) return;
    const unlock = this.lockSchedule();
    if (!unlock) {
      this.retryLater();
      return;
    }
    let waitsOnOthers = false;
    try {
      this.resumeAbandonedStarts();
      const holders = this.holders();
      const foreign = holders.some((m) => !this.active.has(m.id));
      const busy = new Set(holders.flatMap((m) => m.resources));
      let claude = holders.filter((m) => m.claude).length;
      for (const item of [...this.queue]) {
        const { meta } = item;
        if (meta.resources.some((r) => busy.has(r)) || (meta.claude && claude >= this.claudeSlots)) {
          waitsOnOthers ||= foreign;
          continue;
        }
        const outcome = this.spawnRun(item.meta, item.env);
        if (outcome === 'held') {
          waitsOnOthers = true;
          continue;
        }
        this.queue = this.queue.filter((q) => q !== item);
        if (outcome !== 'started') continue;
        for (const r of meta.resources) busy.add(r);
        if (meta.claude) claude++;
      }
    } finally {
      unlock();
    }
    if (waitsOnOthers) this.retryLater();
  }

  /**
   * Runs still queued on disk whose wrapper a process that is gone may have spawned: their wrapper may hold a slot and
   * resources although nothing counts it, and this queue may not hold them yet (their token still being read), so they
   * are settled here, under the schedule lock, before the count.
   */
  private resumeAbandonedStarts(): void {
    for (const meta of this.store.list()) {
      if (meta.status !== 'queued' || !fs.existsSync(path.join(this.store.dirOf(meta.id), STARTING_FILE))) continue;
      if (this.claim(meta.id, true) === 'held') continue;
      const current = this.store.read(meta.id);
      if (current?.status === 'queued') this.resumeInterruptedStart(current);
    }
  }

  private retryLater(): void {
    if (this.retryTimer) return;
    // Slower than tracking: each try reads every run's meta, and the wait can be as long as another process's run.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, (this.opts.pollMs ?? 250) * 4);
    this.retryTimer.unref();
  }

  /**
   * 'started': it runs now (or was found running). 'held': a live process holds its claim and it is still queued, so
   * it stays in the queue. 'gone': it was settled (here or elsewhere) and leaves the queue.
   */
  private spawnRun(queued: RunMeta, env: NodeJS.ProcessEnv): 'started' | 'held' | 'gone' {
    const claim = this.claim(queued.id, true);
    if (claim === 'held') {
      if (this.store.read(queued.id)?.status === 'queued') return 'held';
      this.envById.delete(queued.id);
      return 'gone';
    }
    const meta = this.store.read(queued.id) ?? queued;
    if (meta.status !== 'queued') return 'gone';
    if (claim === 'recovered') {
      const resumed = this.resumeInterruptedStart(meta);
      if (resumed) return resumed.status === 'running' ? 'started' : 'gone';
    }
    const runDir = this.store.dirOf(meta.id);
    let child: ReturnType<typeof spawn>;
    try {
      fs.writeFileSync(path.join(runDir, STARTING_FILE), '');
      child = spawn(this.opts.nodePath ?? process.execPath, [WRAPPER_PATH, runDir, meta.cmd.cwd, meta.cmd.bin, ...meta.cmd.args], {
        detached: true,
        stdio: 'ignore',
        env,
        shell: false,
      });
    } catch (err) {
      // Refused at once (an argument node will not pass on): the run is claimed, so nothing else would ever settle it.
      this.failToStart(meta, err);
      return 'gone';
    }
    // ENOENT (the app's node was removed by an upgrade), EAGAIN or EMFILE arrive as an 'error' event: without a listener
    // that is an uncaught exception that takes the server child down.
    child.once('error', (err) => {
      const entry = this.active.get(meta.id);
      if (entry) clearInterval(entry.timer);
      this.active.delete(meta.id);
      this.failToStart(this.store.read(meta.id) ?? meta, err);
      this.pump();
    });
    child.unref();
    const wrapperPid = child.pid ?? null;
    const running: RunMeta = { ...meta, status: 'running', startedAt: new Date().toISOString(), wrapperPid, wrapperStartedAt: wrapperPid ? this.recordStart(wrapperPid) : null };
    this.store.write(running);
    this.bus.publish('run.status', { runId: meta.id, status: 'running', actionId: meta.actionId });
    this.track(running);
    return 'started';
  }

  /** A run whose wrapper could not be started ends failed with the reason; its inputs go and its resources are free. */
  private failToStart(meta: RunMeta, err: unknown): void {
    this.envById.delete(meta.id);
    const failed: RunMeta = { ...meta, status: 'failed', endedAt: new Date().toISOString(), error: `could not start the run: ${(err as Error).message}` };
    this.store.write(failed);
    this.dropInputs(failed);
    this.bus.publish('run.status', { runId: meta.id, status: 'failed', actionId: meta.actionId });
  }

  private track(meta: RunMeta): void {
    const timer = setInterval(() => {
      const current = this.store.read(meta.id) ?? meta;
      if (!current.childPid) {
        const w = this.store.readWrapper(meta.id);
        if (w) {
          current.childPid = w.childPid;
          current.childStartedAt = this.recordStart(w.childPid);
          this.store.write(current);
        }
      }
      const exit = this.store.readExit(meta.id);
      if (exit) {
        clearInterval(timer);
        this.active.delete(meta.id);
        this.finalize(current, exit);
        this.pump();
      } else if (current.wrapperPid && !this.ours(current.wrapperPid)) {
        clearInterval(timer);
        this.active.delete(meta.id);
        this.store.write({ ...current, status: 'lost', endedAt: new Date().toISOString(), error: 'wrapper exited without an exit record' });
        this.dropInputs(meta);
        this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
        this.pump();
      }
    }, this.opts.pollMs ?? 250);
    timer.unref();
    this.active.set(meta.id, { meta, timer });
  }

  private finalize(meta: RunMeta, exit: { code: number | null; signal: string | null; endedAt: string }): void {
    let status: RunMeta['status'] = meta.status === 'cancelled' || exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL' ? 'cancelled' : exit.code === 0 ? 'done' : 'failed';
    let error = meta.error;
    const meaning = meta.exitMeaning;
    if (status !== 'cancelled' && meaning && exit.code === meaning.code && !(meaning.onlyWithoutStderr && this.store.readRaw(meta.id).lines.some((l) => l.stream === 'stderr'))) {
      status = meaning.status;
      if (meaning.status === 'failed' && meaning.error) error = meaning.error;
    }
    this.store.write({ ...meta, status, error, endedAt: exit.endedAt, exitCode: exit.code, signal: exit.signal });
    this.envById.delete(meta.id);
    this.dropInputs(meta);
    this.bus.publish('run.status', { runId: meta.id, status, actionId: meta.actionId, exitCode: exit.code });
  }

  /**
   * Queued runs (in this process's queue or only on disk) are claimed and
   * dropped. Running ones get SIGTERM to the process group, SIGKILL after 5 s,
   * but only when the PID still has the start time recorded at spawn; a PID
   * that now belongs to another process is never signalled.
   */
  cancel(id: string): RunMeta | null {
    const queued = this.queue.find((q) => q.meta.id === id);
    if (queued) this.queue = this.queue.filter((q) => q !== queued);
    let meta = this.store.read(id);
    if (!meta) return null;
    if (meta.status === 'queued') {
      const claim = this.claim(id);
      // Claimed elsewhere a moment ago, it is starting (or was settled): act on what is on disk now.
      meta = this.store.read(id);
      if (!meta) return null;
      // Taken over from a process that died starting it: settle what it began, then cancel that like any other.
      if (claim === 'recovered' && meta.status === 'queued') meta = this.resumeInterruptedStart(meta) ?? meta;
      if (claim !== 'held' && meta.status === 'queued') {
        this.envById.delete(id);
        const cancelled: RunMeta = { ...meta, status: 'cancelled', endedAt: new Date().toISOString() };
        this.store.write(cancelled);
        this.dropInputs(cancelled);
        this.bus.publish('run.status', { runId: id, status: 'cancelled', actionId: cancelled.actionId });
        return cancelled;
      }
    }
    if (meta.status !== 'running') return meta;
    const childPid = meta.childPid ?? this.store.readWrapper(id)?.childPid ?? null;
    const child = this.identity(childPid, meta.childStartedAt);
    const wrapper = this.identity(meta.wrapperPid, meta.wrapperStartedAt);
    if (child === false && wrapper === false) {
      if (this.store.readExit(id)) return meta;
      const lost: RunMeta = { ...meta, status: 'lost', endedAt: new Date().toISOString(), error: 'its processes are gone (the PIDs are free or now belong to other processes); nothing was signalled' };
      this.store.write(lost);
      this.dropInputs(lost);
      this.bus.publish('run.status', { runId: id, status: 'lost', actionId: meta.actionId });
      return lost;
    }
    const marked: RunMeta = { ...meta, status: 'cancelled' };
    this.store.write(marked);
    const signalGroup = child === true || (child === null && wrapper !== true);
    if (childPid && signalGroup) {
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        /* group already gone */
      }
      const killTimer = setTimeout(() => {
        if (!this.store.readExit(id) && this.identity(childPid, meta.childStartedAt) !== false) {
          try {
            process.kill(-childPid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }, 5000);
      killTimer.unref();
    } else if (meta.wrapperPid && wrapper !== false) {
      // A wrapper that has not recorded its command yet may still be starting, with no SIGTERM handler: a signal would
      // end it with no exit record. The cancel file stops it instead (read before it spawns and after it records the
      // command); one that has recorded it by now forwards SIGTERM to its command's process group.
      this.store.requestCancel(id);
      if (this.store.readWrapper(id)) {
        try {
          process.kill(meta.wrapperPid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
    }
    return marked;
  }

  /**
   * Starts the run unless this process already has a run of the same action that has not ended, which it returns
   * instead. The check and the enqueue happen in one synchronous step, so two requests at once cannot both start one.
   */
  startUnlessPending(req: StartRequest): RunMeta | { pending: RunMeta } {
    const pending = this.pending(req.actionId)[0];
    return pending ? { pending } : this.start(req);
  }

  /**
   * This process's runs of `actionId` that have not ended: queued first, then running. A queued run another process
   * settled on disk meanwhile (cancelled or marked lost in a blue/green handover) is dropped from the queue, not counted.
   */
  pending(actionId: string): RunMeta[] {
    this.dropSettled((q) => q.meta.actionId === actionId);
    return [...this.queue.map((q) => q.meta), ...[...this.active.values()].map((a) => a.meta)].filter((m) => m.actionId === actionId);
  }

  /** Drops queued runs another process settled on disk meanwhile (cancelled, marked lost, or started there). */
  private dropSettled(which: (q: { meta: RunMeta }) => boolean = () => true): void {
    const settled = this.queue.filter((q) => which(q) && this.store.read(q.meta.id)?.status !== 'queued');
    if (!settled.length) return;
    this.queue = this.queue.filter((q) => !settled.includes(q));
    for (const q of settled) this.envById.delete(q.meta.id);
  }

  queuedIds(): string[] {
    this.dropSettled();
    return this.queue.map((q) => q.meta.id);
  }

  close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const { timer } of this.active.values()) clearInterval(timer);
    this.active.clear();
  }
}
