// A session whose mode file runs generate-pdf.mjs (pdf, cover) rewrites data/pdf-index.tsv without a lock, as the
// docs.renderPdf and docs.coverPdf actions do: its turn holds the 'pdf-index' resource so the two never overlap and drop
// a manifest row (R35-srv-core-L1-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

/** Runs `fn` with a session whose turn of `mode` is running (a fake Claude that sleeps), then cancels and cleans up. */
async function withRunningTurn(mode: string, fn: (app: TestApp, runId: string) => Promise<void>): Promise<void> {
  const dataRoot = copyFixtureRoot();
  const scenario = path.join(tempDir('cc-r35-pdfidx-'), 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, ...Array.from({ length: 300 }, () => ({ __sleep: 100 }))] }));
  const before = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  let app: TestApp | undefined;
  try {
    app = await makeTestApp({ dataRoot });
    const a = app;
    const meta = a.sessions.store.create({ mode, policyClass: a.sessions.effectivePolicy(mode)!.policyClass, target: { type: 'none', value: null }, model: null, reportNum: null });
    a.sessions.store.setStatus(meta.id, 'done');
    await a.sessions.send(meta.id, 'Go on.');
    await until(() => a.sessions.read(meta.id)!.turns.length === 1, 'the turn to begin');
    const runId = a.sessions.read(meta.id)!.turns[0]!.runId;
    await until(() => a.runner.store.read(runId)?.status === 'running', 'the turn run to start');
    try {
      await fn(a, runId);
    } finally {
      a.sessions.cancel(meta.id);
      await until(() => a.sessions.read(meta.id)!.turns[0]!.endedAt !== null, 'the turn to end', 20_000);
    }
  } finally {
    try {
      await app?.close();
    } finally {
      if (before === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
      else process.env.FAKE_CLAUDE_SCENARIO = before;
      await runsEnded(dataRoot);
    }
  }
}

/** Starts a run holding 'pdf-index' the way docs.renderPdf does. */
function startPdfIndexAction(app: TestApp): string {
  return app.runner.start({
    actionId: 'docs.renderPdf',
    label: 'Re-render PDF from HTML',
    cost: 'free',
    resources: ['pdf-index'],
    claude: false,
    params: {},
    cmd: { bin: process.execPath, args: ['-e', ''], cwd: process.cwd() },
  }).id;
}

describe('session turns and the pdf-index resource (R35-srv-core-L1-01)', () => {
  it.each(['pdf', 'cover'])('given a running %s session turn, when a PDF re-render starts, then it waits until the turn ends', async (mode) => {
    let action = '';
    await withRunningTurn(mode, async (app, runId) => {
      expect(app.runner.store.read(runId)!.resources).toEqual(['pdf-index']);
      action = startPdfIndexAction(app);
      await wait(500);
      expect(app.runner.store.read(action)!.status).toBe('queued');
    });
  }, 60_000);

  it('given a running evaluation (oferta) session turn, when a PDF re-render starts, then it is not held back', async () => {
    await withRunningTurn('oferta', async (app, runId) => {
      expect(app.runner.store.read(runId)!.resources).toEqual([]);
      const action = startPdfIndexAction(app);
      await until(() => ['done', 'failed'].includes(app.runner.store.read(action)!.status), 'the action to run');
      expect(app.runner.store.read(action)!.status).toBe('done');
    });
  }, 60_000);
});
