import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { RunStore, runsDir } from '../../server/runner/store.js';
import { Runner, WRAPPER_PATH, pidAlive, processStartTime } from '../../server/runner/runner.js';
import { childEnv } from '../../server/system/child-env.js';
import { execNoShell } from '../../server/routes/system.js';
import { runModule } from '../../server/core/child.js';
import { EventBus } from '../../server/watch/bus.js';
import { writeTmpInput } from '../../server/actions/tmp-inputs.js';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const NOISY = path.join(PACKAGE_ROOT, 'tests', 'fakes', 'noisy.mjs');
const tmpRoot = () => tempDir('cc-runner-');
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
    const lines = fs.readFileSync(path.join(dir, 'raw.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { seq: number; stream: string; line: string });
    // stdout and stderr are read independently, so only per-stream order is deterministic.
    expect(lines.filter((l) => l.stream === 'stdout').map((l) => l.line)).toEqual(['line one', 'line two', 'line three']);
    expect(lines.filter((l) => l.stream === 'stderr').map((l) => l.line)).toEqual(['warning line']);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.seq).toBeGreaterThan(lines[i - 1]!.seq);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'))).toMatchObject({ code: 3, signal: null });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'wrapper.json'), 'utf8')).childPid).toBeGreaterThan(0);
  });

  it('redacts the Claude OAuth token from stored lines', () => {
    const dir = path.join(tmpRoot(), 'run3');
    fs.mkdirSync(dir);
    const r = spawnSync(process.execPath, [WRAPPER_PATH, dir, PACKAGE_ROOT, process.execPath, '-e', 'console.log("token=" + process.env.CLAUDE_CODE_OAUTH_TOKEN); console.error(process.env.CLAUDE_CODE_OAUTH_TOKEN)'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-secret-value' } });
    expect(r.status).toBe(0);
    const raw = fs.readFileSync(path.join(dir, 'raw.ndjson'), 'utf8');
    expect(raw).not.toContain('sk-ant-oat-secret-value');
    expect(raw).toContain('token=[redacted]');
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
    // Four runs created within one millisecond still list newest first, deterministically.
    expect(ids).toEqual([d.id, c.id, b.id]);
    expect(ids).toContain(c.id);
    expect(ids).toContain(d.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
    expect(fs.existsSync(path.join(runsDir(root), a.id))).toBe(false);
    expect(() => store.dirOf('../x')).toThrow(/bad run id/);
  });

  it('ignores stray entries in the runs folder: Finder\'s .DS_Store and a plain file with a run-like name (SW-server-01)', () => {
    const root = tmpRoot();
    const store = new RunStore(root, 1);
    fs.writeFileSync(path.join(runsDir(root), '.DS_Store'), 'finder');
    fs.writeFileSync(path.join(runsDir(root), 'notes'), 'a file, not a run');
    fs.mkdirSync(path.join(runsDir(root), 'empty-dir'));
    const base = { actionId: 'a', label: 'a', cost: 'free' as const, resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} };
    const a = store.create(base);
    store.write({ ...a, status: 'done' });
    const b = store.create(base);
    expect(store.list().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(store.read('notes')).toBeNull();
    store.write({ ...b, status: 'done' });
    expect(store.prune()).toBe(1);
    expect(store.list().map((r) => r.id)).toEqual([b.id]);
    expect(fs.readFileSync(path.join(runsDir(root), '.DS_Store'), 'utf8')).toBe('finder');
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

  it('removes the input file the app wrote for a run once the run finalizes, and nothing else', async () => {
    const root = tmpRoot();
    const runner = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const input = writeTmpInput(root, 'txt', 'pasted recruiter email');
    const keep = path.join(root, 'keep.txt');
    fs.writeFileSync(keep, 'x');
    const meta = runner.start(req(['0', '0', input, keep]));
    await until(() => runner.store.read(meta.id)?.status === 'done');
    expect(fs.existsSync(input)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it('records the input files a run was given and removes them when it ends, also one only its environment names', async () => {
    const root = tmpRoot();
    const runner = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(runner);
    // The network scan passes its filters file as CAREER_OPS_PORTALS, never as an argument.
    const filters = writeTmpInput(root, 'yml', 'title_filter: {}\n');
    const meta = runner.start(req(['0'], { env: { CAREER_OPS_PORTALS: filters }, tmpInputs: [filters] }));
    expect(meta.cmd.args).not.toContain(filters);
    expect(runner.store.read(meta.id)?.tmpInputs).toEqual([filters]);
    await until(() => runner.store.read(meta.id)?.status === 'done');
    expect(fs.existsSync(filters)).toBe(false);
  });

  it('a recorded input outside the tmp input folder is never removed', async () => {
    const root = tmpRoot();
    const runner = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const cv = path.join(root, 'cv.md');
    fs.writeFileSync(cv, '# CV');
    const meta = runner.start(req(['0'], { tmpInputs: [cv] }));
    await until(() => runner.store.read(meta.id)?.status === 'done');
    expect(fs.existsSync(cv)).toBe(true);
  });

  it('an input recorded for a run that is cancelled while queued is removed too', async () => {
    const root = tmpRoot();
    const runner = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const blocker = runner.start(req(['0', '1500'], { resources: ['tracker'] }));
    const input = writeTmpInput(root, 'txt', 'pasted');
    const queued = runner.start(req(['0'], { resources: ['tracker'], env: { INPUT: input }, tmpInputs: [input] }));
    expect(runner.store.read(queued.id)?.status).toBe('queued');
    expect(runner.cancel(queued.id)?.status).toBe('cancelled');
    expect(fs.existsSync(input)).toBe(false);
    await until(() => runner.store.read(blocker.id)?.status === 'done');
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

  it('a cancel that lands while the wrapper is still starting ends the run cancelled, with an exit record and no command left running', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const meta = runner.start(req(['0', '20000']));
    // At once: the wrapper process exists but has not run a line of its own yet (no wrapper.json, no signal handler).
    expect(runner.store.readWrapper(meta.id)).toBeNull();
    runner.cancel(meta.id);
    await until(() => Boolean(runner.store.readExit(meta.id)) && runner.store.read(meta.id)?.status === 'cancelled', 10_000);
    // The command never started, or was stopped with the run: nothing of it outlives the cancel.
    const childPid = runner.store.readWrapper(meta.id)?.childPid;
    if (childPid) await until(() => !pidAlive(childPid));
    expect(runner.store.readRaw(meta.id).lines.map((l) => l.line)).not.toContain('line three');
  });

  it('a wrapper that cannot be spawned (node gone after an upgrade) fails its run with the reason, and the next queued run still starts (SW7-server-03)', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50, nodePath: '/nonexistent/node-removed-by-brew-upgrade' });
    runners.push(runner);
    const meta = runner.start(req(['0'], { resources: ['pipeline'] }));
    await until(() => runner.store.read(meta.id)?.status === 'failed');
    expect(runner.store.read(meta.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not start.*ENOENT/i), endedAt: expect.any(String) });
    expect(runner.pending('test.noisy')).toEqual([]);
  });

  it('a spawn that throws at once (an argument node refuses) fails its run instead of leaving it claimed and queued forever (SW7-server-03)', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const bad = runner.start(req(['bad\u0000arg'], { resources: ['pipeline'] }));
    expect(runner.store.read(bad.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not start/i) });
    // The resource it would have held is free: the next run starts and finishes.
    const next = runner.start(req(['0'], { resources: ['pipeline'] }));
    await until(() => runner.store.read(next.id)?.status === 'done');
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

  it('records the wrapper and child start times so later checks can tell a reused PID apart', async () => {
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
    runners.push(runner);
    const meta = runner.start(req(['0', '1500']));
    await until(() => Boolean(runner.store.read(meta.id)?.childStartedAt));
    const running = runner.store.read(meta.id)!;
    expect(running.wrapperStartedAt).toBe(processStartTime(running.wrapperPid!));
    expect(running.childStartedAt).toBe(processStartTime(running.childPid!));
    // Seconds since the epoch, close to when the wrapper was spawned.
    expect(typeof running.wrapperStartedAt).toBe('number');
    expect(Math.abs((running.wrapperStartedAt as number) - Date.parse(running.startedAt!) / 1000)).toBeLessThan(5);
    expect(processStartTime(2147483646)).toBeNull();
  });

  it('reads a start time the same whatever TZ and locale the server runs under (seed: runner.ts:37)', () => {
    const before = processStartTime(process.pid);
    expect(typeof before).toBe('number');
    expect(Math.abs((before as number) - (Date.now() / 1000 - process.uptime()))).toBeLessThan(5);
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
    process.env.TZ = 'Asia/Tokyo';
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANG = 'de_DE.UTF-8';
    try {
      expect(processStartTime(process.pid)).toBe(before);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a live run is kept when the server restarts under another TZ or locale', async () => {
    const root = tmpRoot();
    const first = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(first);
    const meta = first.start(req(['0', '20000']));
    await until(() => Boolean(first.store.read(meta.id)?.childStartedAt));
    first.close();
    const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
    process.env.TZ = 'Asia/Tokyo';
    process.env.LC_ALL = 'de_DE.UTF-8';
    let second: Runner | null = null;
    try {
      second = new Runner(root, new EventBus(), { pollMs: 50 });
      runners.push(second);
      second.reconcile();
      expect(second.store.read(meta.id)?.status).toBe('running');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      second?.cancel(meta.id);
    }
  });

  it('a live wrapper is kept when ps says "no such process" but the PID still answers (they disagree): judged by liveness alone (seed review)', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const store = new RunStore(root);
      const run = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
      store.write({ ...run, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: 1_700_000_000 });
      // ps answering "no such process" for a PID kill(pid, 0) still finds.
      const runner = new Runner(root, new EventBus(), { pollMs: 50, procStart: () => null });
      runners.push(runner);
      runner.reconcile();
      expect(runner.store.read(run.id)?.status).toBe('running');
      runner.close();
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('on that disagreement, a PID that answers kill(pid, 0) only with EPERM is another user\'s process now, so the run is lost (seed review 2)', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const store = new RunStore(root);
      const run = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
      store.write({ ...run, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: 1_700_000_000 });
      // ps finds no such process, and kill(pid, 0) is refused: the PID exists but is not ours, so it is not our wrapper.
      const eperm = () => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      };
      const runner = new Runner(root, new EventBus(), { pollMs: 50, procStart: () => null, kill: eperm });
      runners.push(runner);
      runner.reconcile();
      expect(runner.store.read(run.id)?.status).toBe('lost');
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('a PID that answers kill(pid, 0) only with EPERM is never our run, whatever its recorded start: reconcile marks the run lost as reused (EPERM review)', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const store = new RunStore(root);
      const run = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: ['tracker'], claude: true, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
      // No start was recorded; after a reboot the PID belongs to a root process (kill(pid, 0) is refused).
      store.write({ ...run, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: null });
      const eperm = () => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      };
      const runner = new Runner(root, new EventBus(), { pollMs: 50, kill: eperm });
      runners.push(runner);
      runner.reconcile();
      expect(runner.store.read(run.id)).toMatchObject({ status: 'lost', error: expect.stringMatching(/belongs to another user's process/) });
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('a tracked run whose wrapper PID turns into another user\'s process (kill answers EPERM) ends lost instead of running for good (EPERM review)', async () => {
    let refused = false;
    const kill = (pid: number, signal: 0) => {
      if (refused) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      process.kill(pid, signal);
    };
    const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50, kill });
    runners.push(runner);
    const meta = runner.start(req(['0', '20000']));
    await until(() => runner.store.read(meta.id)?.status === 'running');
    refused = true;
    try {
      await until(() => runner.store.read(meta.id)?.status === 'lost');
    } finally {
      refused = false;
      const pid = runner.store.read(meta.id)?.childPid;
      if (pid) process.kill(-pid, 'SIGKILL');
    }
  });

  it('when ps cannot answer, a PID kill(pid, 0) refuses with EPERM (not ours) reads as gone, and one it accepts as unknown (EPERM review)', () => {
    const noPs = () => {
      throw Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' });
    };
    const eperm = () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    };
    // Fake kills: the answer does not depend on who runs the test (root, or a container whose PID 1 is this process).
    expect(processStartTime(4242, noPs, eperm)).toBeNull();
    expect(processStartTime(4242, noPs, () => undefined)).toBe('unknown');
  });

  it('when ps cannot answer, a live PID reads as unknown (kept) and a dead one as gone', () => {
    const noPs = () => {
      throw Object.assign(new Error('spawn /bin/ps ENOENT'), { code: 'ENOENT' });
    };
    expect(processStartTime(process.pid, noPs)).toBe('unknown');
    expect(processStartTime(2147483646, noPs)).toBeNull();
    // ps printing a start it cannot parse is unknown too, never a mismatch.
    expect(processStartTime(process.pid, () => 'gestern\n')).toBe('unknown');
  });

  it('a run recorded by an earlier version (start time as ps text) is judged by its PID alone: kept while it runs, lost once it is gone', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const store = new RunStore(root);
      const base = { actionId: 'x', label: 'x', cost: 'free' as const, resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} };
      const live = store.create(base);
      store.write({ ...live, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: 'Mon Oct  5 17:09:12 2026', childPid: sleeper.pid!, childStartedAt: 'Mon Oct  5 17:09:12 2026' });
      const gone = store.create(base);
      store.write({ ...gone, status: 'running', wrapperPid: 2147483646, wrapperStartedAt: 'Mon Oct  5 17:09:12 2026' });
      const runner = new Runner(root, new EventBus(), { pollMs: 50 });
      runners.push(runner);
      runner.reconcile();
      expect(runner.store.read(live.id)?.status).toBe('running');
      expect(runner.store.read(gone.id)?.status).toBe('lost');
      runner.close();
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('reconcile never adopts a live PID whose start time differs (PID reuse after a reboot)', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const store = new RunStore(root);
      const stale = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
      store.write({ ...stale, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: 1, childPid: sleeper.pid!, childStartedAt: 1 });
      const runner = new Runner(root, new EventBus(), { pollMs: 50 });
      runners.push(runner);
      runner.reconcile();
      expect(runner.store.read(stale.id)).toMatchObject({ status: 'lost', error: expect.stringMatching(/start time/) });
      expect(pidAlive(sleeper.pid!)).toBe(true);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('cancel never signals a process group whose recorded start time does not match', async () => {
    const root = tmpRoot();
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    try {
      const store = new RunStore(root);
      const stale = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: false, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
      store.write({ ...stale, status: 'running', wrapperPid: sleeper.pid!, wrapperStartedAt: 1, childPid: sleeper.pid!, childStartedAt: 1 });
      const runner = new Runner(root, new EventBus(), { pollMs: 50 });
      runners.push(runner);
      expect(runner.cancel(stale.id)).toMatchObject({ status: 'lost', error: expect.stringMatching(/nothing was signalled/) });
      await wait(300);
      expect(pidAlive(sleeper.pid!)).toBe(true);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });

  it('reconcile marks a run that was still queued lost, and that run can never be spawned afterwards', async () => {
    const root = tmpRoot();
    const first = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(first);
    const holder = first.start(req(['0', '800'], { resources: ['tracker'] }));
    const waiting = first.start(req(['0'], { resources: ['tracker'] }));
    expect(first.queuedIds()).toEqual([waiting.id]);
    // A second process (the restarted server) reconciles while the first still holds the run in memory.
    const second = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(second);
    second.reconcile();
    expect(second.store.read(waiting.id)).toMatchObject({ status: 'lost', error: expect.stringMatching(/queued when the server restarted/) });
    await until(() => first.store.read(holder.id)?.status === 'done');
    await wait(400);
    expect(first.store.read(waiting.id)).toMatchObject({ status: 'lost', wrapperPid: null });
    expect(first.queuedIds()).toEqual([]);
  });

  it('cancel works for a queued run this process never had in its queue', () => {
    const root = tmpRoot();
    const store = new RunStore(root);
    const queued = store.create({ actionId: 'x', label: 'x', cost: 'free', resources: [], claude: true, cmd: { bin: 'x', args: [], cwd: '/' }, params: {} });
    const runner = new Runner(root, new EventBus(), { pollMs: 50 });
    runners.push(runner);
    expect(runner.cancel(queued.id)?.status).toBe('cancelled');
    expect(runner.store.read(queued.id)?.status).toBe('cancelled');
  });

  it('children never inherit CC_TOKEN, CC_SESSION_SECRET or any other internal CC_ variable', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CC_TOKEN: 'leak-token', CC_SESSION_SECRET: 'leak-secret', CC_DATA_ROOT: '/x', CC_GUARD_DIR: '/g' });
    try {
      const dump = "process.stdout.write(Object.keys(process.env).filter((k) => k.startsWith('CC_')).sort().join(','))";
      expect(childEnv({ CC_POLICY_FILE: '/p' })).toMatchObject({ CC_POLICY_FILE: '/p' });
      expect(Object.keys(childEnv()).filter((k) => k.startsWith('CC_'))).toEqual([]);
      const runner = new Runner(tmpRoot(), new EventBus(), { pollMs: 50 });
      runners.push(runner);
      const meta = runner.start({ ...req([]), cmd: { bin: process.execPath, args: ['-e', dump], cwd: PACKAGE_ROOT }, env: { CC_MODE: 'explicit' } });
      await until(() => runner.store.read(meta.id)?.status === 'done');
      expect(runner.store.readRaw(meta.id).lines.map((l) => l.line)).toEqual(['CC_MODE']);
      const exec = await execNoShell(process.execPath, ['-e', dump], { timeoutMs: 10_000 });
      expect(exec.stdout).toBe('');
      const mod = await runModule(`${dump}`, { cwd: PACKAGE_ROOT, env: {}, input: null, timeoutMs: 10_000 });
      expect(mod.stdout).toBe('');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
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
