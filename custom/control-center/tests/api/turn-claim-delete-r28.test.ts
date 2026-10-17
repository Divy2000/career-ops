import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, FAKE_TOKEN, makeTestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';

// R28-claude-X-01 review: another server process holds a session's turn claim while it prepares a turn (a slow token
// read); deleting the session meanwhile left that process starting a turn on a session that no longer exists.
describe('deleting a session another server process is starting a turn on (R28-claude-X-01)', () => {
  it('given a live turn claim from another process, when the session is deleted, then it is refused as busy and the session stays', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      const guard = app.sessions.store.guardDirOf(meta.id);
      fs.mkdirSync(guard, { recursive: true });
      fs.writeFileSync(path.join(guard, 'turn.claim'), JSON.stringify({ pid: process.pid, at: Date.now(), nonce: 'peer' }));
      await expect(app.sessions.delete(meta.id)).rejects.toThrow(/another server process/);
      expect(app.sessions.read(meta.id)).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('given no claim, when the session is deleted, then it goes', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      expect(await app.sessions.delete(meta.id)).toBe(true);
      expect(app.sessions.read(meta.id)).toBeNull();
      expect(await app.sessions.delete('no-such-session')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('given a session another process deletes while a reply claims its turn, when the reply is refused, then no guard folder is left behind', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = await app.sessions.start({ mode: 'advisor', target: { type: 'none', value: null }, prompt: 'What is overdue?' });
      for (const deadline = Date.now() + 15_000; ['queued', 'running'].includes(app.sessions.read(meta.id)!.status) || (app.sessions as unknown as { active: Map<string, unknown> }).active.has(meta.id); await new Promise((r) => setTimeout(r, 50))) {
        if (Date.now() > deadline) throw new Error('the first turn never ended');
      }
      const guard = app.sessions.store.guardDirOf(meta.id);
      const manager = app.sessions as unknown as { claimTurn(id: string): () => void };
      const claim = manager.claimTurn.bind(manager);
      // The other process deletes the session after this reply read it, just before it takes the turn claim.
      vi.spyOn(manager, 'claimTurn').mockImplementation((id) => {
        app.sessions.store.delete(id);
        return claim(id);
      });
      await expect(app.sessions.send(meta.id, 'Next?')).rejects.toThrow();
      expect(manager.claimTurn).toHaveBeenCalled();
      expect(fs.existsSync(guard)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a new session whose first turn is being prepared, when another process looks, then the session\'s turn claim is held', async () => {
    let claimed: boolean | null = null;
    let guard = '';
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-test-guard-') }, {
      readToken: async () => {
        claimed = fs.existsSync(path.join(guard, 'turn.claim'));
        return FAKE_TOKEN;
      },
    });
    try {
      const meta = await app.sessions.start({ mode: 'advisor', target: { type: 'none', value: null }, prompt: 'What is overdue?' }, (m) => {
        guard = app.sessions.store.guardDirOf(m.id);
      });
      expect(claimed).toBe(true);
      for (const deadline = Date.now() + 15_000; ['queued', 'running'].includes(app.sessions.read(meta.id)!.status); await new Promise((r) => setTimeout(r, 50))) {
        if (Date.now() > deadline) throw new Error('the first turn never ended');
      }
      expect(fs.existsSync(path.join(guard, 'turn.claim'))).toBe(false);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a new session another process deletes before its first turn is claimed, when the turn starts, then nothing is spawned', async () => {
    const app = await makeTestApp({ dataRoot: copyFixtureRoot(), guardRoot: tempDir('cc-test-guard-') });
    try {
      const manager = app.sessions as unknown as { claimTurn(id: string): () => void };
      const claim = manager.claimTurn.bind(manager);
      let guard = '';
      // R28-cl2-rev-04: the other process deletes the queued session after start() recorded it, before its claim.
      vi.spyOn(manager, 'claimTurn').mockImplementation((id) => {
        guard = app.sessions.store.guardDirOf(id);
        app.sessions.store.delete(id);
        return claim(id);
      });
      const before = app.runner.store.list().length;
      await expect(app.sessions.start({ mode: 'advisor', target: { type: 'none', value: null }, prompt: 'What is overdue?' })).rejects.toThrow(/no session/);
      expect(manager.claimTurn).toHaveBeenCalled();
      expect(app.runner.store.list().length).toBe(before);
      expect(fs.existsSync(guard)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it('given a session whose turn runs in another server process, when it is deleted here, then it is refused as busy', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot, guardRoot: tempDir('cc-test-guard-') });
    try {
      const meta = app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
      const run = app.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 2000)'], cwd: process.cwd() } });
      app.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'What is overdue?' });
      await expect(app.sessions.delete(meta.id)).rejects.toThrow(/running/);
      expect(app.sessions.read(meta.id)).not.toBeNull();
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
