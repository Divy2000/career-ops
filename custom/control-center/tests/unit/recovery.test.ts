import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { changesByTurn, diffFile, listChanges, recordTurnAfter, recoveryRequestAllowed, recoveryRevert, revertFile, revertTurn, RevertRefused, snapshotKey } from '../../supervisor/recovery.js';
import { BlueGreen, type ChildHandle } from '../../supervisor/bluegreen.js';
import { defaultGuardRoot, resolveGuardRoot } from '../../supervisor/guard-root.js';
import { foldsCase } from '../helpers/case.js';

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A finished two-turn Dev Chat change set as the app records it: per-turn
 * policy and post-turn hashes under the guard dir, which sits outside the root.
 */
function fakeSession() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-')));
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-guard-')));
  const file = path.join(root, 'custom', 'notes.md');
  const created = path.join(root, 'custom', 'new.md');
  fs.mkdirSync(path.join(root, 'custom'), { recursive: true });
  fs.writeFileSync(file, 'line one\nline two\n');
  // Turn 1: edit notes.md and create new.md; turn 2: edit notes.md again.
  const t1 = path.join(sessionDir, 'turns', '1');
  const t2 = path.join(sessionDir, 'turns', '2');
  const policy = { codeRoot: root, dataRoot: root, sessionDir, allow: ['custom/**'], deny: ['data/blacklist.md', 'data/applications.md'], bash: [], playwright: false };
  for (const t of [t1, t2]) {
    fs.mkdirSync(path.join(t, 'before'), { recursive: true });
    fs.writeFileSync(path.join(t, 'policy.json'), JSON.stringify(policy));
  }
  fs.writeFileSync(path.join(t1, 'turn.json'), JSON.stringify({ filesOffset: 0 }));
  fs.copyFileSync(file, snapshotKey(t1, file));
  fs.writeFileSync(`${snapshotKey(t1, created)}.absent`, '');
  fs.writeFileSync(file, 'line one\nline TWO\n');
  fs.writeFileSync(created, 'brand new\n');
  fs.writeFileSync(path.join(t1, 'after.json'), JSON.stringify({ files: { [file]: sha('line one\nline TWO\n'), [created]: sha('brand new\n') } }));
  fs.writeFileSync(path.join(t2, 'turn.json'), JSON.stringify({ filesOffset: 2 }));
  fs.copyFileSync(file, snapshotKey(t2, file));
  fs.writeFileSync(file, 'line one\nline TWO\nline three\n');
  fs.writeFileSync(path.join(t2, 'after.json'), JSON.stringify({ files: { [file]: sha('line one\nline TWO\nline three\n') } }));
  const rec = (p: string, sha256?: string | null) => JSON.stringify({ path: path.relative(root, p), abs: p, root: 'code', tool: 'Write', ts: 't', ...(sha256 !== undefined ? { sha256 } : {}) });
  fs.writeFileSync(path.join(sessionDir, 'files.ndjson'), [rec(file), rec(created), rec(file)].join('\n') + '\n');
  const meta = { id: 's1', mode: 'devchat', turns: [{ n: 1 }, { n: 2 }] };
  const ctx = { codeRoot: root, dataRoot: root };
  return { root, sessionDir, t1, t2, file, created, meta, ctx, rec };
}

function refusal(fn: () => unknown): RevertRefused {
  try {
    fn();
  } catch (err) {
    if (err instanceof RevertRefused) return err;
    throw err;
  }
  throw new Error('expected the revert to be refused');
}

describe('Dev Chat change sets', () => {
  it('groups changed files by turn using the recorded offsets and diffs them against the per-turn snapshot', () => {
    const { sessionDir, file, created, meta } = fakeSession();
    const grouped = changesByTurn(sessionDir, meta);
    expect(grouped.map((g) => g.records.map((r) => r.abs))).toEqual([[file, created], [file]]);
    const turns = listChanges(sessionDir, meta);
    const t1 = turns[0]!.files;
    expect(t1.find((f) => f.abs === file)).toMatchObject({ status: 'modified', additions: 1, deletions: 1, canRevert: true });
    expect(t1.find((f) => f.abs === file)!.patch).toContain('-line two');
    expect(t1.find((f) => f.abs === file)!.patch).toContain('+line TWO');
    expect(t1.find((f) => f.abs === created)).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(turns[1]!.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(diffFile(path.join(sessionDir, 'turns', '2'), { path: 'x', abs: '/nowhere/x', root: 'code', tool: 'Write', ts: '' })).toMatchObject({ status: 'no-snapshot', canRevert: false });
  });

  it('reverts one file or a whole turn, deleting files the turn created', () => {
    const { root, sessionDir, t1, t2, file, created, meta, ctx } = fakeSession();
    expect(revertFile(t2, file, ctx)).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline TWO\n');
    const results = revertTurn(sessionDir, meta, 1, ctx);
    expect(results).toEqual([
      { abs: file, result: 'restored' },
      { abs: created, result: 'deleted' },
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline two\n');
    expect(fs.existsSync(created)).toBe(false);
    expect(revertFile(t1, path.join(root, 'custom', 'never-touched.md'), ctx)).toBe('no-snapshot');
    expect(revertTurn(sessionDir, meta, 9, ctx)).toEqual([]);
  });

  it('refuses (409) a file that changed after the turn, and a turn revert then writes nothing at all', () => {
    const { sessionDir, t1, t2, file, created, meta, ctx } = fakeSession();
    expect(revertFile(t2, file, ctx)).toBe('restored');
    fs.writeFileSync(created, 'brand new\nplus an edit the user made later\n');
    const one = refusal(() => revertFile(t1, created, ctx));
    expect(one.status).toBe(409);
    expect(one.message).toMatch(/custom\/new\.md changed after turn 1/);
    const whole = refusal(() => revertTurn(sessionDir, meta, 1, ctx));
    expect(whole.status).toBe(409);
    expect(whole.conflicts).toEqual(['custom/new.md']);
    // All or nothing: notes.md was revertible but stays at its post-turn bytes, and the user's edit survives.
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline TWO\n');
    expect(fs.readFileSync(created, 'utf8')).toContain('an edit the user made later');
    // Turn 1 cannot be reverted under turn 2 either: notes.md now holds turn 2's bytes.
    const fresh = fakeSession();
    expect(refusal(() => revertTurn(fresh.sessionDir, fresh.meta, 1, fresh.ctx)).conflicts).toEqual(['custom/notes.md']);
    expect(fs.readFileSync(fresh.file, 'utf8')).toBe('line one\nline TWO\nline three\n');
  });

  it('treats a file already back at its pre-turn bytes as unchanged instead of a conflict', () => {
    const { sessionDir, t1, t2, file, created, meta, ctx } = fakeSession();
    expect(revertFile(t2, file, ctx)).toBe('restored');
    expect(revertFile(t1, file, ctx)).toBe('restored');
    expect(revertTurn(sessionDir, meta, 1, ctx)).toEqual([
      { abs: file, result: 'unchanged' },
      { abs: created, result: 'deleted' },
    ]);
  });

  it('refuses (403) forged records outside the roots or outside the turn policy, and touches nothing', () => {
    const { root, sessionDir, t1, meta, ctx, rec } = fakeSession();
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-victim-')));
    const victim = path.join(outsideDir, '.zshrc');
    fs.writeFileSync(victim, 'precious\n');
    fs.writeFileSync(snapshotKey(t1, victim), 'attacker bytes\n');
    fs.mkdirSync(path.join(root, 'data'));
    const blacklist = path.join(root, 'data', 'blacklist.md');
    fs.writeFileSync(blacklist, '# real blacklist\n');
    fs.writeFileSync(`${snapshotKey(t1, blacklist)}.absent`, '');
    fs.appendFileSync(path.join(sessionDir, 'files.ndjson'), `${rec(victim)}\n${rec(blacklist)}\n`);
    const forged = { ...meta, turns: [{ n: 1 }] };
    const outside = refusal(() => revertFile(t1, victim, ctx));
    expect(outside.status).toBe(403);
    expect(outside.message).toMatch(/outside the code and data roots/);
    const scope = refusal(() => revertFile(t1, blacklist, ctx));
    expect(scope.status).toBe(403);
    expect(scope.message).toMatch(/turn 1's write scope/);
    expect(refusal(() => revertTurn(sessionDir, forged, 1, ctx)).status).toBe(403);
    expect(fs.readFileSync(victim, 'utf8')).toBe('precious\n');
    expect(fs.readFileSync(blacklist, 'utf8')).toBe('# real blacklist\n');
  });

  it('refuses (409) a turn without a post-turn record, since a later edit cannot be ruled out', () => {
    const { t1, file, created, ctx } = fakeSession();
    fs.rmSync(path.join(t1, 'after.json'));
    const r = refusal(() => revertFile(t1, created, ctx));
    expect(r.status).toBe(409);
    expect(r.message).toMatch(/no post-turn record/);
    expect(fs.existsSync(created)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline TWO\nline three\n');
  });

  it('post-turn hashes are the ones the hook took at each write (the last write wins), never the disk at finalize time', () => {
    const { root, sessionDir, rec, ctx } = fakeSession();
    const t3 = path.join(sessionDir, 'turns', '3');
    fs.mkdirSync(path.join(t3, 'before'), { recursive: true });
    fs.writeFileSync(path.join(t3, 'policy.json'), fs.readFileSync(path.join(sessionDir, 'turns', '1', 'policy.json')));
    const kept = path.join(root, 'custom', 'kept.md');
    const gone = path.join(root, 'custom', 'gone.md');
    const legacy = path.join(root, 'custom', 'legacy.md');
    fs.writeFileSync(`${snapshotKey(t3, kept)}.absent`, '');
    fs.appendFileSync(path.join(sessionDir, 'files.ndjson'), `${rec(kept, sha('first\n'))}\n${rec(gone, null)}\n${rec(kept, sha('turn bytes\n'))}\n${rec(legacy)}\n`);
    // The turn ended long ago; the user edited the file before the server finalized it.
    fs.writeFileSync(kept, 'the user edit made later\n');
    recordTurnAfter(sessionDir, 3, 3);
    expect(JSON.parse(fs.readFileSync(path.join(t3, 'after.json'), 'utf8')).files).toEqual({ [kept]: sha('turn bytes\n'), [gone]: null });
    const r = refusal(() => revertFile(t3, kept, ctx));
    expect(r.status).toBe(409);
    expect(fs.readFileSync(kept, 'utf8')).toBe('the user edit made later\n');
  });
});

describe('/__recovery revert requests', () => {
  it('require the app origin and the X-CC header, like the server', () => {
    expect(recoveryRequestAllowed({ origin: 'http://127.0.0.1:4317', 'x-cc': '1' }, 4317)).toBe(true);
    expect(recoveryRequestAllowed({ origin: 'http://localhost:4317', 'x-cc': '1' }, 4317)).toBe(true);
    expect(recoveryRequestAllowed({ origin: 'http://127.0.0.1:4387', 'x-cc': '1' }, 4317)).toBe(false);
    expect(recoveryRequestAllowed({ origin: 'http://127.0.0.1:4317' }, 4317)).toBe(false);
    expect(recoveryRequestAllowed({ 'x-cc': '1' }, 4317)).toBe(false);
    expect(recoveryRequestAllowed({ origin: 'null', 'x-cc': '1' }, 4317)).toBe(false);
  });

  it('refuse while the session is running, refuse unknown files, and report conflicts as 409', () => {
    const { sessionDir: guardSession, file, created, ctx } = fakeSession();
    const guardRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-root-')));
    const sessionsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-sessions-')));
    fs.mkdirSync(path.join(guardRoot, 'sessions'));
    fs.renameSync(guardSession, path.join(guardRoot, 'sessions', 's1'));
    const writeMeta = (status: string) => {
      fs.mkdirSync(path.join(sessionsDir, 's1'), { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 's1', 'meta.json'), JSON.stringify({ id: 's1', mode: 'devchat', status, createdAt: 't', turns: [{ n: 1 }, { n: 2 }] }));
    };
    const call = (turn: number, abs?: string) => recoveryRevert({ sessionsDir, guardRoot, ctx, sessionId: 's1', turn, abs });
    writeMeta('running');
    expect(call(2)).toMatchObject({ status: 409, text: expect.stringMatching(/running/) });
    writeMeta('queued');
    expect(call(2).status).toBe(409);
    writeMeta('done');
    expect(call(2, '/etc/hosts').status).toBe(404);
    expect(recoveryRevert({ sessionsDir, guardRoot, ctx, sessionId: 'nope', turn: 1 }).status).toBe(404);
    expect(call(1)).toMatchObject({ status: 409, text: expect.stringMatching(/custom\/notes\.md changed after turn 1/) });
    expect(call(2, file)).toMatchObject({ status: 200 });
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline TWO\n');
    expect(call(1)).toMatchObject({ status: 200 });
    expect(fs.existsSync(created)).toBe(false);
  });
});

describe('guard root (policy and revert bookkeeping outside every session write scope)', () => {
  it('defaults to a per-user state directory and honors CC_GUARD_DIR', () => {
    expect(defaultGuardRoot('/Users/x', 'darwin', {})).toBe('/Users/x/Library/Application Support/career-ops-control-center');
    expect(defaultGuardRoot('/home/x', 'linux', {})).toBe('/home/x/.local/state/career-ops-control-center');
    expect(defaultGuardRoot('/home/x', 'linux', { XDG_STATE_HOME: '/state' })).toBe('/state/career-ops-control-center');
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guard-root-')));
    const codeRoot = path.join(base, 'code');
    const dataRoot = path.join(base, 'data');
    fs.mkdirSync(codeRoot);
    fs.mkdirSync(dataRoot);
    const chosen = resolveGuardRoot({ env: { CC_GUARD_DIR: path.join(base, 'state', 'guard') }, codeRoot, dataRoot, home: base, platform: 'darwin' });
    expect(chosen).toBe(path.join(base, 'state', 'guard'));
    expect(fs.statSync(chosen).isDirectory()).toBe(true);
    expect(resolveGuardRoot({ env: {}, codeRoot, dataRoot, home: base, platform: 'darwin' })).toBe(path.join(base, 'Library', 'Application Support', 'career-ops-control-center'));
  });

  it('refuses a guard root inside the code or data root and creates nothing there; a differently cased root counts only where the volume folds case', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guard-root-')));
    const codeRoot = path.join(base, 'code');
    const dataRoot = path.join(base, 'data');
    fs.mkdirSync(codeRoot);
    fs.mkdirSync(dataRoot);
    const resolve = (dir: string) => resolveGuardRoot({ env: { CC_GUARD_DIR: dir }, codeRoot, dataRoot, home: base, platform: 'darwin' });
    expect(() => resolve(path.join(dataRoot, 'data', 'control-center', 'guard'))).toThrow(/inside the data root/);
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
    expect(() => resolve(path.join(codeRoot, 'custom', 'guard'))).toThrow(/inside the code root/);
    if (foldsCase(base)) {
      // base/DATA is the data root itself.
      expect(() => resolve(path.join(base, 'DATA', 'guard'))).toThrow(/inside the data root/);
    } else {
      // base/DATA is a separate folder next to the data root, so it is a valid guard root.
      expect(resolve(path.join(base, 'DATA', 'guard'))).toBe(path.join(base, 'DATA', 'guard'));
      expect(fs.statSync(path.join(base, 'DATA', 'guard')).isDirectory()).toBe(true);
      expect(fs.readdirSync(dataRoot)).toEqual([]);
    }
    expect(() => resolve(dataRoot)).toThrow(/inside the data root/);
  });
});

type FakeChild = ChildHandle & { drained: boolean; killed: boolean; activated: boolean; exit: () => void };

/** A child that exits when killed, or when the test calls exit() (it finished draining on its own). */
function handle(port: number, pid: number, log: string[] = []): FakeChild {
  let resolveExit!: () => void;
  const exited = new Promise<void>((r) => (resolveExit = r));
  const h: FakeChild = {
    port,
    pid,
    exited,
    drained: false,
    killed: false,
    activated: false,
    drain: () => undefined,
    kill: () => undefined,
    activate: () => undefined,
    exit: () => undefined,
    stderrTail: () => `stderr of ${pid}`,
  };
  h.exit = () => {
    log.push(`exit ${pid}`);
    resolveExit();
  };
  h.drain = () => {
    h.drained = true;
    log.push(`drain ${pid}`);
  };
  h.kill = () => {
    h.killed = true;
    h.exit();
  };
  h.activate = () => {
    h.activated = true;
    log.push(`activate ${pid}`);
  };
  return h;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('blue/green reload', () => {
  // A failing fake-timer test must not leave fake timers behind for the next one.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('swaps to the healthy new child and drains then kills the old one', async () => {
    vi.useFakeTimers();
    const first = handle(5001, 11);
    const second = handle(5002, 12);
    const bg = new BlueGreen(first, async () => second, async () => undefined, { drainMs: 100, now: () => 'T' });
    const seen: string[] = [];
    bg.onStatus((s) => seen.push(s.state));
    expect(await bg.reload()).toBe(true);
    expect(bg.active).toBe(second);
    expect(bg.status).toEqual({ state: 'ok', at: 'T', pid: 12 });
    expect(first.drained).toBe(true);
    expect(first.killed).toBe(false);
    expect(second.activated).toBe(false);
    vi.advanceTimersByTime(150);
    expect(first.killed).toBe(true);
    await flush();
    expect(second.activated).toBe(true);
    expect(seen).toEqual(['reloading', 'ok']);
    vi.useRealTimers();
  });

  it('the new child reconciles (activates) only after the old one stopped its trackers and exited', async () => {
    const log: string[] = [];
    const first = handle(5001, 11, log);
    const second = handle(5002, 12, log);
    const bg = new BlueGreen(first, async () => second, async () => undefined, { drainMs: 60_000 });
    expect(await bg.reload()).toBe(true);
    await flush();
    expect(log).toEqual(['drain 11']);
    first.exit();
    await flush();
    expect(log).toEqual(['drain 11', 'exit 11', 'activate 12']);
    expect(first.activated).toBe(false);
  });

  it('a second reload before the first handover finishes activates only the newest child, after both older ones exited', async () => {
    const log: string[] = [];
    const first = handle(5001, 11, log);
    const second = handle(5002, 12, log);
    const third = handle(5003, 13, log);
    const queue = [second, third];
    const bg = new BlueGreen(first, async () => queue.shift()!, async () => undefined, { drainMs: 60_000 });
    await bg.reload();
    await bg.reload();
    expect(bg.active).toBe(third);
    second.exit();
    await flush();
    expect(third.activated).toBe(false);
    first.exit();
    await flush();
    expect(log).toEqual(['drain 11', 'drain 12', 'exit 12', 'exit 11', 'activate 13']);
    expect(second.activated).toBe(false);
  });

  it('keeps the old child when the new one fails health and reports the stderr tail', async () => {
    const first = handle(5001, 11);
    const broken = handle(5003, 13);
    const bg = new BlueGreen(first, async () => broken, async () => { throw new Error('healthz did not return 200 in time'); }, { now: () => 'T' });
    expect(await bg.reload()).toBe(false);
    expect(bg.active).toBe(first);
    expect(bg.status).toEqual({ state: 'failed', at: 'T', error: 'healthz did not return 200 in time', stderrTail: 'stderr of 13' });
    expect(broken.killed).toBe(true);
    expect(first.drained).toBe(false);
    const bg2 = new BlueGreen(first, async () => { throw new Error('tsx crashed'); }, async () => undefined, { now: () => 'T' });
    expect(await bg2.reload()).toBe(false);
    expect(bg2.status).toMatchObject({ state: 'failed', error: 'tsx crashed' });
  });

  it('coalesces a burst of reload requests into one in-flight run plus one follow-up', async () => {
    let spawned = 0;
    const bg = new BlueGreen(handle(1, 1), async () => handle(2 + spawned, 2 + spawned++), async () => undefined, { drainMs: 1 });
    const results = await Promise.all([bg.reload(), bg.reload(), bg.reload()]);
    expect(results).toEqual([true, true, true]);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toBe(2);
  });
});
