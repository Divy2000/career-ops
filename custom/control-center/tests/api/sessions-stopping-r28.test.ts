// GET /api/sessions says when a cancelled session's process is still stopping, so pages keep its posting out of a new
// Evaluate the server would refuse as a duplicate (R28-fb-rev-01).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type App = Awaited<ReturnType<typeof makeTestApp>>;
const call = (app: App, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.app.inject({ method, url, headers: method === 'GET' ? app.authed : app.authedWrite, payload: method === 'GET' ? undefined : (payload ?? {}) });
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(25);
  }
}
const INIT = { type: 'system', subtype: 'init', model: 'fake-model', tools: ['Read'] };
/** A CLI slow to stop: SIGTERM does nothing, so a cancelled run lives until the runner's SIGKILL. */
const STUBBORN = { events: [INIT, { __ignoreSigterm: true }, ...Array.from({ length: 200 }, () => ({ __sleep: 100 }))] };

describe('sessions list and a cancelled evaluation still stopping (R28-fb-rev-01)', () => {
  it('given a cancelled evaluation whose process is still stopping, when the sessions are listed, then it is marked stopping until its run ends', async () => {
    const app = await makeTestApp();
    const file = path.join(tempDir('cc-r28-scenario-'), 'scenario.json');
    fs.writeFileSync(file, JSON.stringify(STUBBORN));
    process.env.FAKE_CLAUDE_SCENARIO = file;
    try {
      const url = 'https://jobs.example.com/synthetic/r28-fb-rev-01';
      const started = (await call(app, 'POST', '/api/sessions', { mode: 'oferta', target: { type: 'url', value: url }, prompt: 'Evaluate it' })).json();
      const runId = started.turns[0].runId as string;
      await until(() => app.runner.store.read(runId)?.childPid != null);
      expect((await call(app, 'POST', `/api/sessions/${started.id}/cancel`, {})).statusCode).toBe(200);

      const listed = () => call(app, 'GET', '/api/sessions').then((r) => r.json().find((m: { id: string }) => m.id === started.id));
      const during = await listed();
      expect(during.status).toBe('cancelled');
      expect(during.stopping).toBe(true);

      await until(() => app.runner.store.read(runId)?.endedAt != null, 20_000);
      // The session lets go of the run just after the run record ends.
      let after = await listed();
      for (let i = 0; i < 200 && after.stopping !== undefined; i++) after = await wait(25).then(listed);
      expect(after.status).toBe('cancelled');
      expect(after.stopping).toBeUndefined();
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      await app.close();
    }
  }, 40_000);
});
