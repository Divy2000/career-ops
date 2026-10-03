import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, sessionsDir } from '../../server/claude/sessions.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-'));
const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-guard-'));

describe('session store', () => {
  const store = new SessionStore(root, guardRoot);
  it('creates a session with meta.json under data/control-center/sessions and lists newest first', () => {
    const a = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://x.example/1' }, model: null });
    expect(fs.existsSync(path.join(sessionsDir(root), a.id, 'meta.json'))).toBe(true);
    expect(a).toMatchObject({ status: 'queued', turns: [], totals: { costUsd: 0, tokens: 0 }, filesChanged: [] });
    expect(a.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const b = store.create({ mode: 'advisor', policyClass: 'read-only', target: { type: 'none', value: null }, model: 'sonnet' });
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(store.read('nope')).toBeNull();
    expect(() => store.dirOf('../etc')).toThrow(/bad session id/);
  });
  it('appends turns, accumulates totals and moves through the status machine', () => {
    const s = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'app', value: '3' }, model: null });
    const t1 = store.beginTurn(s.id, { runId: 'r1', userText: 'Evaluate it' });
    expect(t1.turns).toHaveLength(1);
    expect(t1.status).toBe('running');
    expect(t1.turns[0]).toMatchObject({ n: 1, runId: 'r1', userText: 'Evaluate it', endedAt: null });
    const done = store.endTurn(s.id, 1, { costUsd: 0.5, tokens: 1200, permissionDenials: 1, status: 'awaiting_user' });
    expect(done.turns[0]).toMatchObject({ costUsd: 0.5, tokens: 1200, permissionDenials: 1 });
    expect(done.turns[0]!.endedAt).not.toBeNull();
    expect(done.totals).toEqual({ costUsd: 0.5, tokens: 1200 });
    expect(done.status).toBe('awaiting_user');
    const t2 = store.beginTurn(s.id, { runId: 'r2', userText: 'Yes, continue' });
    expect(t2.turns[1]!.n).toBe(2);
    const final = store.endTurn(s.id, 2, { costUsd: 0.25, tokens: 300, permissionDenials: 0, status: 'done' });
    expect(final.totals).toEqual({ costUsd: 0.75, tokens: 1500 });
    expect(() => store.endTurn(s.id, 9, { costUsd: 0, tokens: 0, permissionDenials: 0, status: 'done' })).toThrow(/no turn 9/);
  });
  it('records changed files once and marks cancelled or error states', () => {
    const s = store.create({ mode: 'pdf', policyClass: 'documents', target: { type: 'app', value: '1' }, model: null });
    store.addFilesChanged(s.id, ['output/a.html', 'output/a.pdf']);
    store.addFilesChanged(s.id, ['output/a.pdf']);
    expect(store.read(s.id)!.filesChanged).toEqual(['output/a.html', 'output/a.pdf']);
    expect(store.setStatus(s.id, 'cancelled').status).toBe('cancelled');
    expect(store.setStatus(s.id, 'error', 'claude exited 1').error).toBe('claude exited 1');
  });
  it('appends normalized events with increasing seq and replays after a seq', () => {
    const s = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
    expect(store.appendEvent(s.id, { type: 'text.delta', text: 'a' })).toBe(1);
    expect(store.appendEvent(s.id, { type: 'text.delta', text: 'b' })).toBe(2);
    expect(store.appendEvent(s.id, { type: 'turn.done', costUsd: 0, tokens: 0, numTurns: 1, isError: false })).toBe(3);
    const all = store.readEvents(s.id);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.readEvents(s.id, 2)).toHaveLength(1);
    expect(store.readEvents(s.id, 2)[0]!.event).toMatchObject({ type: 'turn.done' });
    expect(store.readEvents('missing-id')).toEqual([]);
  });
  it('forks a session into a new id that resumes the same Claude session uuid', () => {
    const s = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'url', value: 'https://x.example/2' }, model: null });
    const f = store.fork(s.id);
    expect(f.id).not.toBe(s.id);
    expect(f.claudeSessionId).toBe(s.claudeSessionId);
    expect(f.forkedFrom).toBe(s.id);
    expect(f.status).toBe('queued');
    expect(f.turns).toEqual([]);
  });
  it('a fork stays pending until the Claude id minted by --fork-session is stored, which happens once', () => {
    const s = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
    const f = store.fork(s.id);
    expect(f.forkPending).toBe(true);
    expect(s.forkPending ?? false).toBe(false);
    const minted = '22222222-2222-4222-8222-222222222222';
    expect(store.adoptForkedClaudeSessionId(f.id, minted)).toBe(true);
    expect(store.read(f.id)).toMatchObject({ claudeSessionId: minted, forkPending: false });
    expect(store.adoptForkedClaudeSessionId(f.id, '33333333-3333-4333-8333-333333333333')).toBe(false);
    expect(store.read(f.id)!.claudeSessionId).toBe(minted);
    expect(store.read(s.id)!.claudeSessionId).toBe(s.claudeSessionId);
  });
  it('endTurn is idempotent: a second call never adds the cost again, moves endedAt or changes the outcome', () => {
    const s = store.create({ mode: 'oferta', policyClass: 'evaluate', target: { type: 'none', value: null }, model: null });
    store.beginTurn(s.id, { runId: 'r1', userText: 'go' });
    const first = store.endTurn(s.id, 1, { costUsd: 0.4, tokens: 100, permissionDenials: 0, status: 'done', reason: 'first' });
    const second = store.endTurn(s.id, 1, { costUsd: 0.4, tokens: 100, permissionDenials: 0, status: 'error', reason: 'second' });
    expect(second.totals).toEqual({ costUsd: 0.4, tokens: 100 });
    expect(second.turns[0]!.endedAt).toBe(first.turns[0]!.endedAt);
    expect(store.read(s.id)).toMatchObject({ status: 'done', lastReason: 'first', totals: { costUsd: 0.4, tokens: 100 } });
  });
});
