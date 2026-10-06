import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../watch/bus.js';
import { RunStore, type RunMeta } from './store.js';
import { childEnv } from '../system/child-env.js';
import { removeTmpInputs } from '../actions/tmp-inputs.js';

export const WRAPPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wrapper.mjs');

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
export function processStartTime(pid: number, ps: (pid: number) => string = runPs): ProcessStart {
  let out: string;
  try {
    out = ps(pid).trim();
  } catch (err) {
    const e = err as { status?: number | null; signal?: string | null; stdout?: string };
    if (e.status === 1 && !e.signal && !String(e.stdout ?? '').trim()) return null;
    return pidAlive(pid) ? 'unknown' : null;
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

  private procStart: (pid: number) => ProcessStart;

  constructor(
    private dataRoot: string,
    private bus: EventBus,
    private opts: { claudeSlots?: number; pollMs?: number; retention?: number; procStart?: (pid: number) => ProcessStart } = {},
  ) {
    this.store = new RunStore(dataRoot, opts.retention);
    this.procStart = opts.procStart ?? processStartTime;
  }

  /**
   * true: the PID is alive and started when we recorded; false: it is gone, or
   * it now belongs to another process; null: only liveness is known, because no
   * start time was recorded, the recorded one is in the earlier format (ps text
   * in that server's TZ and locale, which cannot be compared), or ps cannot
   * read the start now.
   */
  private identity(pid: number | null | undefined, startedAt: RunMeta['wrapperStartedAt']): boolean | null {
    if (!pid || !pidAlive(pid)) return false;
    if (typeof startedAt !== 'number') return null;
    const now = this.procStart(pid);
    // ps says "no such process" although kill(pid, 0) just found it: gone only if it is gone by now too, else the start
    // cannot be compared and liveness alone decides.
    if (now === null) return pidAlive(pid) ? null : false;
    return now === 'unknown' ? null : now === startedAt;
  }

  /** The start to record for a new PID: a number, or null when it cannot be read. */
  private recordStart(pid: number): number | null {
    const start = this.procStart(pid);
    return typeof start === 'number' ? start : null;
  }

  /**
   * Exactly one process ever moves a queued run on: spawning it, cancelling it
   * and marking it lost all take this O_EXCL claim first, so two server
   * processes (blue/green) can never both start it.
   */
  private claim(id: string): boolean {
    try {
      fs.writeFileSync(path.join(this.store.dirOf(id), 'claim'), String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  }

  /** A run that ended (any way) no longer needs the input files the app wrote for it: those recorded, and any its arguments name. */
  private dropInputs(meta: RunMeta): void {
    removeTmpInputs(this.dataRoot, [...(meta.tmpInputs ?? []), ...meta.cmd.args]);
  }

  get claudeSlots(): number {
    return this.opts.claudeSlots ?? 2;
  }

  /**
   * Server start: pick up runs left running by a previous process. Runs still
   * queued there can never start: the queue and their env (a session's token
   * among it) lived only in that process, so they end as lost and their
   * sessions finalize instead of waiting forever.
   */
  reconcile(): void {
    for (const meta of this.store.list()) {
      if (meta.status === 'queued') {
        if (this.queue.some((q) => q.meta.id === meta.id) || !this.claim(meta.id)) continue;
        this.store.write({ ...meta, status: 'lost', endedAt: new Date().toISOString(), error: 'queued when the server restarted; it never started, so start it again' });
        this.dropInputs(meta);
        this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
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
        const reused = Boolean(meta.wrapperPid && pidAlive(meta.wrapperPid));
        this.store.write({ ...meta, status: 'lost', endedAt: new Date().toISOString(), error: reused ? 'the wrapper PID now belongs to another process (its start time differs); the run is gone' : 'wrapper process disappeared without an exit record' });
        this.dropInputs(meta);
        this.bus.publish('run.status', { runId: meta.id, status: 'lost', actionId: meta.actionId });
      }
    }
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
    });
    const env = childEnv(req.env);
    this.envById.set(meta.id, env);
    this.queue.push({ meta, env });
    this.bus.publish('run.status', { runId: meta.id, status: 'queued', actionId: meta.actionId });
    this.pump();
    return meta;
  }

  private busyResources(): Set<string> {
    const s = new Set<string>();
    for (const { meta } of this.active.values()) for (const r of meta.resources) s.add(r);
    return s;
  }

  private activeClaude(): number {
    return [...this.active.values()].filter((a) => a.meta.claude).length;
  }

  /** Starts what the queue can start now: after a settings change raised the Claude slot cap, say. */
  reschedule(): void {
    this.pump();
  }

  /** FIFO: a queued run starts when its resources are free and a Claude slot is free if it needs one. */
  private pump(): void {
    const busy = this.busyResources();
    let claude = this.activeClaude();
    for (const item of [...this.queue]) {
      const { meta } = item;
      if (meta.resources.some((r) => busy.has(r))) continue;
      if (meta.claude && claude >= this.claudeSlots) continue;
      this.queue = this.queue.filter((q) => q !== item);
      if (!this.spawnRun(item.meta, item.env)) continue;
      for (const r of meta.resources) busy.add(r);
      if (meta.claude) claude++;
    }
  }

  /** False when another process already claimed the run (it was cancelled, marked lost or started elsewhere). */
  private spawnRun(queued: RunMeta, env: NodeJS.ProcessEnv): boolean {
    if (!this.claim(queued.id)) {
      this.envById.delete(queued.id);
      return false;
    }
    const meta = this.store.read(queued.id) ?? queued;
    if (meta.status !== 'queued') return false;
    const runDir = this.store.dirOf(meta.id);
    const child = spawn(process.execPath, [WRAPPER_PATH, runDir, meta.cmd.cwd, meta.cmd.bin, ...meta.cmd.args], {
      detached: true,
      stdio: 'ignore',
      env,
      shell: false,
    });
    child.unref();
    const wrapperPid = child.pid ?? null;
    const running: RunMeta = { ...meta, status: 'running', startedAt: new Date().toISOString(), wrapperPid, wrapperStartedAt: wrapperPid ? this.recordStart(wrapperPid) : null };
    this.store.write(running);
    this.bus.publish('run.status', { runId: meta.id, status: 'running', actionId: meta.actionId });
    this.track(running);
    return true;
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
      } else if (current.wrapperPid && !pidAlive(current.wrapperPid)) {
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
    const status: RunMeta['status'] = meta.status === 'cancelled' || exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL' ? 'cancelled' : exit.code === 0 ? 'done' : 'failed';
    this.store.write({ ...meta, status, endedAt: exit.endedAt, exitCode: exit.code, signal: exit.signal });
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
      if (this.claim(id)) {
        this.envById.delete(id);
        const cancelled: RunMeta = { ...meta, status: 'cancelled', endedAt: new Date().toISOString() };
        this.store.write(cancelled);
        this.dropInputs(cancelled);
        this.bus.publish('run.status', { runId: id, status: 'cancelled', actionId: cancelled.actionId });
        return cancelled;
      }
      // Claimed elsewhere a moment ago: it is starting (or was settled); act on what is on disk now.
      meta = this.store.read(id);
      if (!meta) return null;
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
      // The wrapper forwards SIGTERM to its own child's process group.
      try {
        process.kill(meta.wrapperPid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    return marked;
  }

  queuedIds(): string[] {
    return this.queue.map((q) => q.meta.id);
  }

  close(): void {
    for (const { timer } of this.active.values()) clearInterval(timer);
    this.active.clear();
  }
}
