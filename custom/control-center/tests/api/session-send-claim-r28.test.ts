import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { BusyError } from '../../server/claude/manager.js';
import { processStartTime } from '../../supervisor/instance-lock.js';

// R28-claude-X-01: two server processes on one data root (blue/green) each see a session waiting for the user; a reply
// sent to both at once must start one paid turn, not two.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const result = (text: string) => ({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false });
async function withScenario<T>(events: unknown[], fn: () => Promise<T>): Promise<T> {
  const file = path.join(tempDir('cc-r28-claim-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ events }));
  process.env.FAKE_CLAUDE_SCENARIO = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
}
async function settled(app: TestApp, id: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = app.sessions.read(id)!.status;
    if (status !== 'running' && status !== 'queued' && !app.sessions.isActive(id)) return status;
    if (Date.now() > deadline) throw new Error(`session ${id} still ${status}`);
    await wait(50);
  }
}

describe('a reply sent to one session through two server processes at once (R28-claude-X-01)', () => {
  it('given a session waiting for the user, when both processes send to it together, then one turn starts and the other is refused as busy', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-r28-claim-guard-');
    // A slow token read holds each send between its idle check and its turn start, where the two used to overlap.
    const slowToken = { readToken: async () => (await wait(300), FAKE_TOKEN) };
    const a = await makeTestApp({ dataRoot, guardRoot }, slowToken);
    const b = await makeTestApp({ dataRoot, guardRoot }, slowToken);
    try {
      const meta = await withScenario([INIT, result('Which company is this for?')], () => a.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: null }));
      expect(await settled(a, meta.id)).toBe('awaiting_user');
      const sent = await withScenario([INIT, result('Researched Acme.')], () => Promise.allSettled([a.sessions.send(meta.id, 'Acme'), b.sessions.send(meta.id, 'Acme')]));
      expect(sent.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
      const refused = sent.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(BusyError);
      const winner = sent[0]!.status === 'fulfilled' ? a : b;
      expect(await settled(winner, meta.id)).toBe('done');
      expect(winner.sessions.read(meta.id)!.turns.map((t) => t.userText)).toEqual(['Research', 'Acme']);
      // The claim went with the turn's start: the next reply, from either process, starts normally.
      const next = await withScenario([INIT, result('Which team?')], () => (winner === a ? b : a).sessions.send(meta.id, 'More'));
      expect(next.turns).toHaveLength(3);
    } finally {
      await a.close();
      await b.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a turn claim left by a server process that died, when a reply is sent, then the turn starts', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r28-claim-guard-') });
    try {
      const meta = await withScenario([INIT, result('Which company is this for?')], () => app.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: null }));
      expect(await settled(app, meta.id)).toBe('awaiting_user');
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      fs.writeFileSync(path.join(app.sessions.store.guardDirOf(meta.id), 'turn.claim'), JSON.stringify({ pid: dead, start: 1, at: Date.now(), nonce: 'gone' }));
      const next = await withScenario([INIT, result('Researched Acme.')], () => app.sessions.send(meta.id, 'Acme'));
      expect(next.turns).toHaveLength(2);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a turn claim a live server process has held for a long time, when a reply is sent, then it is refused as busy: age alone never frees a live claim', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r28-claim-guard-') });
    try {
      const meta = await withScenario([INIT, result('Which company is this for?')], () => app.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: null }));
      expect(await settled(app, meta.id)).toBe('awaiting_user');
      const start = processStartTime(process.pid);
      expect(typeof start).toBe('number');
      fs.writeFileSync(path.join(app.sessions.store.guardDirOf(meta.id), 'turn.claim'), JSON.stringify({ pid: process.pid, start, at: Date.now() - 3_600_000, nonce: 'slow-peer' }));
      await expect(app.sessions.send(meta.id, 'Acme')).rejects.toBeInstanceOf(BusyError);
      expect(app.sessions.read(meta.id)!.turns).toHaveLength(1);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a dead process\'s turn claim that a peer is replacing right now, when a reply is sent, then it is refused as busy rather than replacing it too', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r28-claim-guard-') });
    try {
      const meta = await withScenario([INIT, result('Which company is this for?')], () => app.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: null }));
      expect(await settled(app, meta.id)).toBe('awaiting_user');
      const dir = app.sessions.store.guardDirOf(meta.id);
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      fs.writeFileSync(path.join(dir, 'turn.claim'), JSON.stringify({ pid: dead, start: 1, at: Date.now(), nonce: 'gone' }));
      const replacing = path.join(dir, 'turn.claim.replace');
      fs.writeFileSync(replacing, JSON.stringify({ pid: process.pid, nonce: 'peer' }));
      await expect(app.sessions.send(meta.id, 'Acme')).rejects.toBeInstanceOf(BusyError);
      // A replacement lock its process left behind is itself replaced once stale.
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(replacing, old, old);
      const next = await withScenario([INIT, result('Researched Acme.')], () => app.sessions.send(meta.id, 'Acme'));
      expect(next.turns).toHaveLength(2);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
