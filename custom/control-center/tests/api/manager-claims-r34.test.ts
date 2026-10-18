// The session manager's claim protocol across server processes (server/claude/manager.invariants.md): a tracker that
// cannot write its track claim never takes over a turn a live peer follows (R34-claude-L1-01), and a tracker never
// starts following a turn while a Dev Chat revert holds the session idle (R34-claude-X-01).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
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

function withScenario(events: unknown[]): () => void {
  const scenario = path.join(tempDir('cc-r34-scenario-'), 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ events }));
  const before = process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  return () => {
    if (before === undefined) delete process.env.FAKE_CLAUDE_SCENARIO;
    else process.env.FAKE_CLAUDE_SCENARIO = before;
  };
}

const text = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const result = { type: 'result', subtype: 'success', result: 'one two', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, is_error: false };

describe('a standby tracker whose track claim cannot be written (R34-claude-L1-01)', () => {
  it('given A following a turn and B standing by, when B cannot write the track claim, then B keeps standing by and the turn is recorded and settled once', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-r34-standby-guard-');
    const restore = withScenario([{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, text('one '), ...Array.from({ length: 40 }, () => ({ __sleep: 100 })), text('two'), result]);
    const a = await makeTestApp({ dataRoot, guardRoot });
    const b = await makeTestApp({ dataRoot, guardRoot }, { deferReconcile: true });
    const writeFileSync = fs.writeFileSync.bind(fs);
    let refused = 0;
    const spy = vi.spyOn(fs, 'writeFileSync');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = a.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      a.sessions.store.setStatus(meta.id, 'done');
      await a.sessions.send(meta.id, 'What is overdue?');
      const events = () => a.sessions.store.readEvents(meta.id).map((e) => e.event);
      await until(() => events().filter((e) => e.type === 'text.delta').length === 1, 'the first delta');
      const claim = path.join(a.sessions.store.guardDirOf(meta.id), 'track.claim');
      // A full disk: every write of a track claim (its temp file beside it) fails before the live holder is seen.
      spy.mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (typeof file === 'string' && file.startsWith(claim)) {
          refused += 1;
          throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC' });
        }
        return (writeFileSync as (...args: unknown[]) => void)(file, ...rest);
      }) as typeof fs.writeFileSync);
      b.activate();
      expect(b.sessions.isActive(meta.id)).toBe(true);
      await until(() => refused >= 1, 'B to try the track claim', 10_000);
      await until(() => a.sessions.read(meta.id)!.turns[0]!.endedAt !== null && !a.sessions.isActive(meta.id), 'A to settle the turn', 20_000);
      spy.mockRestore();
      await until(() => !b.sessions.isActive(meta.id), 'B to let go of the turn');
      expect(events().filter((e) => e.type === 'text.delta')).toHaveLength(2);
      expect(events().filter((e) => e.type === 'turn.done')).toHaveLength(1);
      // The turn outlasts a standby retry: B tried the claim again while A still followed it.
      expect(refused).toBeGreaterThanOrEqual(2);
      expect(b.sessions.read(meta.id)!.status).toBe('done');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      await a.close();
      await b.close();
      restore();
      await runsEnded(dataRoot);
    }
  }, 40_000);
});

describe('a Dev Chat revert beside a peer that starts tracking the turn (R34-claude-X-01)', () => {
  it('given a cancelled turn whose run ended and nobody tracks, when a peer reconciles while the revert holds the session idle, then the peer only starts settling it after the revert', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-r34-revert-guard-');
    const restore = withScenario([{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] }, result]);
    const a = await makeTestApp({ dataRoot, guardRoot });
    const b = await makeTestApp({ dataRoot, guardRoot }, { deferReconcile: true });
    try {
      const meta = a.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      // A run that ended while no server tracked its turn (cancelled between a drain and the next server's activation).
      const run = a.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', ''], cwd: process.cwd() } });
      a.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'What is overdue?' });
      await until(() => a.runner.store.read(run.id)?.endedAt != null && !a.runner.ending(run.id), 'the run to end');
      a.sessions.store.setStatus(meta.id, 'cancelled');
      const claim = path.join(a.sessions.store.guardDirOf(meta.id), 'track.claim');
      const seen = a.sessions.whileIdle(meta.id, () => {
        // The peer's activation lands between the revert's idle check and its act.
        b.activate();
        return { tracking: b.sessions.isActive(meta.id), claimed: fs.existsSync(claim), ended: b.sessions.read(meta.id)!.turns[0]!.endedAt };
      });
      expect(seen).toEqual({ tracking: true, claimed: false, ended: null });
      await until(() => b.sessions.read(meta.id)!.turns[0]!.endedAt !== null && !b.sessions.isActive(meta.id), 'B to settle the turn once the revert is done', 20_000);
    } finally {
      await a.close();
      await b.close();
      restore();
      await runsEnded(dataRoot);
    }
  }, 40_000);
});
