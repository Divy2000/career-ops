import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import type { SessionEvent } from '../../server/claude/stream-parse.js';

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
const NO_REPORT = { events: [INIT, { type: 'result', subtype: 'success', result: 'The posting needs a login; I could not read it.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }] };
async function withScenario<T>(scenario: unknown, fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-r30-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(scenario));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
const sentinelPath = (app: App, n: number) => path.join(app.cfg.dataRoot, 'reports', `${String(n).padStart(3, '0')}-RESERVED.md`);
/** The stale-sentinel GC removed the session's sentinel and a new reservation claimed the number again at `at`. */
const reclaim = (app: App, n: number, at: number) =>
  fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'someone-else', created_at: new Date(at).toISOString() }));
/** A zero-turn session that ended in error still holding `n`, as one whose beginTurn failed with its run not yet stopped. */
function zeroTurnHolding(app: App, n: number): string {
  const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://jobs.example.com/synthetic/r30-x01' }, model: null, reportNum: n });
  app.sessions.store.setStatus(meta.id, 'error', 'could not record the turn');
  return meta.id;
}

describe('a first turn that cannot start while its events cannot be written (R30-claude-L1-01)', () => {
  it('given a Batch evaluate of two postings whose first cannot start and whose error event cannot be appended, when the batch starts, then both sessions are answered and both reserved numbers go back to the pool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    const append = app.sessions.store.appendEvent.bind(app.sessions.store);
    const first: string[] = [];
    vi.spyOn(app.sessions.store, 'appendEvent').mockImplementation((id: string, event: SessionEvent) => {
      if (first.length === 0) first.push(id);
      if (id === first[0]) throw new Error('timed out waiting for the session events lock');
      return append(id, event);
    });
    try {
      const res = await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r30-l1-a', 'https://jobs.example.com/synthetic/r30-l1-b'] });
      expect(res.statusCode, res.body).toBe(202);
      const body = res.json() as { sessions: Array<{ id: string; status: string; reportNum: number | null }>; reserved: number[] };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions.map((s) => s.status)).toEqual(['error', 'error']);
      expect(body.sessions.map((s) => s.reportNum)).toEqual([null, null]);
      for (const n of body.reserved) expect(fs.existsSync(sentinelPath(app, n))).toBe(false);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  });
  it('given a Batch evaluate of two postings whose first cannot start and whose session record cannot be settled, when the batch starts, then the second still starts and both are answered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await makeTestApp({}, { readToken: async () => { throw new Error('Keychain item career-ops-claude-token not found'); } });
    const setStatus = app.sessions.store.setStatus.bind(app.sessions.store);
    const first: string[] = [];
    vi.spyOn(app.sessions.store, 'setStatus').mockImplementation((id, status, error) => {
      if (first.length === 0) first.push(id);
      if (id === first[0] && status === 'error') throw new Error('ENOSPC: no space left on device, write');
      return setStatus(id, status, error);
    });
    try {
      const res = await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: ['https://jobs.example.com/synthetic/r30-l1-c', 'https://jobs.example.com/synthetic/r30-l1-d'] });
      expect(res.statusCode, res.body).toBe(202);
      const body = res.json() as { sessions: Array<{ id: string; status: string; reportNum: number | null }>; reserved: number[] };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions[1]).toMatchObject({ status: 'error', reportNum: null });
      expect(fs.existsSync(sentinelPath(app, body.reserved[1]!))).toBe(false);
    } finally {
      await app.close();
      warn.mockRestore();
    }
  });
});

describe('a zero-turn session whose reserved number was collected and claimed again (R30-claude-X-01)', () => {
  it('given a zero-turn session holding a number another reservation now holds, when its reply is cancelled before it spawns, then the other reservation is left alone', async () => {
    let preparing = false;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const releases: string[] = [];
    const exec: Exec = async (cmd, args, opts) => {
      if (args.includes('--release')) releases.push(args[args.indexOf('--release') + 1]!);
      return execNoShell(cmd, args, opts);
    };
    const app = await makeTestApp({}, {
      exec,
      readToken: async () => {
        preparing = true;
        await gate;
        return 'test-token';
      },
    });
    try {
      const n = 42;
      const id = zeroTurnHolding(app, n);
      fs.writeFileSync(sentinelPath(app, n), JSON.stringify({ pid: process.pid, token: 'the-session', created_at: new Date(Date.now() - 1000).toISOString() }));
      const pending = app.sessions.send(id, 'Try again.');
      await until(() => preparing);
      // Collected and claimed again while the reply prepares, after its reservation was checked.
      reclaim(app, n, Date.now() + 1000);
      app.sessions.cancel(id);
      open();
      await pending;
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelPath(app, n), 'utf8')).token).toBe('someone-else');
      expect(releases).not.toContain(String(n));
    } finally {
      open();
      await app.close();
    }
  });

  it('given a zero-turn session holding a number another reservation now holds, when the user replies, then the reply does not run under that number', async () => {
    const app = await makeTestApp();
    try {
      const n = 43;
      const id = zeroTurnHolding(app, n);
      reclaim(app, n, Date.now() + 1000);
      await withScenario(NO_REPORT, () => app.sessions.send(id, 'Try again.'));
      const { meta } = await settleOn(app, id);
      expect(meta.reportNum).not.toBe(n);
      expect(fs.existsSync(sentinelPath(app, n))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelPath(app, n), 'utf8')).token).toBe('someone-else');
    } finally {
      await app.close();
    }
  });
});
