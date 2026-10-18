import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { copyFixtureRoot, makeTestApp } from '../helpers/app.js';
import { runsEnded } from '../helpers/runs.js';
import { tempDir } from '../helpers/tmp.js';
import { processStartTime } from '../../supervisor/instance-lock.js';

type App = Awaited<ReturnType<typeof makeTestApp>>;

/** A session whose last turn ended, as far as its record tells. */
const idleSession = (app: App) => {
  const meta = app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
  return app.sessions.store.setStatus(meta.id, 'done');
};
const newSession = (app: App) => app.sessions.store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: null });
const revert = (app: App, sessionId: string) => app.app.inject({ method: 'POST', url: '/api/dev/revert', headers: app.authedWrite, payload: { sessionId, turn: 1 } });

/** A real second process holding the session's claim `name`, as a peer server process finalizing or starting its turn does. */
async function heldByOtherProcess(app: App, id: string, name: string) {
  const ready = path.join(tempDir('cc-r33-revert-peer-'), 'ready');
  const child = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`], { stdio: 'ignore' });
  while (!fs.existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
  const dir = app.sessions.store.guardDirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: child.pid, start: processStartTime(child.pid!), at: Date.now(), nonce: 'peer' }));
  return {
    async exit() {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGKILL');
      await gone;
    },
  };
}

// R33-mgr-FC-02: the Dev Chat revert checked only this process's trackers and the recorded status, so it reverted a
// turn's files while another server process (a blue/green handover) was still finalizing that turn or starting the next.
describe('a Dev Chat revert beside a turn another server process holds (R33-mgr-FC-02)', () => {
  it('given another process holding the track claim of an ended turn, when a turn is reverted here, then it is refused (409) until that process is gone', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot });
    try {
      const meta = idleSession(app);
      const peer = await heldByOtherProcess(app, meta.id, 'track.claim');
      try {
        const refused = await revert(app, meta.id);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error).toMatch(/finishing/);
      } finally {
        await peer.exit();
      }
      expect((await revert(app, meta.id)).statusCode).toBe(200);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given another process holding the turn claim (preparing a turn), when a turn is reverted here, then it is refused (409)', async () => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot });
    try {
      const meta = idleSession(app);
      const peer = await heldByOtherProcess(app, meta.id, 'turn.claim');
      try {
        expect((await revert(app, meta.id)).statusCode).toBe(409);
      } finally {
        await peer.exit();
      }
      expect((await revert(app, meta.id)).statusCode).toBe(200);
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });

  it('given a cancelled turn another server process is still stopping, when it is reverted here, then it is refused (409)', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = tempDir('cc-test-guard-');
    const peer = await makeTestApp({ dataRoot, guardRoot });
    const app = await makeTestApp({ dataRoot, guardRoot });
    try {
      const meta = newSession(peer);
      const ready = path.join(tempDir('cc-r33-revert-stopping-'), 'ready');
      const run = peer.runner.start({ actionId: 'session.advisor', label: 'Ask (advisor): turn 1', cost: 'tokens', resources: [], claude: false, params: { sessionId: meta.id, turn: 1 }, cmd: { bin: process.execPath, args: ['-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setTimeout(() => {}, 3000)`], cwd: process.cwd() } });
      peer.sessions.store.beginTurn(meta.id, { runId: run.id, userText: 'What is overdue?' });
      while (!fs.existsSync(ready)) await new Promise((r) => setTimeout(r, 20));
      expect(peer.runner.cancel(run.id)).toMatchObject({ status: 'cancelled', endedAt: null });
      peer.sessions.store.setStatus(meta.id, 'cancelled');
      expect((await revert(app, meta.id)).statusCode).toBe(409);
    } finally {
      await app.close();
      await peer.close();
      await runsEnded(dataRoot);
    }
  });
});

// R34-srv-core-L2-02: whileIdle read the store unguarded, so a malformed id or a torn record answered 500.
describe('a Dev Chat revert of a session that cannot be read (R34-srv-core-L2-02)', () => {
  it.each([
    ['a malformed session id', (_app: App) => '../x'],
    ['a torn meta.json', (app: App) => {
      const meta = idleSession(app);
      fs.writeFileSync(path.join(app.sessions.store.dirOf(meta.id), 'meta.json'), '{"id":');
      return meta.id;
    }],
  ])('given %s, when a turn is reverted, then it answers 404 like the changes card', async (_name, sessionOf) => {
    const dataRoot = copyFixtureRoot();
    const app = await makeTestApp({ dataRoot });
    try {
      const res = await revert(app, sessionOf(app));
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('no such session');
    } finally {
      await app.close();
      await runsEnded(dataRoot);
    }
  });
});
