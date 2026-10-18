import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(25);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
/**
 * A CLI slow to stop: SIGTERM does nothing, so a cancelled run lives until the runner's SIGKILL. It ignores SIGTERM
 * before it streams anything, so its delta proves a cancel can no longer end it at once.
 */
const STUBBORN = { events: [{ __ignoreSigterm: true }, INIT, delta('ready'), ...Array.from({ length: 200 }, () => ({ __sleep: 100 }))] };
/** True once the session streamed a text delta, which the stubborn CLI prints only after it ignores SIGTERM. */
const streamed = (app: App, id: string) => app.sessions.store.readEvents(id).some((e) => e.event.type === 'text.delta');

/** Starts an evaluation of `url`, then cancels it while its process is still stopping. */
async function cancelledButStopping(app: App, url: string): Promise<{ id: string; runId: string }> {
  const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify(STUBBORN));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    const started = (await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'Evaluate it' })).json();
    const runId = started.turns[0].runId as string;
    await until(() => streamed(app, started.id as string));
    expect((await call(app, 'POST', `/api/sessions/${started.id}/cancel`, {})).statusCode).toBe(200);
    expect(app.runner.store.read(runId)?.endedAt ?? null).toBeNull();
    // The cancel's SIGTERM must not end it: the runner's SIGKILL comes about 5 s later.
    await wait(1000);
    expect(app.runner.store.read(runId)?.endedAt ?? null).toBeNull();
    return { id: started.id as string, runId };
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}

describe('a cancelled evaluation whose run is still stopping (R27-claude-L1-01)', () => {
  it('given a cancelled evaluation of a posting still stopping, when the posting is started again, then the start is refused with 409', async () => {
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r27-l101-start';
      const { id, runId } = await cancelledButStopping(app, url);

      const res = await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'Evaluate it' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toContain(id);
      await until(() => app.runner.store.read(runId)?.endedAt != null, 20_000);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given a cancelled evaluation of a posting still stopping, when a Batch evaluate names the posting, then it is not started', async () => {
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r27-l101-fanout';
      const { id, runId } = await cancelledButStopping(app, url);

      const fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: [url] })).json();
      expect(fan.reserved).toEqual([]);
      expect(fan.sessions[0].error).toContain(`session ${id} is already evaluating`);
      await until(() => app.runner.store.read(runId)?.endedAt != null, 20_000);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('given an evaluation whose run record became unreadable while its process may still run, when the posting is started again, then the start is refused with 409', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r27-l101-unreadable-run';
      const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
      fs.writeFileSync(file, JSON.stringify(STUBBORN));
      process.env.FAKE_CLAUDE_SCENARIO = file;
      let started: { id: string; turns: { runId: string }[] };
      try {
        started = (await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'Evaluate it' })).json();
      } finally {
        delete process.env.FAKE_CLAUDE_SCENARIO;
      }
      const runId = started.turns[0]!.runId;
      await until(() => app.runner.store.read(runId)?.childPid != null);
      const read = app.runner.store.read.bind(app.runner.store);
      const spy = vi.spyOn(app.runner.store, 'read').mockImplementation((rid: string) => {
        if (rid === runId) throw new Error('EIO: i/o error, read');
        return read(rid);
      });
      await until(() => app.sessions.read(started.id)?.status === 'error');
      spy.mockRestore();
      expect(app.runner.ending(runId)).toBe(true);

      const res = await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'Evaluate it' });
      expect(res.statusCode, res.body).toBe(409);
      // Stopped once its record reads again (the cancel that failed while it could not is retried), well before its own end.
      await until(() => app.runner.store.read(runId)?.endedAt != null, 15_000);
      await until(() => !app.runner.ending(runId));
      let deleted = 0;
      for (let i = 0; i < 40 && deleted !== 200; i++) {
        deleted = (await app.app.inject({ method: 'DELETE', url: `/api/sessions/${started.id}`, headers: app.authedWrite, payload: {} })).statusCode;
        if (deleted !== 200) await wait(100);
      }
      expect(deleted).toBe(200);
    } finally {
      await app.close();
      error.mockRestore();
    }
  }, 40_000);

  it('given a Batch evaluate turn whose run record became unreadable while its process may still run, when its sentinel ages past the refresh threshold, then it is still refreshed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await makeTestApp();
    try {
      const url = 'https://jobs.example.com/synthetic/r27-l101-unreadable-fresh';
      const file = path.join(tempDir('cc-r27-scenario-'), 'scenario.json');
      fs.writeFileSync(file, JSON.stringify(STUBBORN));
      process.env.FAKE_CLAUDE_SCENARIO = file;
      let fan: { sessions: { id: string; turns: { runId: string }[] }[]; reserved: number[] };
      try {
        fan = (await call(app, 'POST', '/api/sessions/fanout', { mode: 'oferta', urls: [url] })).json();
      } finally {
        delete process.env.FAKE_CLAUDE_SCENARIO;
      }
      const id = fan.sessions[0]!.id;
      const runId = fan.sessions[0]!.turns[0]!.runId;
      const sentinel = path.join(app.cfg.dataRoot, 'reports', `${String(fan.reserved[0]).padStart(3, '0')}-RESERVED.md`);
      await until(() => app.runner.store.read(runId)?.childPid != null);
      const read = app.runner.store.read.bind(app.runner.store);
      const spy = vi.spyOn(app.runner.store, 'read').mockImplementation((rid: string) => {
        if (rid === runId) throw new Error('EIO: i/o error, read');
        return read(rid);
      });
      await until(() => app.sessions.read(id)?.status === 'error');
      // Aged before the record reads again: the session keeps its number while the stubborn process stops (until SIGKILL).
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000);
      fs.utimesSync(sentinel, fiveHoursAgo, fiveHoursAgo);
      spy.mockRestore();

      await until(() => Date.now() - fs.statSync(sentinel).mtimeMs < 60_000, 4_000);
      await until(() => !app.runner.ending(runId), 20_000);
    } finally {
      await app.close();
      error.mockRestore();
    }
  }, 40_000);
});

