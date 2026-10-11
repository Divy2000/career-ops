// A run's event stream over real HTTP across a dropped connection: the browser reconnects with the last `id:` it got
// as Last-Event-ID, and the server must resume after it. Replaying from the start would show every earlier line twice,
// since the Runs log appends each line it receives.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { gatedScript } from '../helpers/gated-run.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StreamEvent {
  id: string | undefined;
  type: string;
  data: unknown;
}

/**
 * Opens the run's stream, sending `lastEventId` when given, and reads events until `stopWhen` says to drop the
 * connection or the server ends it.
 */
async function readStream(t: TestApp, runId: string, opts: { lastEventId?: string; stopWhen?: (events: StreamEvent[]) => boolean }): Promise<StreamEvent[]> {
  const { port } = t.app.server.address() as AddressInfo;
  const headers = { ...t.authed, ...(opts.lastEventId ? { 'last-event-id': opts.lastEventId } : {}) };
  const events: StreamEvent[] = [];
  let client: http.ClientRequest | undefined;
  const done = new Promise<void>((resolve, reject) => {
    client = http.get({ host: '127.0.0.1', port, path: `/api/runs/${runId}/events`, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!type || data === undefined) continue;
          events.push({ id: /^id: (.*)$/m.exec(block)?.[1], type, data: JSON.parse(data) as unknown });
          if (opts.stopWhen?.(events)) return resolve();
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    client.on('error', reject);
  });
  try {
    await Promise.race([done, wait(10_000).then(() => Promise.reject(new Error('stream did not reach its stop point in 10 s')))]);
    return events;
  } finally {
    client?.destroy();
  }
}

const lineTexts = (events: StreamEvent[]) => events.filter((e) => e.type === 'line').map((e) => (e.data as { line: string }).line);

describe('the run event stream after a dropped connection', () => {
  it('given a client that dropped after line 1, when it reconnects with Last-Event-ID: 1, then only the later lines and the end are sent', async () => {
    const t = await makeTestApp();
    const gate = path.join(tempDir('cc-run-replay-'), 'go');
    const run = t.runner.start({ actionId: 'test.gated', label: 'gated', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: ['-e', gatedScript(gate)], cwd: PACKAGE_ROOT } });
    try {
      await t.app.listen({ host: '127.0.0.1', port: 0 });
      const first = await readStream(t, run.id, { stopWhen: (events) => events.some((e) => e.type === 'line') });
      expect(first).toEqual([{ id: '1', type: 'line', data: expect.objectContaining({ seq: 1, line: 'scanning greenhouse' }) }]);

      // The run keeps going while the client is away.
      fs.writeFileSync(gate, '');
      const deadline = Date.now() + 10_000;
      while (!t.runner.store.read(run.id)?.endedAt && Date.now() < deadline) await wait(50);

      const resumed = await readStream(t, run.id, { lastEventId: '1' });
      expect(lineTexts(resumed)).toEqual(['scanning ashby', 'scanning lever']);
      expect(resumed.filter((e) => e.type === 'line').map((e) => e.id)).toEqual(['2', '3']);
      expect(resumed.at(-1)).toEqual({ id: undefined, type: 'run.done', data: { status: 'done', exitCode: 0, signal: null } });
    } finally {
      fs.writeFileSync(gate, '');
      const deadline = Date.now() + 10_000;
      while (!t.runner.store.read(run.id)?.endedAt && Date.now() < deadline) await wait(50);
      await t.close();
    }
  }, 30_000);
});
