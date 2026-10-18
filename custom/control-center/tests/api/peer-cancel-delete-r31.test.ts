import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';

type App = Awaited<ReturnType<typeof makeTestApp>>;

const newSession = (app: App) => app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });

/** Another server process holds the session's turn claim: it is preparing a turn there. */
function peerClaim(app: App, id: string): void {
  const guard = app.sessions.store.guardDirOf(id);
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'turn.claim'), JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'peer' }));
}

// R31-claude-L1-01: a turn another server process runs, cancelled there, keeps its Claude process until SIGKILL; deleting
// the session meanwhile released its report number and removed it while that process could still write the report.
describe('deleting a session whose cancelled turn is still stopping in another server process (R31-claude-L1-01)', () => {
  it('given a cancelled session whose run has not ended, when it is deleted here, then it is refused as busy and the session stays', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = newSession(app);
      const run = app.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3000)"], cwd: process.cwd() } });
      app.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'What is overdue?' });
      // The other process cancelled it: its run is stopping, and the session is recorded cancelled at once.
      await new Promise((r) => setTimeout(r, 300));
      app.runner.cancel(run.id);
      app.sessions.store.setStatus(meta.id, 'cancelled');
      await expect(app.sessions.delete(meta.id)).rejects.toThrow(/still finishing/);
      expect(app.sessions.read(meta.id)).not.toBeNull();
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a cancelled session whose run has ended, when it is deleted, then it goes', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = newSession(app);
      const run = app.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', ''], cwd: process.cwd() } });
      app.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'What is overdue?' });
      app.sessions.store.setStatus(meta.id, 'cancelled');
      await runsEnded(dataRoot);
      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(app.sessions.read(meta.id)).toBeNull();
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
