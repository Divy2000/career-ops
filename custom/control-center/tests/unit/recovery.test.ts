import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { changesByTurn, devChatChangeInEffect, diffFile, listChanges, MAX_DIFF_BYTES, recordTurnAfter, recoveryRequestAllowed, recoveryRevert, revertFile, revertTurn, RevertRefused, snapshotKey } from '../../supervisor/recovery.js';
import { plainTail, renderDownPage, renderStatus, stripAnsi } from '../../supervisor/down-page.js';
import { BlueGreen, type ChildHandle } from '../../supervisor/bluegreen.js';
import { defaultGuardRoot, resolveGuardRoot } from '../../supervisor/guard-root.js';
import { foldsCase } from '../helpers/case.js';
import { tempDir } from '../helpers/tmp.js';

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * A finished two-turn Dev Chat change set as the app records it: per-turn
 * policy and post-turn hashes under the guard dir, which sits outside the root.
 */
function fakeSession() {
  const root = fs.realpathSync(tempDir('cc-recovery-'));
  const sessionDir = fs.realpathSync(tempDir('cc-recovery-guard-'));
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
    const outsideDir = fs.realpathSync(tempDir('cc-recovery-victim-'));
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

describe('diffs stay bounded, so /__recovery and the Changes panel never freeze the supervisor or the API', () => {
  /** A turn that replaced `before` with `after` in custom/big.txt, as the hook records it. */
  function turnOf(before: Buffer | string, after: Buffer | string) {
    const root = fs.realpathSync(tempDir('cc-recovery-big-'));
    const turnDir = path.join(fs.realpathSync(tempDir('cc-recovery-big-guard-')), 'turns', '1');
    const abs = path.join(root, 'custom', 'big.txt');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.mkdirSync(path.join(turnDir, 'before'), { recursive: true });
    fs.writeFileSync(snapshotKey(turnDir, abs), before);
    fs.writeFileSync(abs, after);
    return diffFile(turnDir, { path: 'custom/big.txt', abs, root: 'code', tool: 'Write', ts: '' });
  }
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${'x'.repeat(40)}`).join('\n') + '\n';

  it('a file larger than the cap is summarized, with line counts and the revert still offered', () => {
    const before = lines(Math.ceil(MAX_DIFF_BYTES / 50) + 100, 'old');
    expect(Buffer.byteLength(before)).toBeGreaterThan(MAX_DIFF_BYTES);
    const after = before.replace('old line 7 ', 'new line 7 ').replace('old line 9 ', 'new line 9 ') + 'appended\n';
    const d = turnOf(before, after);
    expect(d).toMatchObject({ status: 'modified', additions: 3, deletions: 2, canRevert: true });
    expect(d.patch).not.toContain('@@');
    expect(d.patch).toMatch(/larger than/);
  });

  it('a binary file is never diffed as text', () => {
    const d = turnOf(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x0a]), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x09, 0x0a]));
    expect(d).toMatchObject({ status: 'modified', additions: 0, deletions: 0, canRevert: true });
    expect(d.patch).toMatch(/binary/i);
    expect(turnOf(Buffer.from([0xff, 0xfe, 0x41]), Buffer.from([0xff, 0xfe, 0x42])).patch).toMatch(/binary/i);
    expect(turnOf(Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x01])).status).toBe('unchanged');
  });

  it('a rewrite too far apart to diff quickly gets the summary and line counts instead of a patch', () => {
    const d = turnOf(lines(3000, 'old'), lines(3000, 'new'));
    expect(d).toMatchObject({ status: 'modified', additions: 3000, deletions: 3000, canRevert: true });
    expect(d.patch).not.toContain('@@');
    expect(d.patch).toMatch(/too many changes/i);
  });

  it('small text edits still get a unified patch', () => {
    const d = turnOf('a\nb\nc\n', 'a\nB\nc\n');
    expect(d).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(d.patch).toContain('-b');
    expect(d.patch).toContain('+B');
  });
});

describe('reverts check the turn\'s own recorded scope, in either root (SW2-claude-02 review)', () => {
  it('a turn recorded before the split, which wrote a user file into the code checkout, can still be reverted', () => {
    const code = fs.realpathSync(tempDir('cc-revert-split-code-'));
    const data = fs.realpathSync(tempDir('cc-revert-split-data-'));
    const sessionDir = fs.realpathSync(tempDir('cc-revert-split-guard-'));
    const turnDir = path.join(sessionDir, 'turns', '1');
    fs.mkdirSync(path.join(turnDir, 'before'), { recursive: true });
    // Dev Chat's recorded scope; under the old bug its data/** write landed in the code root.
    fs.writeFileSync(path.join(turnDir, 'policy.json'), JSON.stringify({ codeRoot: code, dataRoot: data, allow: ['data/**', 'custom/**'], deny: ['data/blacklist.md'] }));
    const created = path.join(code, 'data', 'notes', 'x.md');
    const edited = path.join(code, 'custom', 'notes.md');
    fs.mkdirSync(path.dirname(created), { recursive: true });
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.writeFileSync(edited, 'before\n');
    fs.copyFileSync(edited, snapshotKey(turnDir, edited));
    fs.writeFileSync(`${snapshotKey(turnDir, created)}.absent`, '');
    fs.writeFileSync(created, 'misplaced\n');
    fs.writeFileSync(edited, 'after\n');
    fs.writeFileSync(path.join(turnDir, 'after.json'), JSON.stringify({ files: { [created]: sha('misplaced\n'), [edited]: sha('after\n') } }));
    const ctx = { codeRoot: code, dataRoot: data };
    expect(revertFile(turnDir, created, ctx)).toBe('deleted');
    expect(fs.existsSync(created)).toBe(false);
    expect(revertFile(turnDir, edited, ctx)).toBe('restored');
    expect(fs.readFileSync(edited, 'utf8')).toBe('before\n');
    // Outside the recorded scope stays refused.
    const other = path.join(code, 'modes', '_custom.md');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(`${snapshotKey(turnDir, other)}.absent`, '');
    expect(refusal(() => revertFile(turnDir, other, ctx)).status).toBe(403);
  });
});

describe('change sets the disk no longer matches', () => {
  it('lists a recorded file that became a directory as unreadable, with no revert, and still diffs the other files', () => {
    const { sessionDir, created, meta, file } = fakeSession();
    fs.rmSync(created);
    fs.mkdirSync(created);
    const [turn1] = listChanges(sessionDir, meta);
    const dir = turn1!.files.find((f) => f.abs === created)!;
    expect(dir).toMatchObject({ status: 'unreadable', canRevert: false, patch: '' });
    expect(dir.error).toMatch(/EISDIR/);
    expect(turn1!.files.find((f) => f.abs === file)!.status).toBe('modified');
  });

  it('reads a session meta without a turns list as having no turns', () => {
    const { sessionDir } = fakeSession();
    const meta = { id: 's1', mode: 'devchat' } as unknown as Parameters<typeof listChanges>[1];
    expect(changesByTurn(sessionDir, meta)).toEqual([]);
    expect(listChanges(sessionDir, meta)).toEqual([]);
  });

  it('answers a revert that fails for a reason other than a refusal with a 500 naming it, instead of throwing', () => {
    const { sessionDir: guardSession, t1, ctx } = fakeSession();
    const guardRoot = fs.realpathSync(tempDir('cc-recovery-root-'));
    const sessionsDir = fs.realpathSync(tempDir('cc-recovery-sessions-'));
    fs.mkdirSync(path.join(guardRoot, 'sessions'));
    fs.writeFileSync(path.join(t1, 'policy.json'), '{ torn');
    fs.renameSync(guardSession, path.join(guardRoot, 'sessions', 's1'));
    fs.mkdirSync(path.join(sessionsDir, 's1'));
    fs.writeFileSync(path.join(sessionsDir, 's1', 'meta.json'), JSON.stringify({ id: 's1', mode: 'devchat', status: 'done', createdAt: 't', turns: [{ n: 1 }, { n: 2 }] }));
    expect(recoveryRevert({ sessionsDir, guardRoot, ctx, sessionId: 's1', turn: 1 })).toMatchObject({ status: 500, text: expect.stringMatching(/revert failed: .*JSON/) });
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
    const guardRoot = fs.realpathSync(tempDir('cc-recovery-root-'));
    const sessionsDir = fs.realpathSync(tempDir('cc-recovery-sessions-'));
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

describe('the page a down server answers with (SW2-claude-05 review)', () => {
  /** A sessions dir and guard root holding one session of `mode` whose turn 1 recorded `files`. */
  function recorded(mode: string, files: string[]) {
    const sessionsDir = tempDir('cc-down-sessions-');
    const guardRoot = tempDir('cc-down-guard-');
    const id = 's20261005000000-abcdef';
    fs.mkdirSync(path.join(sessionsDir, id));
    fs.writeFileSync(path.join(sessionsDir, id, 'meta.json'), JSON.stringify({ id, mode, status: 'done', createdAt: '2026-10-05T00:00:00.000Z', turns: [{ n: 1 }] }));
    const sessionDir = path.join(guardRoot, 'sessions', id);
    fs.mkdirSync(path.join(sessionDir, 'turns', '1'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'turns', '1', 'turn.json'), JSON.stringify({ filesOffset: 0 }));
    if (files.length) fs.writeFileSync(path.join(sessionDir, 'files.ndjson'), files.map((f) => `${JSON.stringify({ path: f, abs: `/nowhere/${f}`, root: 'code', tool: 'Write', ts: 't' })}\n`).join(''));
    return { sessionsDir, guardRoot };
  }
  const serverTree = (rel: string) => rel.startsWith('custom/control-center/server/');
  const failed = { state: 'failed' as const, at: 't', error: 'server child exited before listening (code 1, signal null)\nError: listen EADDRINUSE <127.0.0.1>', stderrTail: 'Error: listen EADDRINUSE <127.0.0.1>' };

  /**
   * A finished Dev Chat turn that edited `rels` in a scratch code root, recorded the way the guard hook and finalize record
   * it: under `recordedUnder` (another spelling of the code root, or a separate data root) and labelled `label` if given.
   */
  function finishedTurn(rels: string[], opts: { finalized?: boolean; recordedUnder?: (root: string) => string; label?: 'code' | 'data' } = {}) {
    const root = fs.realpathSync(tempDir('cc-down-root-'));
    const base = opts.recordedUnder?.(root) ?? root;
    const sessionsDir = tempDir('cc-down-sessions-');
    const guardRoot = tempDir('cc-down-guard-');
    const id = 's20261005000001-abcdef';
    const meta = { id, mode: 'devchat', status: 'done', createdAt: '2026-10-05T00:00:00.000Z', turns: [{ n: 1 }] };
    fs.mkdirSync(path.join(sessionsDir, id));
    fs.writeFileSync(path.join(sessionsDir, id, 'meta.json'), JSON.stringify(meta));
    const sessionDir = path.join(guardRoot, 'sessions', id);
    const turnDir = path.join(sessionDir, 'turns', '1');
    fs.mkdirSync(path.join(turnDir, 'before'), { recursive: true });
    fs.writeFileSync(path.join(turnDir, 'turn.json'), JSON.stringify({ filesOffset: 0 }));
    fs.writeFileSync(path.join(turnDir, 'policy.json'), JSON.stringify({ codeRoot: root, dataRoot: root, sessionDir, allow: ['**'], deny: [], bash: [], playwright: false }));
    const after: Record<string, string> = {};
    const lines: string[] = [];
    for (const rel of rels) {
      const abs = path.join(base, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'before\n');
      fs.copyFileSync(abs, snapshotKey(turnDir, abs));
      fs.writeFileSync(abs, 'after the turn\n');
      after[abs] = sha('after the turn\n');
      lines.push(JSON.stringify({ path: rel, abs, root: opts.label ?? 'code', tool: 'Edit', ts: 't', sha256: after[abs] }));
    }
    fs.writeFileSync(path.join(sessionDir, 'files.ndjson'), lines.map((l) => `${l}\n`).join(''));
    if (opts.finalized !== false) fs.writeFileSync(path.join(turnDir, 'after.json'), JSON.stringify({ files: after }));
    return { root, sessionsDir, guardRoot, sessionDir, meta };
  }

  it('counts a change only when a Dev Chat turn recorded one', () => {
    const codeRoot = tempDir('cc-down-code-');
    expect(devChatChangeInEffect(path.join(tempDir('cc-down-none-'), 'missing'), tempDir('cc-down-guard-'), serverTree, codeRoot)).toBe(false);
    const none = recorded('devchat', []);
    expect(devChatChangeInEffect(none.sessionsDir, none.guardRoot, serverTree, codeRoot)).toBe(false);
    const evaluation = recorded('oferta', ['custom/control-center/server/app.ts']);
    expect(devChatChangeInEffect(evaluation.sessionsDir, evaluation.guardRoot, serverTree, codeRoot)).toBe(false);
    const t = finishedTurn(['custom/control-center/server/app.ts']);
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(true);
  });

  it('a reverted turn is no longer blamed: the page falls back to the neutral wording (SW2-claude-05 review)', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts', 'cv.md']);
    revertTurn(t.sessionDir, t.meta, 1, { codeRoot: t.root, dataRoot: t.root });
    expect(fs.readFileSync(path.join(t.root, 'custom/control-center/server/app.ts'), 'utf8')).toBe('before\n');
    const changed = devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root);
    expect(changed).toBe(false);
    expect(renderDownPage(failed, { devChatChanged: changed })).not.toMatch(/Dev Chat/);
  });

  it('a turn that changed only files the server never loads (cv.md, web/) is not blamed (SW2-claude-05 review)', () => {
    const t = finishedTurn(['cv.md', 'custom/control-center/web/src/main.tsx']);
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(false);
  });

  it('a server/ edit recorded as a data-root write, because the data root is the code root under another spelling, is still blamed (SW2-claude-05 review)', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts'], {
      recordedUnder: (root) => {
        const link = path.join(tempDir('cc-down-link-'), 'root');
        fs.symlinkSync(root, link);
        return link;
      },
      label: 'data',
    });
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(true);
  });

  it('a write in a separate data root is never the server\'s, whatever its relative path looks like', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts'], { recordedUnder: () => fs.realpathSync(tempDir('cc-down-data-')), label: 'data' });
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(false);
  });

  /** Appends a turn-1 record for `rel` (made unresolvable by `prepare`) to a finished turn's change log. */
  const unresolvableRecord = (t: ReturnType<typeof finishedTurn>, rel: string, prepare: (abs: string) => void) => {
    const abs = path.join(t.root, rel);
    prepare(abs);
    fs.appendFileSync(path.join(t.sessionDir, 'files.ndjson'), `${JSON.stringify({ path: rel, abs, root: 'code', tool: 'Write', ts: 't', sha256: null })}\n`);
  };

  it('a record whose path loops through links (ELOOP) cannot be ruled out, so it counts, and the check answers instead of throwing', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts']);
    revertTurn(t.sessionDir, t.meta, 1, { codeRoot: t.root, dataRoot: t.root });
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(false);
    unresolvableRecord(t, 'custom/control-center/server/loop/app.ts', (abs) => {
      fs.symlinkSync('loop', path.dirname(abs));
      expect(() => fs.realpathSync(path.dirname(abs))).toThrow(/ELOOP/);
    });
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(true);
  });

  it('a record under a directory that cannot be read (EACCES) cannot be ruled out either, so it counts', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts']);
    revertTurn(t.sessionDir, t.meta, 1, { codeRoot: t.root, dataRoot: t.root });
    const locked = path.join(t.root, 'custom', 'control-center', 'server', 'locked');
    unresolvableRecord(t, 'custom/control-center/server/locked/inner/app.ts', () => {
      fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
      fs.chmodSync(locked, 0o000);
    });
    try {
      expect(() => fs.lstatSync(path.join(locked, 'inner'))).toThrow(/EACCES/);
      expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it('a turn that never finished (no post-turn record) cannot be ruled out, so it is still blamed', () => {
    const t = finishedTurn(['custom/control-center/server/app.ts'], { finalized: false });
    expect(devChatChangeInEffect(t.sessionsDir, t.guardRoot, serverTree, t.root)).toBe(true);
  });

  it('a stderr tail longer than its limit, cut inside an escape sequence that also spans two chunks, keeps no fragment of it', () => {
    const E = '\u001b';
    const head = 'Error: listen EADDRINUSE\n';
    const rest = 'y'.repeat(3997);
    // The raw tail is longer than 4000 and its last 4000 characters start right after "ESC[", on "90m".
    const tail = plainTail(4000);
    tail.push(`${head}${E}[9`);
    tail.push(`0m${rest}`);
    expect(`${head}${E}[90m${rest}`.slice(-4000).startsWith('90m')).toBe(true);
    expect(tail.text()).toBe(`${head}${rest}`.slice(-4000));
    expect(tail.text()).not.toContain('90m');
    expect(tail.text()).not.toContain(E);
  });

  it('a stderr tail strips escapes split anywhere across chunks, an unfinished one at the end shows nothing, and the limit counts plain text', () => {
    const E = '\u001b';
    const tail = plainTail(10);
    for (const chunk of [`ab${E}`, '[3', '2mcd', `${E}]8;;https://x.example`, `/y${E}`, '\\ef', `${E}[1`]) tail.push(chunk);
    expect(tail.text()).toBe('abcdef');
    tail.push(';31mghijklmnop');
    expect(tail.text()).toBe('ghijklmnop');
  });

  it('a stderr tail does not hold back forever a sequence that never ends: past 1 KB it shows as text, without the escape', () => {
    const tail = plainTail(4000);
    tail.push(`before \u001b]${'z'.repeat(2000)}`);
    expect(tail.text()).toBe(`before ${'z'.repeat(2000)}`);
    tail.push(' after');
    expect(tail.text().endsWith('z after')).toBe(true);
  });

  it('the recovery page\'s status block says what the last start or reload did in words, with a failure\'s error as escaped text', () => {
    expect(renderStatus({ state: 'idle' })).toBe('<p>No reload since the server started.</p>');
    expect(renderStatus({ state: 'reloading', startedAt: '2026-10-06T05:00:00.000Z' })).toBe('<p>A reload is under way (started 2026-10-06T05:00:00.000Z).</p>');
    expect(renderStatus({ state: 'ok', at: '2026-10-06T05:00:01.000Z', pid: 4242 })).toBe('<p>The last reload came up at 2026-10-06T05:00:01.000Z (pid 4242).</p>');
    expect(renderStatus({ ...failed, at: '2026-10-06T05:00:02.000Z' })).toBe(
      '<p>The last start failed at 2026-10-06T05:00:02.000Z.</p><pre>server child exited before listening (code 1, signal null)\nError: listen EADDRINUSE &lt;127.0.0.1&gt;</pre>',
    );
    expect(renderStatus({ state: 'failed', at: 't', error: 'healthz did not return 200 in time', stderrTail: 'warning: slow disk' })).toContain('<pre>healthz did not return 200 in time\nwarning: slow disk</pre>');
  });

  it('strips terminal escape sequences (colours, a hyperlink, a two-byte escape) and keeps the text and its line breaks', () => {
    const E = '\u001b';
    const coloured = `${E}[90m    at listenInCluster (node:net:2224:12)${E}[39m\n  code: ${E}[32m'EADDRINUSE'${E}[39m, ${E}[1;31mbold red${E}[0m`;
    expect(stripAnsi(coloured)).toBe("    at listenInCluster (node:net:2224:12)\n  code: 'EADDRINUSE', bold red");
    expect(stripAnsi(`see ${E}]8;;https://example.com${E}\\the docs${E}]8;;${E}\\ and ${E}]0;title\u0007done`)).toBe('see the docs and done');
    expect(stripAnsi(`${E}Mline${E}7 ${E}(Bend`)).toBe('line end');
    expect(stripAnsi('plain [90m text')).toBe('plain [90m text');
  });

  it('without a Dev Chat change, a signed-in viewer sees the startup error (escaped, once) and no blame on a change', () => {
    const html = renderDownPage(failed, { devChatChanged: false });
    expect(html).toContain('server child exited before listening (code 1, signal null)');
    expect(html).toContain('EADDRINUSE &lt;127.0.0.1&gt;');
    expect(html).not.toContain('<127.0.0.1>');
    expect(html.match(/EADDRINUSE/g)).toHaveLength(1);
    expect(html).not.toMatch(/last change|Dev Chat/i);
    expect(html).toMatch(/restart/i);
    expect(html).toContain('href="/__recovery"');
  });

  it('a stderr tail the error does not already carry is shown after it', () => {
    const html = renderDownPage({ ...failed, error: 'healthz did not return 200 in time', stderrTail: 'warning: slow disk' }, { devChatChanged: false });
    expect(html).toMatch(/healthz did not return 200 in time\nwarning: slow disk/);
  });

  it('with a Dev Chat change recorded, it points at reverting that turn and still shows the error', () => {
    const html = renderDownPage(failed, { devChatChanged: true });
    expect(html).toMatch(/Dev Chat turn/);
    expect(html).toContain('server child exited before listening');
    expect(html).toContain('href="/__recovery"');
  });

  it('a viewer who is not signed in gets the recovery link but neither the error nor whether Dev Chat changed anything', () => {
    const html = renderDownPage(failed, null);
    expect(html).toContain('href="/__recovery"');
    expect(html).not.toMatch(/EADDRINUSE|exited before listening|Dev Chat/);
  });

  it('while a restart is starting the server, it says so instead of showing an error', () => {
    const html = renderDownPage({ state: 'reloading', startedAt: 't' }, { devChatChanged: true });
    expect(html).toMatch(/starting/);
    expect(html).not.toMatch(/Dev Chat|could not start/);
  });
});

describe('guard root (policy and revert bookkeeping outside every session write scope)', () => {
  it('defaults to a per-user state directory and honors CC_GUARD_DIR', () => {
    expect(defaultGuardRoot('/Users/x', 'darwin', {})).toBe('/Users/x/Library/Application Support/career-ops-control-center');
    expect(defaultGuardRoot('/home/x', 'linux', {})).toBe('/home/x/.local/state/career-ops-control-center');
    expect(defaultGuardRoot('/home/x', 'linux', { XDG_STATE_HOME: '/state' })).toBe('/state/career-ops-control-center');
    const base = fs.realpathSync(tempDir('cc-guard-root-'));
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
    const base = fs.realpathSync(tempDir('cc-guard-root-'));
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
    expect((await bg.reload()).state).toBe('ok');
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

  it('with no server child running (the first one could not start), a reload that comes up is active and activated at once (SW2-claude-05)', async () => {
    const log: string[] = [];
    const fixed = handle(5003, 13, log);
    let attempt = 0;
    const bg = new BlueGreen(null, async () => {
      attempt++;
      if (attempt === 1) throw new Error('server child exited before listening (code 1)');
      return fixed;
    }, async () => undefined, { now: () => 'T' });
    expect(bg.active).toBeNull();
    expect((await bg.reload()).state).toBe('failed');
    expect(bg.active).toBeNull();
    expect(bg.status).toMatchObject({ state: 'failed' });
    expect((await bg.reload()).state).toBe('ok');
    expect(bg.active).toBe(fixed);
    await flush();
    expect(log).toEqual(['activate 13']);
  });

  it('the new child reconciles (activates) only after the old one stopped its trackers and exited', async () => {
    const log: string[] = [];
    const first = handle(5001, 11, log);
    const second = handle(5002, 12, log);
    const bg = new BlueGreen(first, async () => second, async () => undefined, { drainMs: 60_000 });
    expect((await bg.reload()).state).toBe('ok');
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
    expect((await bg.reload()).state).toBe('failed');
    expect(bg.active).toBe(first);
    expect(bg.status).toEqual({ state: 'failed', at: 'T', error: 'healthz did not return 200 in time', stderrTail: 'stderr of 13' });
    expect(broken.killed).toBe(true);
    expect(first.drained).toBe(false);
    const bg2 = new BlueGreen(first, async () => { throw new Error('tsx crashed'); }, async () => undefined, { now: () => 'T' });
    expect((await bg2.reload()).state).toBe('failed');
    expect(bg2.status).toMatchObject({ state: 'failed', error: 'tsx crashed' });
  });

  it('a reload asked for while one is under way answers with the follow-up run\'s own result, not the earlier run\'s (SW2-claude-05 review)', async () => {
    // The watcher's reload fails; a restart asked for meanwhile runs after it, from the fixed code, and comes up.
    const fixed = handle(5004, 14);
    const outcomes: Array<() => Promise<ChildHandle>> = [];
    let fail!: () => void;
    outcomes.push(() => new Promise((_, reject) => (fail = () => reject(new Error('server child exited before listening (code 1)')))));
    outcomes.push(async () => fixed);
    const bg = new BlueGreen(null, () => outcomes.shift()!(), async () => undefined, { now: () => 'T' });
    const watcher = bg.reload();
    const restart = bg.reload();
    fail();
    expect(await watcher).toMatchObject({ state: 'failed', error: 'server child exited before listening (code 1)' });
    expect(await restart).toEqual({ state: 'ok', at: 'T', pid: 14 });
    expect(bg.active).toBe(fixed);
  });

  it('a follow-up run that fails answers its own error even when the run before it came up (SW2-claude-05 review)', async () => {
    const first = handle(5001, 11);
    const second = handle(5002, 12);
    const outcomes: Array<() => Promise<ChildHandle>> = [async () => second, async () => { throw new Error('tsx crashed'); }];
    const bg = new BlueGreen(first, () => outcomes.shift()!(), async () => undefined, { now: () => 'T', drainMs: 1 });
    const [a, b] = await Promise.all([bg.reload(), bg.reload()]);
    expect(a).toEqual({ state: 'ok', at: 'T', pid: 12 });
    expect(b).toMatchObject({ state: 'failed', error: 'tsx crashed' });
    expect(bg.active).toBe(second);
  });

  it('coalesces a burst of reload requests into one in-flight run plus one follow-up', async () => {
    let spawned = 0;
    const bg = new BlueGreen(handle(1, 1), async () => handle(2 + spawned, 2 + spawned++), async () => undefined, { drainMs: 1 });
    const results = await Promise.all([bg.reload(), bg.reload(), bg.reload()]);
    expect(results.map((r) => r.state)).toEqual(['ok', 'ok', 'ok']);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawned).toBe(2);
  });
});
