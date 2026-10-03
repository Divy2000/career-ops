// Blue/green server reload (spec 3.1): spawn the new child, wait for health,
// swap, drain the old one. On failure the old child stays and the status says
// why. Spawn and health are injected so the orchestration is unit-tested.

export interface ChildHandle {
  port: number;
  pid: number;
  /** Ask the child to finish SSE streams and exit on its own. */
  drain(): void;
  kill(): void;
  stderrTail(): string;
}

export type ReloadState = { state: 'idle' } | { state: 'reloading'; startedAt: string } | { state: 'ok'; at: string; pid: number } | { state: 'failed'; at: string; error: string; stderrTail: string };

export class BlueGreen {
  status: ReloadState = { state: 'idle' };
  private listeners = new Set<(s: ReloadState, active: ChildHandle) => void>();
  private inFlight: Promise<boolean> | null = null;
  private pending = false;

  constructor(
    public active: ChildHandle,
    private spawn: () => Promise<ChildHandle>,
    private health: (port: number) => Promise<void>,
    private opts: { drainMs?: number; now?: () => string } = {},
  ) {}

  onStatus(cb: (s: ReloadState, active: ChildHandle) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(s: ReloadState): void {
    this.status = s;
    for (const l of this.listeners) l(s, this.active);
  }

  /** Coalesces bursts: a reload requested while one runs queues exactly one more. */
  reload(): Promise<boolean> {
    if (this.inFlight) {
      this.pending = true;
      return this.inFlight;
    }
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      if (this.pending) {
        this.pending = false;
        void this.reload();
      }
    });
    return this.inFlight;
  }

  private async run(): Promise<boolean> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    this.set({ state: 'reloading', startedAt: now() });
    let fresh: ChildHandle | null = null;
    try {
      fresh = await this.spawn();
      await this.health(fresh.port);
    } catch (err) {
      const tail = fresh?.stderrTail() ?? '';
      fresh?.kill();
      this.set({ state: 'failed', at: now(), error: (err as Error).message, stderrTail: tail });
      return false;
    }
    const old = this.active;
    this.active = fresh;
    this.set({ state: 'ok', at: now(), pid: fresh.pid });
    old.drain();
    const timer = setTimeout(() => old.kill(), this.opts.drainMs ?? 2000);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }
}
