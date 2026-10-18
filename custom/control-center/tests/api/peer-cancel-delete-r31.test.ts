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

// R31-claude-L1-02: cancel() only knew the turns this process prepares; one another server process was preparing was
// answered with the unchanged session, and the paid turn the user cancelled spawned anyway.
describe('cancelling a turn another server process is preparing (R31-claude-L1-02)', () => {
  it('given a new session whose first turn a peer prepares, when it is cancelled here, then it is refused as busy and nothing changes', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = newSession(app);
      peerClaim(app, meta.id);
      expect(() => app.sessions.cancel(meta.id)).toThrow(/another server process/);
      expect(app.sessions.read(meta.id)!.status).toBe('queued');
    } finally {
      await app.close();
    }
  });

  it('given a session whose later turn a peer prepares, when it is cancelled here, then it is refused as busy', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = newSession(app);
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      peerClaim(app, meta.id);
      expect(() => app.sessions.cancel(meta.id)).toThrow(/another server process/);
      expect(app.sessions.read(meta.id)!.status).toBe('awaiting_user');
    } finally {
      await app.close();
    }
  });

  it('given a fork here waiting for its source\'s cancelled turn to finish, when the source is cancelled, then it is not refused', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    const active = (app.sessions as unknown as { active: Map<string, unknown> }).active;
    try {
      const meta = newSession(app);
      app.sessions.store.setStatus(meta.id, 'cancelled');
      active.set(meta.id, {});
      const forking = app.sessions.fork(meta.id, 'Again?');
      forking.catch(() => {});
      expect(app.sessions.cancel(meta.id).status).toBe('cancelled');
      app.sessions.store.delete(meta.id);
      active.delete(meta.id);
      await expect(forking).rejects.toThrow();
    } finally {
      active.clear();
      await app.close();
    }
  });

  it('given an idle session nobody is starting a turn on, when it is cancelled, then it is returned unchanged', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = newSession(app);
      app.sessions.store.setStatus(meta.id, 'awaiting_user');
      expect(app.sessions.cancel(meta.id).status).toBe('awaiting_user');
    } finally {
      await app.close();
    }
  });
});
