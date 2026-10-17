import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
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
});
