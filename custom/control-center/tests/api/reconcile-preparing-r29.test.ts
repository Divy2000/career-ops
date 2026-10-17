import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';

// R29-claude-L1-01: a blue/green activate reconciles while a first turn is still preparing (its token read, its CLI
// probe); reconcile must leave that session queued and its reserved number in place, not error it and release the number.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
const RESULT = { type: 'result', subtype: 'success', result: 'Researched.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false };

function scenario(): string {
  const file = path.join(tempDir('cc-r29-reconcile-'), 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({ events: [INIT, RESULT] }));
  return file;
}

/** A token read held until the test lets it go, so the first turn stays mid-prepare. */
function gatedToken() {
  let entered = false;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return {
    deps: { readToken: async () => ((entered = true), await gate, FAKE_TOKEN) },
    entered: () => entered,
    open: () => open(),
  };
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await wait(20);
  }
}

async function settled(app: TestApp, id: string): Promise<string> {
  await until(() => {
    const s = app.sessions.read(id)!.status;
    return s !== 'running' && s !== 'queued' && !app.sessions.isActive(id);
  });
  return app.sessions.read(id)!.status;
}

describe('reconcile while a first turn is still preparing (R29-claude-L1-01)', () => {
  for (const where of ['the same server process', 'another server process on the same data root'] as const) {
    it(`given a first turn preparing in ${where}, when reconcile runs, then the session stays queued, keeps its reserved number, and its turn runs`, async () => {
      const dataRoot = copyFixtureRoot();
      const guardRoot = tempDir('cc-r29-reconcile-guard-');
      const token = gatedToken();
      const a = await makeTestApp({ dataRoot, guardRoot }, token.deps);
      const b = where === 'the same server process' ? a : await makeTestApp({ dataRoot, guardRoot });
      const file = scenario();
      process.env.FAKE_CLAUDE_SCENARIO = file;
      try {
        const sentinel = path.join(dataRoot, 'reports', '063-RESERVED.md');
        fs.writeFileSync(sentinel, JSON.stringify({ pid: process.pid, token: 'fan-out', created_at: new Date().toISOString() }));
        const started = a.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: 63 });
        await until(token.entered);
        const id = a.sessions.store.list().find((m) => m.reportNum === 63)!.id;
        b.sessions.reconcile();
        expect(b.sessions.read(id)).toMatchObject({ status: 'queued', reportNum: 63, error: null });
        expect(fs.existsSync(sentinel)).toBe(true);
        expect(b.sessions.store.readEvents(id).map((e) => e.event).filter((e) => e.type === 'status')).toEqual([]);
        token.open();
        await started;
        expect(await settled(a, id)).toBe('done');
        expect(a.sessions.read(id)!.turns).toHaveLength(1);
      } finally {
        token.open();
        delete process.env.FAKE_CLAUDE_SCENARIO;
        await a.close();
        if (b !== a) await b.close();
        await runsEnded(dataRoot);
      }
    });
  }

  it('given a first turn whose session was settled while it prepared (error, number released), when the prepare resumes, then no run is spawned', async () => {
    const dataRoot = copyFixtureRoot();
    const token = gatedToken();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-r29-reconcile-guard-') }, token.deps);
    process.env.FAKE_CLAUDE_SCENARIO = scenario();
    try {
      const runsBefore = app.runner.store.list().length;
      const started = app.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: 64 });
      await until(token.entered);
      const id = app.sessions.store.list().find((m) => m.reportNum === 64)!.id;
      // What a reconcile elsewhere did before it knew of the claim: errored the session and let its number go.
      app.sessions.store.setStatus(id, 'error', 'run record missing after a restart');
      app.sessions.store.setReportNum(id, null);
      token.open();
      const meta = await started;
      expect(meta).toMatchObject({ status: 'error', turns: [] });
      expect(app.runner.store.list()).toHaveLength(runsBefore);
    } finally {
      token.open();
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
