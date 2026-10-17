import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { acquireTrackerLock, resolveTrackerPath, trackerLockDirFor } from '../../../../tracker-utils.mjs';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['done', 'awaiting_user', 'error', 'cancelled'];
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
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
const NO_REPORT = { events: [INIT, { type: 'result', subtype: 'success', result: 'The posting needs a login; I could not read it.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }] };
/** A turn held until `go` exists in `dir`, which then exits 1 with no report. */
const heldUntilGo = (dir: string) => ({
  events: [INIT, { __waitFor: { dir, pattern: '^go$', timeoutMs: 20_000 } }, { type: 'result', subtype: 'success', result: 'Gave up.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }],
  exitCode: 1,
});
async function withScenario<T>(scenario: unknown, fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-r28-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
async function startHeld(app: App, url: string): Promise<{ id: string; n: number; go: () => void }> {
  const gate = tempDir('cc-r28-gate-');
  const fan = await withScenario(heldUntilGo(gate), async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: [url] })).json());
  const id = fan.sessions[0].id as string;
  const runId = fan.sessions[0].turns[0].runId as string;
  await until(() => app.runner.store.read(runId)?.childPid != null);
  return { id, n: fan.reserved[0] as number, go: () => fs.writeFileSync(path.join(gate, 'go'), '') };
}
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);
const reportPath = (app: App, file: string) => path.join(app.cfg.dataRoot, 'reports', file);
/** The stale-sentinel GC removed the session's sentinel and a new reservation claimed the number again at `at`. */
const reclaim = (app: App, n: number, at: number) =>
  fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(at).toISOString() }));

/** Starts a held Batch evaluate turn, then makes its run record unreadable until it ends in error keeping its number. */
async function keptAfterError(app: App, url: string): Promise<{ id: string; n: number; runId: string; go: () => void }> {
  const { id, n, go } = await startHeld(app, url);
  const runId = app.sessions.read(id)!.turns[0]!.runId!;
  const read = app.runner.store.read.bind(app.runner.store);
  const spy = vi.spyOn(app.runner.store, 'read').mockImplementation((rid: string) => {
    if (rid === runId) throw new Error('EIO: i/o error, read');
    return read(rid);
  });
  await until(() => app.sessions.read(id)?.status === 'error');
  expect(app.sessions.read(id)!.reportNum).toBe(n);
  spy.mockRestore();
  return { id, n, runId, go };
}

describe('a credited report that holds its number (R27-mgr-rev-01)', () => {
  it('given a waiting session credited a report that was renamed since and whose sentinel is gone, when the user deletes it, then nothing claims the number was lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 74);
      app.sessions.store.setCreditedReport(meta.id, { num: 74, file: '074-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(reportPath(app, '074-acme-corp-2026-10-11.md'), '# Acme Corp\n');

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  // chmod does not stop root, so as root there is no EACCES to provoke.
  it.skipIf(process.getuid?.() === 0)('given a waiting session credited a report, when the reports folder cannot be read, then the user can still delete it', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reports = path.join(app.cfg.dataRoot, 'reports');
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 75);
      app.sessions.store.setCreditedReport(meta.id, { num: 75, file: '075-acme-2026-10-11.md' });
      fs.mkdirSync(reports, { recursive: true });
      fs.chmodSync(reports, 0o000);

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(app.sessions.read(meta.id)).toBeNull();
    } finally {
      fs.chmodSync(reports, 0o755);
      warn.mockRestore();
      await app.close();
    }
  });

  it.skipIf(process.getuid?.() === 0)('given a running turn credited a report under its number, when the reports folder cannot be read for several ticks, then that is said once', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reports = path.join(app.cfg.dataRoot, 'reports');
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r28-credited-unreadable-ticks');
      app.sessions.store.setCreditedReport(id, { num: n, file: `${String(n).padStart(3, '0')}-acme-2026-10-11.md` });
      fs.chmodSync(reports, 0o000);
      await wait(1000);
      fs.chmodSync(reports, 0o755);
      expect(warn.mock.calls.flat().filter((m) => String(m).includes('could not read the reports folder')).length).toBe(1);
      go();
      await settleOn(app, id);
    } finally {
      fs.chmodSync(reports, 0o755);
      warn.mockRestore();
      await app.close();
    }
  }, 40_000);

  it('given a waiting session whose credited report is gone and another reservation claimed the number and wrote its report, when the user deletes it, then the other reservation keeps its sentinel', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 76);
      app.sessions.store.setCreditedReport(meta.id, { num: 76, file: '076-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      reclaim(app, 76, Date.now() + 1000);
      fs.writeFileSync(reportPath(app, '076-globex-2026-10-17.md'), '# Globex\n');

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(fs.existsSync(sentinelPath(app, 76))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelPath(app, 76), 'utf8')).token).toBe('someone-else');
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('given a waiting session whose credited report was deleted and whose sentinel is gone, when the user deletes it, then the number reads as lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 75);
      app.sessions.store.setCreditedReport(meta.id, { num: 75, file: '075-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/report number 75 was already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
  it('given a waiting session whose credited report was deleted and a bare-date digest shares its number, when the user deletes it, then the number reads as lost', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      app.sessions.store.setReportNum(meta.id, 2026);
      app.sessions.store.setCreditedReport(meta.id, { num: 2026, file: '2026-acme-2026-10-11.md' });
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(reportPath(app, '2026-10-17.md'), '# Digest\n');

      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/report number 2026 was already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

describe('a turn that writes a bare-date digest (R27-mgr-rev-01 review follow-up)', () => {
  it('given a waiting session holding number 2026, when its reply writes a bare-date digest, then the digest is not credited as its report', async () => {
    const app = await makeTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://jobs.example.com/synthetic/r28-digest-2026' }, model: null, reportNum: 2026 });
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(sentinelPath(app, 2026), JSON.stringify({ pid: process.pid, token: 'fan-out', created_at: new Date(Date.parse(meta.createdAt) - 1000).toISOString() }));
      const digest = { events: [INIT, { __write: { path: reportPath(app, '2026-10-17.md'), content: '# Scan digest\n' } }, NO_REPORT.events[1]] };

      const reply = await withScenario(digest, async () => call(app, 'POST', `/api/sessions/${meta.id}/turns`, { prompt: 'Try again.' }));
      expect(reply.statusCode, reply.body).toBe(202);
      await settleOn(app, meta.id);
      expect(fs.existsSync(reportPath(app, '2026-10-17.md'))).toBe(true);
      expect(app.sessions.read(meta.id)!.creditedReport).toBeUndefined();
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

describe('a release that checks ownership only before it runs (R27-mgr-rev-03)', () => {
  it('given a waiting session that owns its number, when the GC collects the sentinel and another reservation claims it after the check but before the release runs, then the other reservation is left alone', async () => {
    let app: App | null = null;
    let n = 0;
    let raced = false;
    const racing: Exec = async (cmd, args, opts) => {
      if (args.includes('--release') && !raced) {
        raced = true;
        reclaim(app!, n, Date.now() + 1000);
      }
      return execNoShell(cmd, args, opts);
    };
    app = await makeTestApp({}, { exec: racing });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app!, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-release-race'] })).json());
      const id = fan.sessions[0].id as string;
      n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(raced).toBe(true);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelPath(app, n), 'utf8')).token).toBe('someone-else');
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});

describe('a release whose sentinel turns unreadable under the lock (R27-mgr-rev-03 review follow-up)', () => {
  it('given a waiting session that owns its number, when its sentinel cannot be read once the release runs, then the deletion says it cannot be read, not that it was lost', async () => {
    let app: App | null = null;
    let n = 0;
    const corrupting: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) fs.writeFileSync(sentinelPath(app!, n), '{"pid": 1, "created_at": ');
      return execNoShell(cmd, args, opts);
    };
    app = await makeTestApp({}, { exec: corrupting });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app!, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-release-unreadable'] })).json());
      const id = fan.sessions[0].id as string;
      n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      const said = warn.mock.calls.flat().join('\n');
      expect(said).toMatch(new RegExp(`reservation of report number ${n} cannot be read, so it is not released`));
      expect(said).not.toMatch(/already lost/);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });
});
describe('a release that removed the sentinel but exited in error (R27-mgr-rev-03 review follow-up)', () => {
  it('given a waiting session that owns its number, when the first release removes the sentinel and then fails, then the deletion does not call the number lost', async () => {
    let failed = false;
    const flaky: Exec = async (cmd, args, opts) => {
      const r = await execNoShell(cmd, args, opts);
      if (args.includes('--release') && !failed) {
        failed = true;
        return { code: 1, stdout: '', stderr: 'could not release the tracker lock' };
      }
      return r;
    };
    const app = await makeTestApp({}, { exec: flaky });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-release-failed-after-unlink'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      expect((await call(app, 'DELETE', `/api/sessions/${id}`)).statusCode).toBe(200);
      expect(failed).toBe(true);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(false);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/already lost/);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  }, 40_000);
});
describe('a running turn refreshing its sentinel (R27-mgr-rev-04)', () => {
  it('given a running Batch evaluate turn whose sentinel has aged past the refresh age, when another process holds the tracker lock, then the refresh waits for the lock before it touches the sentinel', async () => {
    const app = await makeTestApp();
    let held = false;
    let lock: Awaited<ReturnType<typeof acquireTrackerLock>> | undefined;
    try {
      const { id, n, go } = await startHeld(app, 'https://jobs.example.com/synthetic/r28-refresh-locked');
      lock = await acquireTrackerLock(trackerLockDirFor(resolveTrackerPath(app.cfg.dataRoot)), { timeoutMs: 5000 });
      held = true;
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);

      // Several tracker ticks run while the lock is held: none may touch the sentinel.
      await wait(1500);
      expect(Date.now() - fs.statSync(sentinelPath(app, n)).mtimeMs).toBeGreaterThan(4 * 60 * 60_000);
      lock.release();
      held = false;
      await until(() => Date.now() - fs.statSync(sentinelPath(app, n)).mtimeMs < 60_000, 20_000);
      go();
      const { meta } = await settleOn(app, id);
      expect(meta.lastReason).toMatch(new RegExp(`report number ${n} returned to the pool`));
    } finally {
      if (held) lock?.release();
      await app.close();
    }
  }, 40_000);
});
describe('a reply whose sentinel refresh cannot run (R28-claude-L1-01 review follow-up)', () => {
  it('given a waiting session that owns its aged number, when the refresh cannot get the tracker lock, then the reply still starts and keeps the number', async () => {
    let refreshes = 0;
    const busy: Exec = async (cmd, args, opts) => {
      if (args.includes('--refresh')) {
        refreshes += 1;
        return { code: 1, stdout: '', stderr: 'tracker lock busy' };
      }
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, { exec: busy });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-reply-lock-busy'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), twoHoursAgo, twoHoursAgo);

      const reply = await withScenario(NO_REPORT, async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Try again.' }));
      expect(reply.statusCode, reply.body).toBe(202);
      expect(refreshes).toBeGreaterThan(0);
      expect(app.sessions.read(id)!.turns).toHaveLength(2);
      expect(app.sessions.read(id)!.reportNum).toBe(n);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  });

  it('given a waiting session whose sentinel is younger than the refresh age, when it replies, then no refresh process is spawned', async () => {
    let refreshes = 0;
    const counting: Exec = async (cmd, args, opts) => {
      if (args.includes('--refresh')) refreshes += 1;
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, { exec: counting });
    try {
      const fan = await withScenario(NO_REPORT, async () => (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r28-reply-young'] })).json());
      const id = fan.sessions[0].id as string;
      const n = fan.reserved[0] as number;
      expect((await settleOn(app, id)).meta).toMatchObject({ status: 'awaiting_user', reportNum: n });

      const reply = await withScenario(NO_REPORT, async () => call(app, 'POST', `/api/sessions/${id}/turns`, { prompt: 'Try again.' }));
      expect(reply.statusCode, reply.body).toBe(202);
      expect(app.sessions.read(id)!.reportNum).toBe(n);
      expect(refreshes).toBe(0);
    } finally {
      await app.close();
    }
  });
});
describe('a refresh still waiting when its turn gives the number back (R27-mgr-rev-04 review follow-up)', () => {
  it('given a running turn whose aged sentinel is being refreshed, when the number is released before the refresh runs, then no loss is reported', async () => {
    let app: App | null = null;
    let id = '';
    let n = 0;
    let raced = false;
    const releasing: Exec = async (cmd, args, opts) => {
      if (args.includes('--refresh') && !raced) {
        raced = true;
        // The turn ended and released its number while this refresh waited for the tracker lock.
        app!.sessions.store.setReportNum(id, null);
        fs.rmSync(sentinelPath(app!, n), { force: true });
      }
      return execNoShell(cmd, args, opts);
    };
    app = await makeTestApp({}, { exec: releasing });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const held = await startHeld(app, 'https://jobs.example.com/synthetic/r28-refresh-after-release');
      id = held.id;
      n = held.n;
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinelPath(app, n), fiveHoursAgo, fiveHoursAgo);
      await until(() => raced);
      await wait(500);
      expect(warn.mock.calls.flat().join('\n')).not.toMatch(/was collected while its turn runs/);
      held.go();
      await settleOn(app, id);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  }, 40_000);
});
describe('a number a turn kept while its stopped run could still write (R27-mgr-rev-02)', () => {
  it('given a Batch evaluate turn that ended in error keeping its number, when its process stops without a report, then the number is released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, runId, go } = await keptAfterError(app, 'https://jobs.example.com/synthetic/r28-kept-released');
      go();

      await until(() => !app.runner.ending(runId), 20_000);
      await until(() => app.sessions.read(id)!.reportNum === null && !fs.existsSync(sentinelPath(app, n)));
      expect(app.sessions.read(id)!.creditedReport).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }, 40_000);

  it('given a Batch evaluate turn that ended in error keeping its number, when its process writes its report before it stops, then the report is credited and the sentinel goes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, runId, go } = await keptAfterError(app, 'https://jobs.example.com/synthetic/r28-kept-credited');
      const file = `${String(n).padStart(3, '0')}-acme-2026-10-17.md`;
      fs.writeFileSync(reportPath(app, file), '# Evaluation: Acme\n\n**Score:** 4.2/5\n');
      go();

      await until(() => !app.runner.ending(runId), 20_000);
      await until(() => app.sessions.read(id)!.reportNum === null);
      expect(app.sessions.read(id)!.creditedReport).toMatchObject({ num: n, file });
      await until(() => !fs.existsSync(sentinelPath(app, n)));
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }, 40_000);

  it('given a kept number the stale GC collected and another reservation claimed and wrote its report under, when the process stops, then that report is not credited and the other reservation is left alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, runId, go } = await keptAfterError(app, 'https://jobs.example.com/synthetic/r28-kept-lost');
      reclaim(app, n, Date.now() + 1000);
      fs.writeFileSync(reportPath(app, `${String(n).padStart(3, '0')}-other-2026-10-17.md`), '# Evaluation: Other\n\n**Score:** 3.1/5\n');
      go();

      await until(() => !app.runner.ending(runId), 20_000);
      await until(() => app.sessions.read(id)!.reportNum === null);
      expect(app.sessions.read(id)!.creditedReport).toBeUndefined();
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(warn.mock.calls.flat().join('\n')).toMatch(new RegExp(`report number ${n} was already lost`));
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }, 40_000);
  it('given a kept number whose run record cannot be read once the runner stops following it, when its process stops, then the number stays reserved until an exit can be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const { id, n, runId, go } = await keptAfterError(app, 'https://jobs.example.com/synthetic/r28-kept-unreadable');
      const ending = app.runner.ending.bind(app.runner);
      const spy = vi.spyOn(app.runner, 'ending').mockImplementation((rid: string) => {
        if (rid === runId) throw new Error('EIO: i/o error, read');
        return ending(rid);
      });
      go();

      await until(() => app.runner.store.read(runId)?.endedAt != null, 20_000);
      await wait(1000);
      expect(app.sessions.read(id)!.reportNum).toBe(n);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);

      spy.mockRestore();
      await until(() => app.sessions.read(id)!.reportNum === null && !fs.existsSync(sentinelPath(app, n)));
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }, 40_000);

  it('given a kept number that a bare-date digest shares, when the process stops after the digest is written, then the digest is not credited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports'), { recursive: true });
      fs.writeFileSync(reportPath(app, '2025-acme-2026-10-11.md'), '# Evaluation: Acme\n\n**Score:** 4.0/5\n');
      const { id, n, runId, go } = await keptAfterError(app, 'https://jobs.example.com/synthetic/r28-kept-digest');
      expect(n).toBe(2026);
      fs.writeFileSync(reportPath(app, '2026-10-17.md'), '# Scan digest\n');
      go();

      await until(() => !app.runner.ending(runId), 20_000);
      await until(() => app.sessions.read(id)!.reportNum === null);
      expect(app.sessions.read(id)!.creditedReport).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  }, 40_000);
});

