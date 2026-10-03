import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
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
    const explicit = { ...t.authedWrite, 'x-cc-explicit': 'blacklist' };
    const { id } = (await t.app.inject({ method: 'POST', url: '/api/sessions', headers: explicit, payload: { mode: 'devchat', prompt: 'Blacklist Synthetic Corp', blacklistAllowed: true } })).json();
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

  it('records the post-turn hashes, refuses (409) a revert over a later edit and while the session runs, and reverts once the bytes match again', async () => {
    const custom = path.join(t.cfg.dataRoot, 'modes', '_custom.md');
    const note = path.join(t.cfg.dataRoot, 'data', 'notes', 'devchat.md');
    fs.rmSync(note, { force: true });
    const preSession = fs.readFileSync(custom, 'utf8');
    const { id } = (await post('/api/sessions', { mode: 'devchat', prompt: 'Add a rule to the house rules and leave a note' })).json();
    await settle(id);
    const after = JSON.parse(fs.readFileSync(path.join(t.cfg.guardRoot, 'sessions', id, 'turns', '1', 'after.json'), 'utf8')).files;
    expect(Object.keys(after).sort()).toEqual([note, custom].sort());
    const postTurn = fs.readFileSync(custom, 'utf8');
    // The user edits the house rules after the turn (Settings or an editor).
    fs.writeFileSync(custom, `${postTurn}- A rule the user added later.\n`);
    const refused = await post('/api/dev/revert', { sessionId: id, turn: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/modes\/_custom\.md changed after turn 1/);
    expect(refused.json().conflicts).toEqual(['modes/_custom.md']);
    expect(fs.readFileSync(custom, 'utf8')).toContain('A rule the user added later.');
    expect(fs.existsSync(note)).toBe(true);
    expect((await post('/api/dev/revert', { sessionId: id, turn: 1, abs: custom })).statusCode).toBe(409);
    // While the session is running nothing is reverted, whatever the bytes are.
    fs.writeFileSync(custom, postTurn);
    t.sessions.store.setStatus(id, 'running');
    expect((await post('/api/dev/revert', { sessionId: id, turn: 1 })).statusCode).toBe(409);
    expect(fs.readFileSync(custom, 'utf8')).toBe(postTurn);
    t.sessions.store.setStatus(id, 'done');
    const ok = await post('/api/dev/revert', { sessionId: id, turn: 1 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(fs.readFileSync(custom, 'utf8')).toBe(preSession);
    expect(fs.existsSync(note)).toBe(false);
  });

  it('a turn that ends while no server runs keeps its own post-turn hashes: a later hand edit blocks the revert', async () => {
    const dataRoot = copyFixtureRoot();
    const guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-guard-'));
    const scenario = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scenario-')), 'offline.json');
    fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Write'] }, { __sleep: 400 }, { __write: { path: '{{DATA_ROOT}}/data/notes/offline.md', content: 'written by the turn\n' } }, { type: 'result', subtype: 'success', result: 'Wrote the note.', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, is_error: false }] }));
    const a = await makeTestApp({ dataRoot, guardRoot });
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    let started: { id: string; turns: Array<{ runId: string }> };
    try {
      started = (await a.app.inject({ method: 'POST', url: '/api/sessions', headers: a.authedWrite, payload: { mode: 'devchat', prompt: 'Leave a note' } })).json();
    } finally {
      delete process.env.FAKE_CLAUDE_SCENARIO;
    }
    await a.close();
    const exitFile = path.join(dataRoot, 'data', 'control-center', 'runs', started.turns[0]!.runId, 'exit.json');
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(exitFile)) {
      if (Date.now() > deadline) throw new Error('the run never finished');
      await wait(50);
    }
    const note = path.join(dataRoot, 'data', 'notes', 'offline.md');
    fs.writeFileSync(note, 'the user edited this while the server was down\n');
    const b = await makeTestApp({ dataRoot, guardRoot });
    try {
      let meta = b.sessions.read(started.id)!;
      while (meta.status === 'running' && Date.now() < deadline) {
        await wait(50);
        meta = b.sessions.read(started.id)!;
      }
      expect(meta.status).toBe('done');
      const res = await b.app.inject({ method: 'POST', url: '/api/dev/revert', headers: b.authedWrite, payload: { sessionId: started.id, turn: 1 } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/data\/notes\/offline\.md changed after turn 1/);
      expect(fs.readFileSync(note, 'utf8')).toBe('the user edited this while the server was down\n');
    } finally {
      await b.close();
    }
  });

  it('the blacklist unlock needs a Dev Chat session and the X-CC-Explicit: blacklist header on that request', async () => {
    const explicit = { ...t.authedWrite, 'x-cc-explicit': 'blacklist' };
    const before = t.sessions.list().length;
    const evaluate = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: explicit, payload: { mode: 'oferta', prompt: 'Evaluate', blacklistAllowed: true } });
    expect(evaluate.statusCode).toBe(403);
    const bare = await post('/api/sessions', { mode: 'devchat', prompt: 'Blacklist Initech', blacklistAllowed: true });
    expect(bare.statusCode).toBe(403);
    expect(bare.json().error).toMatch(/X-CC-Explicit: blacklist/);
    expect(t.sessions.list()).toHaveLength(before);
    const { id } = (await post('/api/sessions', { mode: 'devchat', prompt: 'A plain turn' })).json();
    await settle(id);
    expect((await post(`/api/sessions/${id}/turns`, { prompt: 'now the blacklist', blacklistAllowed: true })).statusCode).toBe(403);
    expect(t.sessions.read(id)!.turns).toHaveLength(1);
    // Even a direct manager call cannot unlock it outside Dev Chat.
    const direct = await t.sessions.start({ mode: 'oferta', target: { type: 'none', value: null }, prompt: 'Evaluate', blacklistAllowed: true });
    const policy = JSON.parse(fs.readFileSync(path.join(t.cfg.guardRoot, 'sessions', direct.id, 'turns', '1', 'policy.json'), 'utf8'));
    expect(policy.deny).toContain('data/blacklist.md');
    expect(policy.allow).not.toContain('data/blacklist.md');
    await settle(direct.id);
  });

  it('serves the read-only git diff of custom/', async () => {
    const r = await get('/api/dev/git-diff');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
    expect(typeof r.json().diff).toBe('string');
  });
});
