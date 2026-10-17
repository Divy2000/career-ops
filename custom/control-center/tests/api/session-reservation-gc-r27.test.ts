import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function settleOn(app: App, id: string, timeoutMs = 30_000): Promise<{ meta: { status: string; reportNum: number | null; lastReason?: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await call(app, 'GET', `/api/sessions/${id}`)).json();
    if (TERMINAL.includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${body.meta.status}`);
    await wait(100);
  }
}
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(25);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
/** A turn held until `go` exists in `dir`, which then exits 1 with no report: it ends in error, so finalize releases its number. */
const heldUntilGo = (dir: string) => ({
  events: [INIT, { __waitFor: { dir, pattern: '^go$', timeoutMs: 20_000 } }, { type: 'result', subtype: 'success', result: 'Gave up.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }],
  exitCode: 1,
});
async function startHeld(app: App, url: string): Promise<{ id: string; n: number; go: () => void }> {
  const gate = tempDir('cc-r27-gate-');
  const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(heldUntilGo(gate)));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: [url] })).json();
    const id = fan.sessions[0].id as string;
    const runId = fan.sessions[0].turns[0].runId as string;
    await until(() => app.runner.store.read(runId)?.childPid != null);
    return { id, n: fan.reserved[0] as number, go: () => fs.writeFileSync(path.join(gate, 'go'), '') };
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);

describe('a reserved report number held by a long-running turn (R27-claude-X-01)', () => {
  it('given a running Batch evaluate turn whose number the stale GC collected and another reservation claimed, when the turn ends, then the other reservation is left alone', async () => {
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-lost');
      fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(Date.now() + 1000).toISOString() }));
      go();

      const { meta } = await settleOn(app, id);
      expect(meta).toMatchObject({ status: 'error', reportNum: null });
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} was already lost`));
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given a running Batch evaluate turn whose sentinel has aged past the stale GC threshold, when the turn is still running, then its sentinel is refreshed so the GC keeps it', async () => {
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-fresh');
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);

      await until(() => Date.now() - fs.statSync(sentinelPath(app, n)).mtimeMs < 60_000);
      go();
      const { meta } = await settleOn(app, id);
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} returned to the pool`));
      expect(fs.existsSync(sentinelPath(app, n))).toBe(false);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given a running Batch evaluate turn whose sentinel the stale GC collected, when the turn ends, then no release runs that could remove a reservation written in the meantime, and the loss is warned of', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const releases: string[] = [];
    const recording: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) releases.push(args[args.indexOf('--release') + 1]!);
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, { exec: recording });
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-gone');
      fs.rmSync(sentinelPath(app, n));
      await until(() => warn.mock.calls.flat().join('\n').includes(`reservation of report number ${n} was collected`));
      go();

      const { meta } = await settleOn(app, id);
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} was already lost`));
      expect(releases).not.toContain(String(n));
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }, 30_000);

  it('given a running Batch evaluate turn whose session record cannot be read for a moment, when the tracker ticks, then nothing is thrown out of the tick and the turn still ends', async () => {
    const app = await makeTestApp();
    try {
      const { id, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-unreadable');
      // Its init event handled first: that reads the record too, and only the refresh is under test here.
      await until(() => app.sessions.read(id)?.conversationStarted === true);
      const read = app.sessions.store.read.bind(app.sessions.store);
      let refused = 0;
      const spy = vi.spyOn(app.sessions.store, 'read').mockImplementation((sid: string) => {
        if (sid !== id) return read(sid);
        refused++;
        throw new Error('EIO: i/o error, read');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const said = () => warn.mock.calls.flat().filter((m) => String(m).includes('could not refresh the reservation')).length;
      await until(() => refused >= 8);
      spy.mockRestore();
      // Said once, not on every tick while the record stays unreadable.
      expect(said()).toBe(1);
      // Once it reads again, a later failure is a new one and is said again.
      await wait(1000);
      const again = refused;
      const spyAgain = vi.spyOn(app.sessions.store, 'read').mockImplementation((sid: string) => {
        if (sid !== id) return read(sid);
        refused++;
        throw new Error('EIO: i/o error, read');
      });
      await until(() => refused >= again + 3);
      spyAgain.mockRestore();
      expect(said()).toBe(2);
      warn.mockRestore();
      go();

      expect((await settleOn(app, id)).meta.status).toBe('error');
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given a running Batch evaluate turn whose aged sentinel cannot be parsed, when the tracker ticks, then it warns the sentinel is unreadable rather than collected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-torn');
      fs.writeFileSync(sentinelPath(app, n), '{ torn');
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);
      await until(() => warn.mock.calls.flat().join('\n').includes(`reservation of report number ${n} cannot be read`));
      expect(warn.mock.calls.flat().join('\n')).not.toContain(`reservation of report number ${n} was collected`);
      go();
      await settleOn(app, id);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }, 30_000);
  it('given a running Batch evaluate turn whose aged sentinel keeps failing to read with an I/O error, when the tracker ticks, then the failure is said once, not on every tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-eisdir');
      await until(() => app.sessions.read(id)?.conversationStarted === true);
      fs.rmSync(sentinelPath(app, n));
      fs.mkdirSync(sentinelPath(app, n));
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);
      const said = () => warn.mock.calls.flat().filter((m) => String(m).includes('could not refresh the reservation')).length;
      await until(() => said() >= 1);
      await wait(1500);
      expect(said()).toBe(1);
      fs.rmSync(sentinelPath(app, n), { recursive: true });
      go();
      await settleOn(app, id);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }, 30_000);

  it('given a running turn credited a report under its number that the user then deleted, when its sentinel ages past the stale GC threshold, then the sentinel is still refreshed', async () => {
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-credited-gone');
      app.sessions.store.setCreditedReport(id, { num: n, file: `${String(n).padStart(3, '0')}-deleted-by-user.md` });
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);

      await until(() => Date.now() - fs.statSync(sentinelPath(app, n)).mtimeMs < 60_000);
      go();
      await settleOn(app, id);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given a waiting session credited a report the user deleted and whose number another reservation then claimed, when the session is deleted, then the other reservation is left alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-delete-credited');
      go();
      await settleOn(app, id);
      // Left as a session awaiting the user holds it: the number still its own, credited a report since deleted.
      app.sessions.store.setReportNum(id, n);
      app.sessions.store.setCreditedReport(id, { num: n, file: `${String(n).padStart(3, '0')}-deleted-by-user.md` });
      fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(Date.now() + 1000).toISOString() }));

      expect((await app.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: app.authedWrite, payload: {} })).statusCode).toBeLessThan(300);
      expect(app.sessions.read(id)).toBeNull();
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }, 30_000);
  it('given a running Batch evaluate turn whose number another reservation claimed, when its run record reads as gone and the turn ends in error, then the other reservation is left alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r27-x01-run-gone');
      const runId = app.sessions.read(id)!.turns[0]!.runId!;
      fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(Date.now() + 1000).toISOString() }));
      const read = app.runner.store.read.bind(app.runner.store);
      vi.spyOn(app.runner.store, 'read').mockImplementation((other) => (other === runId ? null : read(other)));
      // The stop never reaches a process whose record reads as gone: the run is let go so the turn ends promptly.
      go();

      const { meta } = await settleOn(app, id);
      expect(meta).toMatchObject({ status: 'error', reportNum: null });
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} was already lost`));
    } finally {
      vi.restoreAllMocks();
      await app.close();
      warn.mockRestore();
    }
  }, 30_000);
  it('given a session that lost its number while running and was handed the same number again for its next turn, when that reservation is lost too, then the second loss is warned of as well', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lostWarnings = (n: number) => warn.mock.calls.flat().filter((m) => String(m).includes(`reservation of report number ${n} was collected`)).length;
    const app = await makeTestApp();
    try {
      const gate = tempDir('cc-r27-gate-');
      const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
      // Exits 0 with no report: the turn waits for the user and the session keeps its number.
      fs.writeFileSync(file, JSON.stringify({ ...heldUntilGo(gate), exitCode: 0 }));
      process.env.FAKE_CLAUDE_SCENARIO = file;
      try {
        const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r27-x01-lost-twice'] })).json();
        const id = fan.sessions[0].id as string;
        const n = fan.reserved[0] as number;
        await until(() => app.runner.store.read(fan.sessions[0].turns[0].runId as string)?.childPid != null);
        fs.rmSync(sentinelPath(app, n));
        await until(() => lostWarnings(n) === 1);
        fs.writeFileSync(path.join(gate, 'go'), '');
        expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

        fs.rmSync(path.join(gate, 'go'));
        const sent = await call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Try again.' });
        expect(sent.statusCode, sent.body).toBe(202);
        expect(app.sessions.read(id)!.reportNum).toBe(n);
        await until(() => app.runner.store.read(app.sessions.read(id)!.turns[1]!.runId!)?.childPid != null);
        fs.rmSync(sentinelPath(app, n));
        await until(() => lostWarnings(n) === 2);
        fs.writeFileSync(path.join(gate, 'go'), '');
        await settleOn(app, id);
      } finally {
        delete process.env.FAKE_CLAUDE_SCENARIO;
      }
    } finally {
      await app.close();
      warn.mockRestore();
    }
  }, 40_000);
});
