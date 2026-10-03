import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changesByTurn, diffFile, listChanges, revertFile, revertTurn, snapshotKey } from '../../supervisor/recovery.js';
import { BlueGreen, type ChildHandle } from '../../supervisor/bluegreen.js';

function fakeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-recovery-'));
  const sessionDir = path.join(root, 'session');
  const file = path.join(root, 'custom', 'notes.md');
  const created = path.join(root, 'custom', 'new.md');
  fs.mkdirSync(path.join(root, 'custom'), { recursive: true });
  fs.writeFileSync(file, 'line one\nline two\n');
  // Turn 1: edit notes.md and create new.md; turn 2: edit notes.md again.
  const t1 = path.join(sessionDir, 'turns', '1');
  const t2 = path.join(sessionDir, 'turns', '2');
  fs.mkdirSync(path.join(t1, 'before'), { recursive: true });
  fs.mkdirSync(path.join(t2, 'before'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'turn.json'), JSON.stringify({ filesOffset: 0 }));
  fs.copyFileSync(file, snapshotKey(t1, file));
  fs.writeFileSync(`${snapshotKey(t1, created)}.absent`, '');
  fs.writeFileSync(file, 'line one\nline TWO\n');
  fs.writeFileSync(created, 'brand new\n');
  fs.writeFileSync(path.join(t2, 'turn.json'), JSON.stringify({ filesOffset: 2 }));
  fs.copyFileSync(file, snapshotKey(t2, file));
  fs.writeFileSync(file, 'line one\nline TWO\nline three\n');
  const rec = (p: string) => JSON.stringify({ path: path.relative(root, p), abs: p, root: 'code', tool: 'Write', ts: 't' });
  fs.writeFileSync(path.join(sessionDir, 'files.ndjson'), [rec(file), rec(created), rec(file)].join('\n') + '\n');
  const meta = { id: 's1', mode: 'devchat', turns: [{ n: 1 }, { n: 2 }] };
  return { root, sessionDir, file, created, meta };
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
    const { sessionDir, file, created, meta } = fakeSession();
    expect(revertFile(path.join(sessionDir, 'turns', '2'), file)).toBe('restored');
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline TWO\n');
    const results = revertTurn(sessionDir, meta, 1);
    expect(results).toEqual([
      { abs: file, result: 'restored' },
      { abs: created, result: 'deleted' },
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe('line one\nline two\n');
    expect(fs.existsSync(created)).toBe(false);
    expect(revertFile(path.join(sessionDir, 'turns', '1'), '/nowhere/x')).toBe('no-snapshot');
    expect(revertTurn(sessionDir, meta, 9)).toEqual([]);
  });
});

function handle(port: number, pid: number): ChildHandle & { drained: boolean; killed: boolean } {
  const h = { port, pid, drained: false, killed: false, drain: () => undefined, kill: () => undefined, stderrTail: () => `stderr of ${pid}` };
  h.drain = () => {
    h.drained = true;
  };
  h.kill = () => {
    h.killed = true;
  };
  return h;
}

describe('blue/green reload', () => {
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
    vi.advanceTimersByTime(150);
    expect(first.killed).toBe(true);
    expect(seen).toEqual(['reloading', 'ok']);
    vi.useRealTimers();
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
