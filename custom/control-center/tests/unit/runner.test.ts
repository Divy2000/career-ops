import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunStore, runsDir } from '../../server/runner/store.js';
import { Runner, WRAPPER_PATH, pidAlive } from '../../server/runner/runner.js';
import { EventBus } from '../../server/watch/bus.js';
import { PACKAGE_ROOT } from '../helpers/app.js';

const NOISY = path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs');
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-runner-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await wait(50);
  }
}

const runners: Runner[] = [];
afterEach(() => {
  for (const r of runners.splice(0)) r.close();
});

function req(cmdArgs: string[], extra: Partial<Parameters<Runner['start']>[0]> = {}) {
  return { actionId: 'test.noisy', label: 'noisy', cost: 'free' as const, resources: [], claude: false, params: {}, cmd: { bin: process.execPath, args: [NOISY, ...cmdArgs], cwd: PACKAGE_ROOT }, ...extra };
}

describe('wrapper.mjs', () => {
  it('records stdout and stderr lines as NDJSON and writes exit.json', () => {
    const dir = path.join(tmpRoot(), 'run1');
    fs.mkdirSync(dir);
    const r = spawnSync(process.execPath, [WRAPPER_PATH, dir, PACKAGE_ROOT, process.execPath, NOISY, '3'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(path.join(dir, 'raw.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.line)).toEqual(['line one', 'line two', 'warning line', 'line three']);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(lines[2].stream).toBe('stderr');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'))).toMatchObject({ code: 3, signal: null });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'wrapper.json'), 'utf8')).childPid).toBeGreaterThan(0);
  });

  it('records a spawn failure instead of hanging', () => {
    const dir = path.join(tmpRoot(), 'run2');
    fs.mkdirSync(dir);
    const r = spawnSync(process.execPath, [WRAPPER_PATH, dir, PACKAGE_ROOT, '/no/such/binary'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8')).code).toBe(127);
  });
});

describe('RunStore', () => {
  it('creates, lists newest first and prunes finished runs beyond the retention', () => {
    const root = tmpRoot();
    const store = new RunStore(root, 2);
    const base = { actionId: 'a', label: 'a', cost: 'free' as const, resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} };
    const a = store.create(base);
    store.write({ ...a, status: 'done' });
    const b = store.create(base);
    store.write({ ...b, status: 'done' });
    const c = store.create(base);
    store.write({ ...c, status: 'running' });
    const d = store.create(base);
    store.write({ ...d, status: 'done' });
    store.prune();
    const ids = store.list().map((r) => r.id);
    expect(ids).toContain(c.id);
    expect(ids).toContain(d.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(fs.existsSync(path.join(runsDir(root), a.id))).toBe(false);
    expect(() => store.dirOf('../x')).toThrow(/bad run id/);
  });

  it('reads raw lines incrementally and skips torn lines', () => {
    const root = tmpRoot();
    const store = new RunStore(root);
    const meta = store.create({ actionId: 'a', label: 'a', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
    const raw = path.join(store.dirOf(meta.id), 'raw.ndjson');
    fs.writeFileSync(raw, '{"seq":1,"ts":"t","stream":"stdout","line":"a"}\n{"seq":2,"ts":"t","stream":"stdout","line":"b"}\n{"seq":3,"ts":"t","str');
    const first = store.readRaw(meta.id);
    expect(first.lines.map((l) => l.line)).toEqual(['a', 'b']);
    fs.appendFileSync(raw, 'eam":"stdout","line":"c"}\n');
    const second = store.readRaw(meta.id, 2, first.offset);
    expect(second.lines.map((l) => l.line)).toEqual(['c']);
  });
});

describe('Runner', () => {
  it('runs a command detached, streams its lines and finalizes with the exit code', async () => {
    const root = tmpRoot();
    const bus = new EventBus();
    const events: string[] = [];
    bus.onEvent((e) => events.push(`${e.type}:${(e.payload as { status: string }).status}`));
    const runner = new Runner(root, bus, { pollMs: 50 });
    runners.push(runner);
    const meta = runner.start(req(['0']));
    await until(() => runner.store.read(meta.id)?.status === 'done');
    const final = runner.store.read(meta.id)!;
    expect(final).toMatchObject({ status: 'done', exitCode: 0 });
    expect(final.wrapperPid).toBeGreaterThan(0);
    expect(runner.store.readRaw(meta.id).lines.map((l) => l.line)).toContain('line three');
    expect(events).toEqual(['run.status:queued', 'run.status:running', 'run.status:done']);
  });

  it('marks a non-zero exit as failed', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const meta = runner.start(req(['2']));
    await until(() => runner.store.read(meta.id)?.status === 'failed');
    expect(runner.store.read(meta.id)?.exitCode).toBe(2);
  });

  it('cancel kills the process group and the run ends cancelled', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const meta = runner.start(req(['0', '20000']));
    // Wait until the command is really running (it printed its first lines) so the SIGTERM handler is installed.
    await until(() => Boolean(runner.store.read(meta.id)?.childPid) && runner.store.readRaw(meta.id).lines.length >= 3);
    const childPid = runner.store.read(meta.id)!.childPid!;
    expect(pidAlive(childPid)).toBe(true);
    runner.cancel(meta.id);
    await until(() => runner.store.read(meta.id)?.status === 'cancelled' && Boolean(runner.store.readExit(meta.id)));
    await until(() => !pidAlive(childPid));
    expect(runner.store.readRaw(meta.id).lines.map((l) => l.line)).toContain('got SIGTERM');
  });

  it('orders runs that share a resource and drops a queued run on cancel', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const first = runner.start(req(['0', '1500'], { resources: ['tracker'] }));
    const second = runner.start(req(['0'], { resources: ['tracker'] }));
    const third = runner.start(req(['0'], { resources: ['tracker'] }));
    expect(runner.queuedIds()).toEqual([second.id, third.id]);
    expect(runner.cancel(third.id)?.status).toBe('cancelled');
    expect(runner.store.read(second.id)?.status).toBe('queued');
    await until(() => runner.store.read(first.id)?.status === 'done');
    await until(() => runner.store.read(second.id)?.status === 'done');
    expect(runner.store.read(second.id)!.startedAt! >= runner.store.read(first.id)!.endedAt!).toBe(true);
  });

  it('reconcile after a restart finalizes finished runs, keeps tailing live ones and marks dead ones lost', async () => {
    const root = tmpRoot();
    const first = new Runner(root, new EventBus(), { pollMs: 50 });
    const live = first.start(req(['0', '3000']));
    const dead = first.start(req(['0']));
    await until(() => Boolean(first.store.read(live.id)?.childPid));
    await until(() => first.store.read(dead.id)?.status === 'done');
    first.close();
    // Simulate a crash: pretend the finished run was still marked running, and fake a vanished wrapper.
    const store = new RunStore(root);
    store.write({ ...store.read(dead.id)!, status: 'running' });
    const ghost = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
    store.write({ ...ghost, status: 'running', wrapperPid: 2147483646 });
    const second = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(second);
    second.reconcile();
    expect(second.store.read(dead.id)?.status).toBe('done');
    expect(second.store.read(ghost.id)?.status).toBe('lost');
    await until(() => second.store.read(live.id)?.status === 'done', 15_000);
  });
});
