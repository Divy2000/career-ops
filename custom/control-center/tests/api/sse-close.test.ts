import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run's detached wrapper writes into the test root until it exits; the file's temp dirs go only after that. */
async function exited(t: TestApp, runId: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!t.runner.store.readExit(runId)) {
    if (Date.now() > deadline) throw new Error(`run ${runId} has no exit record after ${timeoutMs} ms`);
    await wait(50);
  }
}

describe('closing the server (a blue/green reload drains the old child)', () => {
  /**
   * Opens `url` as a real HTTP event stream, closes the app once the stream has answered, and says what the stream
   * answered, whether close() returned and whether the stream ended.
   */
  async function closeWithStreamOpen(t: TestApp, url: string): Promise<{ status: number; closed: boolean; stream: string }> {
    let closed = false;
    let client: http.ClientRequest | undefined;
    try {
      await t.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = t.app.server.address() as AddressInfo;
      let ended!: Promise<string>;
      // Resolved by the response itself: the stream is open once its headers are back, with no fixed wait.
      const opened = new Promise<number>((resolveOpened, reject) => {
        ended = new Promise<string>((resolveEnded, rejectEnded) => {
          const req = (client = http.get({ host: '127.0.0.1', port, path: url, headers: t.authed }, (res) => {
            resolveOpened(res.statusCode ?? 0);
            res.resume();
            res.on('end', () => resolveEnded('ended'));
            res.on('error', rejectEnded);
          }));
          req.on('error', (err) => {
            reject(err);
            rejectEnded(err);
          });
        });
      });
      ended.catch(() => undefined);
      const status = await opened;
      await Promise.race([t.close().then(() => (closed = true)), wait(3000)]);
      return { status, closed, stream: await Promise.race([ended, wait(1000).then(() => 'still open')]) };
    } finally {
      // A hung close is released by the client leaving, so a failure here reports instead of timing out.
      client?.destroy();
      if (!closed) await t.close();
    }
  }

  it('ends an open session event stream instead of waiting for the browser to leave', async () => {
    const t = await makeTestApp();
    const created = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: t.authedWrite, payload: { mode: 'deep', prompt: 'Research' } });
    expect(created.statusCode, created.body).toBe(202);
    const { id, turns } = created.json() as { id: string; turns: Array<{ runId: string }> };
    try {
      expect(await closeWithStreamOpen(t, `/api/sessions/${id}/events`)).toEqual({ status: 200, closed: true, stream: 'ended' });
    } finally {
      await exited(t, turns[0]!.runId);
    }
  });

  it('ends an open run event stream too', async () => {
    const t = await makeTestApp();
    const run = t.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    try {
      expect(await closeWithStreamOpen(t, `/api/runs/${run.id}/events`)).toEqual({ status: 200, closed: true, stream: 'ended' });
    } finally {
      t.runner.cancel(run.id);
      await exited(t, run.id);
    }
  });
});
