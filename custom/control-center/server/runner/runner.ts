import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../watch/bus.js';
import { RunStore, type RunMeta } from './store.js';

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
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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

  constructor(
    private dataRoot: string,
    private bus: EventBus,
    private opts: { claudeSlots?: number; pollMs?: number; retention?: number } = {},
  ) {
    this.store = new RunStore(dataRoot, opts.retention);
  }

  get claudeSlots(): number {
    return this.opts.claudeSlots ?? 2;
  }

  /** Server start: pick up runs left running by a previous process. */
  reconcile(): void {
    for (const meta of this.store.list()) {
      if (meta.status !== 'running') continue;
      const exit = this.store.readExit(meta.id);
      if (exit) {
        this.finalize(meta, exit);
      } else if (meta.wrapperPid && pidAlive(meta.wrapperPid)) {
        this.track(meta);
      } else {
        this.store.write({ ...meta, status: 'lost', endedAt: new Date().toISOString(), error: 'wrapper process disappeared without an exit record' });
        this.bus.publish('run.status', { runId: meta.id, status: 'lost' });
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
    });
    const env = { ...process.env, ...req.env };
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

  /** FIFO: a queued run starts when its resources are free and a Claude slot is free if it needs one. */
  private pump(): void {
    const busy = this.busyResources();
    let claude = this.activeClaude();
    for (const item of [...this.queue]) {
      const { meta } = item;
      if (meta.resources.some((r) => busy.has(r))) continue;
      if (meta.claude && claude >= this.claudeSlots) continue;
      this.queue = this.queue.filter((q) => q !== item);
      this.spawnRun(item.meta, item.env);
      for (const r of meta.resources) busy.add(r);
      if (meta.claude) claude++;
    }
  }

  private spawnRun(meta: RunMeta, env: NodeJS.ProcessEnv): void {
    const runDir = this.store.dirOf(meta.id);
    const child = spawn(process.execPath, [WRAPPER_PATH, runDir, meta.cmd.cwd, meta.cmd.bin, ...meta.cmd.args], {
      detached: true,
      stdio: 'ignore',
      env,
      shell: false,
    });
    child.unref();
    const running: RunMeta = { ...meta, status: 'running', startedAt: new Date().toISOString(), wrapperPid: child.pid ?? null };
    this.store.write(running);
    this.bus.publish('run.status', { runId: meta.id, status: 'running', actionId: meta.actionId });
    this.track(running);
  }

  private track(meta: RunMeta): void {
    const timer = setInterval(() => {
      const current = this.store.read(meta.id) ?? meta;
      if (!current.childPid) {
        const w = this.store.readWrapper(meta.id);
        if (w) {
          current.childPid = w.childPid;
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
    this.bus.publish('run.status', { runId: meta.id, status, actionId: meta.actionId, exitCode: exit.code });
  }

  /** SIGTERM the process group, SIGKILL after 5 s; queued runs are simply dropped. */
  cancel(id: string): RunMeta | null {
    const queued = this.queue.find((q) => q.meta.id === id);
    if (queued) {
      this.queue = this.queue.filter((q) => q !== queued);
      const cancelled: RunMeta = { ...queued.meta, status: 'cancelled', endedAt: new Date().toISOString() };
      this.store.write(cancelled);
      this.bus.publish('run.status', { runId: id, status: 'cancelled', actionId: cancelled.actionId });
      return cancelled;
    }
    const meta = this.store.read(id);
    if (!meta || meta.status !== 'running') return meta;
    const pgid = meta.childPid ?? this.store.readWrapper(id)?.childPid ?? null;
    const marked: RunMeta = { ...meta, status: 'cancelled' };
    this.store.write(marked);
    if (pgid) {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        /* group already gone */
      }
      const killTimer = setTimeout(() => {
        if (!this.store.readExit(id)) {
          try {
            process.kill(-pgid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }, 5000);
      killTimer.unref();
    } else if (meta.wrapperPid) {
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
