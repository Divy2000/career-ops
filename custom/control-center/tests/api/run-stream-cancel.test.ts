import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { processStartTime } from '../../server/runner/runner.js';
import { makeTestApp, PACKAGE_ROOT, type TestApp } from '../helpers/app.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Prints while it shuts down: on SIGTERM it says so, keeps going for a second, then exits 3.
const SLOW_STOP = [
  "console.log('ready');",
  "process.on('SIGTERM', () => { console.log('stopping'); setTimeout(() => { console.log('stopped'); process.exit(3); }, 1000); });",
  'setInterval(() => {}, 1000);',
].join(' ');

interface StreamEvent {
  type: string;
  data: unknown;
}

/** Reads a run's event stream over real HTTP until the server ends it; `onEvent` sees each event as it arrives. */
async function readRunStream(t: TestApp, runId: string, timeoutMs: number, onEvent: (e: StreamEvent) => void = () => undefined): Promise<StreamEvent[]> {
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.address() as AddressInfo;
  const events: StreamEvent[] = [];
  let client: http.ClientRequest | undefined;
  const ended = new Promise<void>((resolve, reject) => {
    client = http.get({ host: '127.0.0.1', port, path: `/api/runs/${runId}/events`, headers: t.authed }, (res) => {
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
          const event = { type, data: JSON.parse(data) as unknown };
          events.push(event);
          onEvent(event);
        }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    client.on('error', reject);
  });
  try {
    await Promise.race([ended, wait(timeoutMs).then(() => Promise.reject(new Error(`stream still open after ${timeoutMs} ms`)))]);
    return events;
  } finally {
    client?.destroy();
  }
}

describe('the run event stream (R18-srv-core-L3-01)', () => {
  it('keeps streaming a cancelled run until its command really exits, then reports that exit', async () => {
    const t = await makeTestApp();
    const run = t.runner.start({ actionId: 'test.slowstop', label: 'slow stop', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: ['-e', SLOW_STOP], cwd: PACKAGE_ROOT } });
    try {
      let cancelled = false;
      const events = await readRunStream(t, run.id, 15_000, (e) => {
        // Cancel once the command is up and has its SIGTERM handler.
        if (!cancelled && e.type === 'line' && (e.data as { line: string }).line === 'ready') {
          cancelled = true;
          t.runner.cancel(run.id);
        }
      });
      const lines = events.filter((e) => e.type === 'line').map((e) => (e.data as { line: string }).line);
      expect(lines).toEqual(['ready', 'stopping', 'stopped']);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'cancelled', exitCode: 3, signal: null } });
    } finally {
      t.runner.cancel(run.id);
      const deadline = Date.now() + 15_000;
      while (!t.runner.store.readExit(run.id) && Date.now() < deadline) await wait(50);
      await t.close();
    }
  }, 30_000);

  it('keeps streaming a cancelled run that outlasts the grace, when cancel could only signal its wrapper, until it is killed', async () => {
    const t = await makeTestApp();
    // Would stop 11 s after SIGTERM: past the 5 s grace, so the SIGKILL ends it first.
    const slow = SLOW_STOP.replace('1000);', '11000);');
    const run = t.runner.start({ actionId: 'test.slowstop', label: 'slow stop', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: ['-e', slow], cwd: PACKAGE_ROOT } });
    try {
      let cancelled = false;
      const events = await readRunStream(t, run.id, 25_000, (e) => {
        if (!cancelled && e.type === 'line' && (e.data as { line: string }).line === 'ready') {
          cancelled = true;
          // The command's start time could not be read (as when ps answers unknown): cancel signals the wrapper only.
          t.runner.store.write({ ...t.runner.store.read(run.id)!, childStartedAt: null });
          t.runner.cancel(run.id);
        }
      });
      const lines = events.filter((e) => e.type === 'line').map((e) => (e.data as { line: string }).line);
      expect(lines).toEqual(['ready', 'stopping']);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'cancelled', exitCode: null, signal: 'SIGKILL' } });
    } finally {
      const deadline = Date.now() + 20_000;
      while (!t.runner.store.readExit(run.id) && Date.now() < deadline) await wait(50);
      await t.close();
    }
  }, 45_000);

  it('ends the stream of a run whose folder is deleted while it streams, instead of polling for it forever', async () => {
    const t = await makeTestApp();
    // Exits on its own: once its folder is gone, cancel can no longer find it to stop it.
    const run = t.runner.start({ actionId: 'test.gone', label: 'gone', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: ['-e', "console.log('ready'); setTimeout(() => process.exit(0), 2000);"], cwd: PACKAGE_ROOT } });
    try {
      let deleted = false;
      const events = await readRunStream(t, run.id, 5_000, (e) => {
        if (!deleted && e.type === 'line' && (e.data as { line: string }).line === 'ready') {
          deleted = true;
          fs.rmSync(t.runner.store.dirOf(run.id), { recursive: true, force: true });
        }
      });
      expect(deleted).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'gone', exitCode: null, signal: null } });
    } finally {
      // The runner records the run's end into its folder, and throws when the folder is gone: give it one to write to.
      const dir = t.runner.store.dirOf(run.id);
      fs.mkdirSync(dir, { recursive: true });
      const deadline = Date.now() + 10_000;
      while (!t.runner.store.read(run.id)?.endedAt && Date.now() < deadline) await wait(50);
      await t.close();
    }
  }, 30_000);

  it('settles a cancelled run whose wrapper is gone without an exit record and ends its stream', async () => {
    const t = await makeTestApp();
    // Marked cancelled by a process that is gone, and its wrapper is gone too without an exit record.
    const meta = t.runner.store.create({ actionId: 'test.orphan', label: 'orphan', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [], cwd: PACKAGE_ROOT } });
    t.runner.store.write({ ...meta, status: 'cancelled', startedAt: new Date().toISOString() });
    try {
      const events = await readRunStream(t, meta.id, 20_000);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'cancelled', exitCode: null, signal: null } });
    } finally {
      await t.close();
    }
  }, 30_000);

  it('settles a cancelled run nothing tracks from its exit record and ends its stream with that exit', async () => {
    const t = await makeTestApp();
    const meta = t.runner.store.create({ actionId: 'test.orphan', label: 'orphan', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [], cwd: PACKAGE_ROOT } });
    // Cancelled by a server that then stopped; its wrapper wrote its exit after that, and its PID is still ours (reused).
    const started = processStartTime(process.pid);
    t.runner.store.write({ ...meta, status: 'cancelled', startedAt: new Date().toISOString(), wrapperPid: process.pid, wrapperStartedAt: typeof started === 'number' ? started : null });
    fs.writeFileSync(path.join(t.runner.store.dirOf(meta.id), 'exit.json'), JSON.stringify({ code: null, signal: 'SIGTERM', endedAt: new Date().toISOString() }));
    try {
      const events = await readRunStream(t, meta.id, 5_000);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'cancelled', exitCode: null, signal: 'SIGTERM' } });
    } finally {
      await t.close();
    }
  }, 30_000);

  it('ends the stream with what is on disk when settling an untracked cancelled run fails, and the server keeps serving', async () => {
    const t = await makeTestApp();
    const meta = t.runner.store.create({ actionId: 'test.orphan', label: 'orphan', cost: 'free', resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [], cwd: PACKAGE_ROOT } });
    t.runner.store.write({ ...meta, status: 'cancelled', startedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(t.runner.store.dirOf(meta.id), 'exit.json'), JSON.stringify({ code: null, signal: 'SIGTERM', endedAt: new Date().toISOString() }));
    const write = vi.spyOn(t.runner.store, 'write').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    try {
      const events = await readRunStream(t, meta.id, 5_000);
      expect(events.at(-1)).toEqual({ type: 'run.done', data: { status: 'cancelled', exitCode: null, signal: null } });
      write.mockRestore();
      const health = await t.app.inject({ method: 'GET', url: `/api/runs/${meta.id}`, headers: t.authed });
      expect(health.statusCode).toBe(200);
    } finally {
      write.mockRestore();
      await t.close();
    }
  }, 30_000);
});
