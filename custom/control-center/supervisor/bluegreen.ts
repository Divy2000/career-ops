// Blue/green server reload (spec 3.1): spawn the new child, wait for health,
// swap, drain the old one. On failure the old child stays and the status says
// why. Spawn and health are injected so the orchestration is unit-tested.
//
// Only one server may track detached runs and Claude sessions at a time, or
// both append the same transcript events and finalize the same turn. A reload
// child starts passive; it is activated (reconciles) only after every older
// child has exited, which happens after it stopped its own trackers on drain.
// There may be no active child at all: the first one could not start (a bad
// Dev Chat edit), and the next reload that comes up takes over at once.

export interface ChildHandle {
  port: number;
  pid: number;
  /** Ask the child to stop its trackers, finish SSE streams and exit on its own. */
  drain(): void;
  kill(): void;
  stderrTail(): string;
  /** Start the work only one server may do at a time: reconcile runs and sessions. */
  activate(): void;
  /** Resolves once the process has exited. */
  exited: Promise<void>;
}

/** `failed` with `crashed`: the active child exited on its own after it started, rather than a new one failing to start. */
export type ReloadState = { state: 'idle' } | { state: 'reloading'; startedAt: string } | { state: 'ok'; at: string; pid: number } | { state: 'failed'; at: string; error: string; stderrTail: string; crashed?: true };
/** How one reload run ended. */
export type ReloadResult = Extract<ReloadState, { state: 'ok' | 'failed' }>;

export class BlueGreen {
  status: ReloadState = { state: 'idle' };
  private listeners = new Set<(s: ReloadState, active: ChildHandle | null) => void>();
  private inFlight: Promise<ReloadResult> | null = null;
  /** The one run queued behind inFlight, shared by every reload asked for while inFlight runs. */
  private queued: Promise<ReloadResult> | null = null;
  /** Settles after every child swapped out so far has exited. */
  private handover: Promise<void> = Promise.resolve();

  constructor(
    public active: ChildHandle | null,
    private spawn: () => Promise<ChildHandle>,
    private health: (port: number) => Promise<void>,
    private opts: { drainMs?: number; now?: () => string } = {},
  ) {}

  /** Status changes, with the active child (null while none could start). */
  onStatus(cb: (s: ReloadState, active: ChildHandle | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(s: ReloadState): void {
    this.status = s;
    for (const l of this.listeners) l(s, this.active);
  }

  /**
   * The active child exited without being asked (it crashed after it started): no child serves until a reload or a
   * restart brings one up, and that one takes over at once. A child that is no longer active is ignored.
   */
  lost(child: ChildHandle, error: string): void {
    if (this.active !== child) return;
    this.active = null;
    this.set({ state: 'failed', at: (this.opts.now ?? (() => new Date().toISOString()))(), error, stderrTail: child.stderrTail(), crashed: true });
  }

  /**
   * Coalesces bursts: a reload asked for while one runs queues exactly one more, and answers with that run's own
   * result, since the run under way may have started from older code.
   */
  reload(): Promise<ReloadResult> {
    if (!this.inFlight) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
      });
      return this.inFlight;
    }
    const next = () => {
      this.queued = null;
      return this.reload();
    };
    this.queued ??= this.inFlight.then(next, next);
    return this.queued;
  }

  private async run(): Promise<ReloadResult> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    this.set({ state: 'reloading', startedAt: now() });
    let fresh: ChildHandle | null = null;
    try {
      fresh = await this.spawn();
      await this.health(fresh.port);
    } catch (err) {
      const tail = fresh?.stderrTail() ?? '';
      fresh?.kill();
      const failed: ReloadResult = { state: 'failed', at: now(), error: (err as Error).message, stderrTail: tail };
      this.set(failed);
      return failed;
    }
    const old = this.active;
    const next = fresh;
    this.active = next;
    const ok: ReloadResult = { state: 'ok', at: now(), pid: next.pid };
    this.set(ok);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (old) {
      old.drain();
      timer = setTimeout(() => old.kill(), this.opts.drainMs ?? 2000);
      if (typeof timer.unref === 'function') timer.unref();
    }
    this.handover = Promise.all([this.handover, old?.exited]).then(() => {
      if (timer) clearTimeout(timer);
      // A later reload may already have replaced (and drained) this child; only the active one reconciles.
      if (this.active === next) next.activate();
    });
    return ok;
  }
}
