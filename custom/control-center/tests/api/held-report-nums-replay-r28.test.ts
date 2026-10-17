import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

// R28-cl2-rev-01 review: at a restart the manager reads output a server process wrote while no server may have been
// polling. A hold recorded then must name the reservation the session's own run printed, never one made since.
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !pred(); await wait(50)) if (Date.now() > deadline) throw new Error('timed out');
}
const LINES = [
  { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Bash'], session_id: 'c1' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Bash', input: { command: 'node reserve-report-num.mjs' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', is_error: false, content: '061' }] } },
];

/** A turn whose run printed a reservation of 061 and exited while no server tracked it, then `between` ran. */
async function turnOutsideTheServer(app: TestApp, between: (guard: string, runId: string) => void) {
  const script = `for (const l of ${JSON.stringify(LINES.map((l) => JSON.stringify(l)))}) console.log(l)`;
  const meta = app.sessions.store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
  const run = app.runner.start({ actionId: 'session.oferta', label: 'Evaluate: turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', script], cwd: PACKAGE_ROOT } });
  app.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'Evaluate' });
  await until(() => app.runner.store.read(run.id)?.status !== 'running' && app.runner.store.readRaw(run.id).lines.length >= LINES.length);
  await wait(20);
  const guard = app.sessions.store.guardDirOf(meta.id);
  between(guard, run.id);
  app.sessions.close();
  app.sessions.reconcile();
  await until(() => app.sessions.read(meta.id)!.turns[0]!.endedAt !== null);
  const log = path.join(guard, 'held-report-nums.log');
  return { meta: app.sessions.read(meta.id)!, held: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
const otherHolds61 = (app: TestApp, createdAt = new Date().toISOString()) => fs.writeFileSync(path.join(app.cfg.dataRoot, 'reports', '061-RESERVED.md'), JSON.stringify({ pid: process.pid, token: 'another-evaluation', created_at: createdAt }));

describe('a turn read at a restart (R28-cl2-rev-01)', () => {
  it('given a reservation the previous server already handled and another evaluation now holding that number, when the turn is replayed, then no hold on it is recorded', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const { held } = await turnOutsideTheServer(app, (guard, runId) => {
        const raw = app.runner.store.readRaw(runId);
        const turnDir = path.join(guard, 'turns', '1');
        fs.mkdirSync(turnDir, { recursive: true });
        fs.writeFileSync(path.join(turnDir, 'progress.json'), JSON.stringify({ rawSeq: raw.lines.at(-1)!.seq, rawOffset: raw.offset }));
        // Written before the output line, so only the replay itself keeps the hold from being recorded.
        otherHolds61(app, '2026-01-01T00:00:00.000Z');
      });
      expect(held).not.toMatch(/\+61=/);
    } finally {
      await app.close();
    }
  });

  it('given a reservation no server handled yet and another evaluation holding that number since, when the turn is read, then no hold on it is recorded', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const { held } = await turnOutsideTheServer(app, () => otherHolds61(app));
      expect(held).not.toMatch(/\+61=/);
    } finally {
      await app.close();
    }
  });

  it('given a reservation no server handled yet whose sentinel is unchanged, when the turn is read at a restart, then its hold is recorded', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    const sentinel = path.join(app.cfg.dataRoot, 'reports', '061-RESERVED.md');
    try {
      // The run's own reservation, written before it printed 061.
      otherHolds61(app, '2026-01-01T00:00:00.000Z');
      const { held } = await turnOutsideTheServer(app, () => {});
      const own = JSON.parse(fs.readFileSync(sentinel, 'utf8')) as { created_at: string; token: string };
      expect(held).toContain(`+61=${Date.parse(own.created_at)}~${own.token};`);
    } finally {
      await app.close();
    }
  });

  it('given a session whose reserved number\'s sentinel cannot be read, when its turn starts, then the turn still runs', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    const file = path.join(tempDir('cc-r28-start-'), 'scenario.json');
    fs.writeFileSync(file, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, { type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, is_error: false }] }));
    process.env.FAKE_CLAUDE_SCENARIO = file;
    try {
      fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports', '069-RESERVED.md'));
      const { id } = await app.sessions.start({ mode: 'deep', target: { type: 'none', value: null }, prompt: 'Research', reportNum: 69 });
      await until(() => !['queued', 'running'].includes(app.sessions.read(id)!.status));
      expect(app.sessions.read(id)!.error ?? '').not.toMatch(/EISDIR/);
      expect(app.sessions.read(id)!.turns[0]!.runId).toBeTruthy();
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  });

  it('given a reservation sentinel that cannot be read, when the turn records its hold, then the turn still ends as it would', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const { meta } = await turnOutsideTheServer(app, () => fs.mkdirSync(path.join(app.cfg.dataRoot, 'reports', '061-RESERVED.md')));
      expect(meta.error ?? '').not.toMatch(/could not process the session output/);
    } finally {
      await app.close();
    }
  });
});
