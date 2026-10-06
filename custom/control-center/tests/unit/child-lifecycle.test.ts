import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { childLifecycle } from '../../server/child-lifecycle.js';

/** The process as the server child sees it: an IPC channel to the supervisor (or none) and process.exit. */
function parent(opts: { ipc?: boolean; connected?: boolean } = {}) {
  const p = Object.assign(new EventEmitter(), opts.ipc === false ? {} : { send: () => true, connected: opts.connected ?? true });
  const exits: number[] = [];
  return { p, exits, exit: (code: number) => void exits.push(code) };
}

/** A close() that finishes only when the test says so, like stopping trackers and draining SSE streams. */
function slowClose() {
  let calls = 0;
  let finish!: () => void;
  const close = () => {
    calls++;
    return new Promise<void>((resolve) => (finish = resolve));
  };
  return { close, calls: () => calls, finish: () => finish() };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('how a server child ends (an orphaned child never outlives its supervisor)', () => {
  it('the supervisor\'s IPC channel closing stops the trackers, then exits 0', async () => {
    const { p, exits, exit } = parent();
    const app = slowClose();
    const reasons: string[] = [];
    const life = childLifecycle(p, exit);
    expect(life.attach(app.close, (r) => reasons.push(r))).toBe(true);
    p.emit('disconnect');
    expect(app.calls()).toBe(1);
    await settle();
    expect(exits).toEqual([]);
    app.finish();
    await settle();
    expect(exits).toEqual([0]);
    expect(reasons).toEqual(['disconnect']);
  });

  it('a drained child (blue/green handover) still finishes its tracker shutdown when the channel then closes: one close, exit only after it', async () => {
    const { p, exits, exit } = parent();
    const app = slowClose();
    const reasons: string[] = [];
    const life = childLifecycle(p, exit);
    life.attach(app.close, (r) => reasons.push(r));
    life.stop('drain');
    p.emit('disconnect');
    life.stop('SIGTERM');
    await settle();
    expect(app.calls()).toBe(1);
    expect(exits).toEqual([]);
    app.finish();
    await settle();
    expect(exits).toEqual([0]);
    expect(reasons).toEqual(['drain']);
  });

  it('a channel that closed while the app was being built: attach refuses (do not listen), closes the app and exits 0', async () => {
    const { p, exits, exit } = parent();
    const life = childLifecycle(p, exit);
    p.emit('disconnect');
    expect(exits).toEqual([]);
    const app = slowClose();
    expect(life.attach(app.close, () => undefined)).toBe(false);
    expect(app.calls()).toBe(1);
    app.finish();
    await settle();
    expect(exits).toEqual([0]);
  });

  it('a channel already closed before the lifecycle was set up (the disconnect event came and went) counts as the supervisor gone', async () => {
    const { p, exits, exit } = parent({ connected: false });
    const life = childLifecycle(p, exit);
    const app = slowClose();
    expect(life.attach(app.close, () => undefined)).toBe(false);
    app.finish();
    await settle();
    expect(exits).toEqual([0]);
  });

  it('a child started without an IPC channel (no supervisor) is not stopped by it', () => {
    const { p, exits, exit } = parent({ ipc: false });
    const life = childLifecycle(p, exit);
    p.emit('disconnect');
    expect(life.attach(slowClose().close, () => undefined)).toBe(true);
    expect(exits).toEqual([]);
  });

  it('a close that fails still exits, with 1, and says why', async () => {
    const { p, exits, exit } = parent();
    const errors: string[] = [];
    const life = childLifecycle(p, exit, (m) => errors.push(m));
    life.attach(() => Promise.reject(new Error('tracker stuck')), () => undefined);
    life.stop('SIGTERM');
    await settle();
    expect(exits).toEqual([1]);
    expect(errors.join('\n')).toMatch(/tracker stuck/);
  });
});
