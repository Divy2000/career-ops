import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('closing the server (a blue/green reload drains the old child)', () => {
  /** Opens `url` as a real HTTP event stream, closes the app, and says whether close() returned and the stream ended. */
  async function closeWithStreamOpen(t: TestApp, url: string): Promise<{ closed: boolean; stream: string }> {
    let closed = false;
    let client: http.ClientRequest | undefined;
    try {
      await t.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = t.app.server.address() as AddressInfo;
      const ended = new Promise<string>((resolve, reject) => {
        const req = (client = http.get({ host: '127.0.0.1', port, path: url, headers: t.authed }, (res) => {
          expect(res.statusCode).toBe(200);
          res.resume();
          res.on('end', () => resolve('ended'));
          res.on('error', reject);
        }));
        req.on('error', reject);
      });
      ended.catch(() => undefined);
      await wait(200);
      await Promise.race([t.close().then(() => (closed = true)), wait(3000)]);
      return { closed, stream: await Promise.race([ended, wait(1000).then(() => 'still open')]) };
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
    const { id } = created.json() as { id: string };
    expect(await closeWithStreamOpen(t, `/api/sessions/${id}/events`)).toEqual({ closed: true, stream: 'ended' });
  });

  it('ends an open run event stream too', async () => {
    const t = await makeTestApp();
    const run = t.runner.start({ actionId: 'test.noisy', label: 'noisy', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs'), '0', '20000'], cwd: PACKAGE_ROOT } });
    try {
      expect(await closeWithStreamOpen(t, `/api/runs/${run.id}/events`)).toEqual({ closed: true, stream: 'ended' });
    } finally {
      t.runner.cancel(run.id);
    }
  });
});
