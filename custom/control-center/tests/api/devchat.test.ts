import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { getModePolicy } from '../../server/claude/modes.js';
import { buildArgv } from '../../server/claude/invocation.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: Record<string, unknown> = {}) => t.app.inject({ method: 'POST', url, headers: t.authedWrite, payload });
const get = (url: string) => t.app.inject({ method: 'GET', url, headers: t.authed });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(id: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = (await get(`/api/sessions/${id}`)).json();
    if (['done', 'awaiting_user', 'error', 'cancelled'].includes(body.meta.status)) return body;
    if (Date.now() > deadline) throw new Error('session did not settle');
    await wait(100);
  }
}

describe('Dev Chat', () => {
  it('policy: user layer and custom/** writable, supervisor and node_modules denied, read-only git allowed', () => {
    const p = getModePolicy('devchat')!;
    expect(p.policyClass).toBe('devchat');
    expect(p.writeGlobs).toEqual(expect.arrayContaining(['custom/**', 'data/**', 'modes/_custom.md']));
    expect(p.bashPrefixes).toEqual(expect.arrayContaining([['git', 'status'], ['npm', '--prefix', 'custom/control-center', 'run', 'test']]));
    const argv = buildArgv({ claudeBin: 'claude', codeRoot: '/r', dataRoot: '/r', sessionDir: '/s', policyFile: '/s/p.json', settingsFile: '/s/s.json', policy: p, userMessage: 'x', claudeSessionId: 'u', resume: false, preamble: 'P' });
    expect(argv[argv.indexOf('--allowedTools') + 1]).toContain('Bash(git status:*)');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toContain('Edit(//r/custom/**)');
  });

  it('a Dev Chat turn writes inside its scope, is blocked on the blacklist and the supervisor, and the change set lists diffs per turn', async () => {
    const start = await post('/api/sessions', { mode: 'devchat', prompt: 'Add a rule to the house rules and leave a note' });
    expect(start.statusCode).toBe(202);
    const { id } = start.json();
    const first = await settle(id);
    expect(first.meta.status).toBe('done');
    const denied = first.events.filter((e: { event: { type: string } }) => e.event.type === 'permission.denied').map((e: { event: { tool: string; input: { file_path?: string; command?: string } } }) => e.event.input.file_path ?? e.event.input.command);
    expect(denied).toHaveLength(3);
    expect(denied.some((d: string) => d.endsWith('data/blacklist.md'))).toBe(true);
    expect(denied.some((d: string) => d.endsWith('supervisor/index.ts'))).toBe(true);
    expect(denied).toContain('git push origin main');
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'blacklist.md'), 'utf8')).not.toContain('Dev Chat');
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'modes', '_custom.md'), 'utf8')).toContain('Added by Dev Chat');
    const gitStatus = first.events.filter((e: { event: { type: string; ok?: boolean; summary?: string } }) => e.event.type === 'tool.result').map((e: { event: { ok: boolean; summary: string } }) => e.event);
    expect(gitStatus.some((r: { ok: boolean; summary: string }) => r.ok && r.summary.startsWith('exit 0'))).toBe(true);

    await post(`/api/sessions/${id}/turns`, { prompt: 'Rewrite the note' });
    await settle(id);
    const changes = (await get(`/api/dev/changes/${id}`)).json();
    expect(changes.turns).toHaveLength(2);
    const t1 = changes.turns[0].files;
    expect(t1.map((f: { path: string }) => f.path).sort()).toEqual(['data/notes/devchat.md', 'modes/_custom.md']);
    expect(t1.find((f: { path: string }) => f.path === 'modes/_custom.md')).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(t1.find((f: { path: string }) => f.path === 'data/notes/devchat.md')).toMatchObject({ status: 'added' });
    expect(changes.turns[1].files).toEqual([expect.objectContaining({ path: 'data/notes/devchat.md', status: 'modified' })]);

    // Revert turn 2 restores the turn-1 bytes; revert the house rules file alone restores the fixture.
    const note = path.join(t.cfg.dataRoot, 'data', 'notes', 'devchat.md');
    expect((await post('/api/dev/revert', { sessionId: id, turn: 2 })).json().reverted).toEqual([{ abs: note, result: 'restored' }]);
    expect(fs.readFileSync(note, 'utf8')).toContain('written by the fake session');
    const custom = path.join(t.cfg.dataRoot, 'modes', '_custom.md');
    expect((await post('/api/dev/revert', { sessionId: id, turn: 1, abs: custom })).json().reverted[0].result).toBe('restored');
    expect(fs.readFileSync(custom, 'utf8')).not.toContain('Added by Dev Chat');
    expect((await post('/api/dev/revert', { sessionId: id, turn: 1, abs: '/etc/hosts' })).statusCode).toBe(404);
    expect((await post('/api/dev/revert', { sessionId: id, turn: 1 })).json().reverted).toEqual(expect.arrayContaining([{ abs: note, result: 'deleted' }]));
    expect(fs.existsSync(note)).toBe(false);
  });

  it('the blacklist checkbox unlocks data/blacklist.md for that turn only', async () => {
    const { id } = (await post('/api/sessions', { mode: 'devchat', prompt: 'Blacklist Synthetic Corp', blacklistAllowed: true })).json();
    const first = await settle(id);
    const denied = first.events.filter((e: { event: { type: string } }) => e.event.type === 'permission.denied');
    expect(denied).toHaveLength(2);
    expect(fs.readFileSync(path.join(t.cfg.dataRoot, 'data', 'blacklist.md'), 'utf8')).toContain('Added by Dev Chat');
    const turnPolicy = (n: number) => JSON.parse(fs.readFileSync(path.join(t.cfg.guardRoot, 'sessions', id, 'turns', String(n), 'policy.json'), 'utf8'));
    expect(turnPolicy(1).allow).toContain('data/blacklist.md');
    expect(turnPolicy(1).deny).toContain('custom/control-center/supervisor/**');
    expect(turnPolicy(1).deny).not.toContain('data/blacklist.md');
    await post(`/api/sessions/${id}/turns`, { prompt: 'next turn without the checkbox' });
    await settle(id);
    expect(turnPolicy(2).deny).toContain('data/blacklist.md');
    expect(turnPolicy(2).allow).not.toContain('data/blacklist.md');
    expect(turnPolicy(1).allow).toContain('data/blacklist.md');
  });

  it('keeps each turn policy, the settings and the revert bookkeeping outside both roots', async () => {
    const { id } = (await post('/api/sessions', { mode: 'devchat', prompt: 'Add a rule to the house rules' })).json();
    const { meta } = await settle(id);
    expect(meta.status).toBe('done');
    const guardDir = path.join(t.cfg.guardRoot, 'sessions', id);
    for (const rel of ['settings.json', 'files.ndjson', 'turns/1/policy.json', 'turns/1/turn.json']) expect(fs.existsSync(path.join(guardDir, rel)), rel).toBe(true);
    expect(fs.readdirSync(path.join(guardDir, 'turns', '1', 'before')).length).toBeGreaterThan(0);
    const dataDir = t.sessions.store.dirOf(id);
    for (const name of ['policy.json', 'settings.json', 'files.ndjson', 'before', 'turns']) expect(fs.existsSync(path.join(dataDir, name)), name).toBe(false);
    for (const root of [t.cfg.codeRoot, t.cfg.dataRoot]) {
      const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(guardDir));
      expect(rel.startsWith('..') || path.isAbsolute(rel), root).toBe(true);
    }
    const run = (await get(`/api/runs/${meta.turns[0].runId}`)).json();
    expect(run.meta.cmd.args[run.meta.cmd.args.indexOf('--settings') + 1]).toBe(path.join(guardDir, 'settings.json'));
  });

  it('serves the read-only git diff of custom/', async () => {
    const r = await get('/api/dev/git-diff');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
    expect(typeof r.json().diff).toBe('string');
  });
});
