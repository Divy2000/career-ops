// How a server child ends. The supervisor stops it with SIGTERM, drains it with a message before a blue/green handover,
// or dies itself (killed, crashed) without a word: then its IPC channel closes, possibly before this child has even
// listened, and a child left running would keep tracking runs and sessions next to the next supervisor's. Every path
// stops the trackers once (close) and exits only after that: a later trigger never cuts a running shutdown short, so an
// old child drained during a reload still finishes it.

/** What this needs of `process`: the supervisor's IPC channel, if the child was started with one. */
export interface ParentChannel {
  send?: unknown;
  connected?: boolean;
  once(event: 'disconnect', listener: () => void): unknown;
}

export interface ChildLifecycle {
  /** Starts shutting down; the first call wins and later ones (another signal, the channel closing) are ignored. */
  stop(reason: string): void;
  /**
   * The app is built: from now on a stop closes it before exiting. Returns false when a stop came first (the supervisor
   * went away while the app was being built); the app is then being closed and must not listen.
   */
  attach(close: () => Promise<void>, log: (reason: string) => void): boolean;
}

export function childLifecycle(parent: ParentChannel, exit: (code: number) => void, reportError: (message: string) => void = (m) => console.error(m)): ChildLifecycle {
  let reason: string | null = null;
  let app: { close: () => Promise<void>; log: (reason: string) => void } | null = null;
  const finish = (a: NonNullable<typeof app>, why: string) => {
    a.log(why);
    a.close().then(
      () => exit(0),
      (err: unknown) => {
        reportError(`server child shutdown (${why}) failed: ${(err as Error).stack ?? String(err)}`);
        exit(1);
      },
    );
  };
  const stop = (why: string) => {
    if (reason !== null) return;
    reason = why;
    if (app) finish(app, why);
  };
  // Started by the supervisor: its channel closing stops this child, and so does a channel that closed before this ran
  // (the disconnect event has then come and gone).
  if (typeof parent.send === 'function') {
    parent.once('disconnect', () => stop('disconnect'));
    if (parent.connected === false) stop('disconnect');
  }
  return {
    stop,
    attach(close, log) {
      app = { close, log };
      if (reason === null) return true;
      finish(app, reason);
      return false;
    },
  };
}
