import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';

type App = Awaited<ReturnType<typeof makeTestApp>>;

const newSession = (app: App) => app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });

/** A turn whose Claude process ignores SIGTERM and lives `ms`, started and cancelled in the peer server process. */
async function cancelledButStopping(peer: App, id: string, ms: number): Promise<void> {
  // The process says when it ignores SIGTERM: a cancel before that (a slow start on a loaded machine) would end it at once.
  const ready = path.join(tempDir('cc-r32-stopping-'), 'ready');
  const run = peer.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, ${ms})`], cwd: process.cwd() } });
  peer.sessions.store.beginTurn(id, { runId: run.id, userText: 'What is overdue?' });
  while (!fs.existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
  // The other process cancelled it: its run is stopping, and the session is recorded cancelled at once.
  expect(peer.runner.cancel(run.id)).toMatchObject({ status: 'cancelled', endedAt: null });
  peer.sessions.store.setStatus(id, 'cancelled');
}

// R32-claude-L1-01: delete refused a session whose cancelled turn another server process was still stopping, but a reply
// or a fork started a second `claude --resume` beside it, and the old turn was never finalized.
describe('a reply or fork beside a cancelled turn still stopping in another server process (R32-claude-L1-01)', () => {
  it('given a cancelled session whose run has not ended, when a reply is sent here, then it is refused as still finishing and no turn starts', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-test-guard-');
    // Both processes run before the turn starts, so this one only learns of the peer's run when it asks about it.
    const peer = await makeTestApp({ dataRoot, guardRoot });
    const app = await makeTestApp({ dataRoot, guardRoot });
    try {
      const meta = newSession(peer);
      await cancelledButStopping(peer, meta.id, 3000);
      await expect(app.sessions.send(meta.id, 'Again?')).rejects.toThrow(/still finishing/);
      expect(app.sessions.read(meta.id)!.turns).toHaveLength(1);
    } finally {
      await app.close();
      await peer.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a cancelled session whose run has not ended, when it is forked here, then the fork waits for the run to end before it starts', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-test-guard-');
    // Both processes run before the turn starts, so this one only learns of the peer's run when it asks about it.
    const peer = await makeTestApp({ dataRoot, guardRoot });
    const app = await makeTestApp({ dataRoot, guardRoot });
    try {
      const meta = newSession(peer);
      await cancelledButStopping(peer, meta.id, 2000);
      const forking = app.sessions.fork(meta.id, 'Again?');
      forking.catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      expect(app.sessions.list().map((m) => m.id)).toEqual([meta.id]);
      const fork = await forking;
      expect(fork.forkedFrom).toBe(meta.id);
    } finally {
      await app.close();
      await peer.close();
      await runsEnded(dataRoot);
    }
  });
});
