import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildArgv, buildAllowedTools, buildDisallowedTools, buildEnv, buildPreamble, redact, writePolicyFile, writeSettingsFile } from '../../server/claude/invocation.js';
import { DEVCHAT_DENIED_WRITES, getModePolicy } from '../../server/claude/modes.js';
import { GUARD_HOOK_PATH } from '../../server/claude/invocation.js';
import { snapshotKey } from '../../server/claude/guard-policy.mjs';
import { StreamParser } from '../../server/claude/stream-parse.js';
import { extractEnvelopes } from '../../server/claude/envelopes.js';

const codeRoot = '/repo/career-ops';
const base = { claudeBin: 'claude', codeRoot, dataRoot: '/data/root', sessionDir: '/data/root/data/control-center/sessions/s1', policyFile: '/data/root/data/control-center/sessions/s1/policy.json', settingsFile: '/data/root/data/control-center/sessions/s1/settings.json', userMessage: 'Evaluate https://x.example/1', claudeSessionId: '11111111-1111-4111-8111-111111111111', preamble: 'PREAMBLE', resume: false };

describe('invocation builder', () => {
  it('builds the contracted argv for a first turn of an evaluate mode', () => {
    const policy = getModePolicy('oferta')!;
    const argv = buildArgv({ ...base, policy });
    expect(argv.slice(0, 2)).toEqual(['-p', 'Evaluate https://x.example/1']);
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--session-id', base.claudeSessionId, '--permission-mode', 'dontAsk', '--append-system-prompt', 'PREAMBLE', '--settings', base.settingsFile, '--strict-mcp-config']));
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--mcp-config');
    const allowed = argv[argv.indexOf('--allowedTools') + 1]!;
    expect(allowed).toContain(`Edit(//repo/career-ops/reports/**)`);
    expect(allowed).toContain('Bash(node set-status.mjs:*)');
    expect(allowed).toContain('WebFetch');
    const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!;
    expect(disallowed.split(',')).toContain('Task');
  });
  it('resumes with --resume, forks with --fork-session, and passes model and max turns when set', () => {
    const policy = getModePolicy('oferta')!;
    const argv = buildArgv({ ...base, policy, resume: true, fork: true, model: 'sonnet', maxTurns: 12 });
    expect(argv).toEqual(expect.arrayContaining(['--resume', base.claudeSessionId, '--fork-session', '--model', 'sonnet', '--max-turns', '12']));
    expect(argv).not.toContain('--session-id');
  });
  it('apply adds the Playwright MCP config; pdf/hm-audit keeps Task; read-only classes disallow every write tool', () => {
    expect(buildArgv({ ...base, policy: getModePolicy('apply')! })).toContain('--mcp-config');
    expect(buildDisallowedTools(getModePolicy('pdf/hm-audit')!)).not.toContain('Task');
    const ro = buildDisallowedTools(getModePolicy('advisor')!);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch']) expect(ro).toContain(t);
    expect(buildAllowedTools(getModePolicy('ai-search')!, codeRoot)).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebSearch']));
    expect(buildAllowedTools(getModePolicy('ai-search')!, codeRoot)).not.toContain('WebFetch');
  });
  it('builds the env with the Keychain token, an empty API key and the policy pointers, and never puts the token in argv', () => {
    const env = buildEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'leak' }, { token: 'tok-secret', dataRoot: '/data/root', policyFile: base.policyFile, policySha256: 'ab'.repeat(32), sessionDir: base.sessionDir });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-secret');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.CAREER_OPS_ROOT).toBe('/data/root');
    expect(env.CC_POLICY_FILE).toBe(base.policyFile);
    expect(env.CC_POLICY_SHA256).toBe('ab'.repeat(32));
    expect(buildArgv({ ...base, policy: getModePolicy('oferta')! }).join(' ')).not.toContain('tok-secret');
    expect(redact('stderr says tok-secret twice tok-secret', 'tok-secret')).toBe('stderr says [redacted] twice [redacted]');
  });
  it('writes a preamble that names the scope, the router context and the envelope contract, with no em dash', () => {
    const text = buildPreamble({ policy: getModePolicy('apply')!, outputLanguage: 'en', reportNum: 12 });
    expect(text).toContain('headless');
    expect(text).toContain('_custom.md');
    expect(text).toContain('output/**');
    expect(text).toContain('<<cc:answers');
    expect(text).toContain('12');
    expect(text).toContain('Playwright');
    expect(text).not.toContain(String.fromCharCode(0x2014));
    expect(buildPreamble({ policy: getModePolicy('oferta')!, outputLanguage: 'es' })).toContain('Playwright is unavailable');
  });
});

function hookRun(sessionDir: string, policy: { file: string; sha256: string }, payload: Record<string, unknown>) {
  const r = spawnSync(process.execPath, [GUARD_HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CC_POLICY_FILE: policy.file, CC_POLICY_SHA256: policy.sha256, CC_SESSION_DIR: sessionDir } });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('guard hook', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-'));
  const realRoot = fs.realpathSync(root);
  fs.mkdirSync(path.join(realRoot, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(realRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(realRoot, 'data', 'blacklist.md'), '# blacklist\n');
  fs.writeFileSync(path.join(realRoot, 'reports', '001-existing.md'), 'old\n');
  const sessionDir = path.join(realRoot, 'session');
  fs.mkdirSync(sessionDir);
  const policy = writePolicyFile(sessionDir, { codeRoot: realRoot, policy: getModePolicy('oferta')!, extraAllow: ['data/**'] });
  const pre = (tool: string, input: Record<string, unknown>) => hookRun(sessionDir, policy, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: realRoot, session_id: 's' });

  it('allows an in-scope write and snapshots the original (absent marker for new files)', () => {
    expect(pre('Write', { file_path: path.join(realRoot, 'reports', '002-new.md'), content: 'x' }).status).toBe(0);
    expect(fs.existsSync(snapshotKey(sessionDir, path.join(realRoot, 'reports', '002-new.md')) + '.absent')).toBe(true);
    expect(pre('Edit', { file_path: path.join(realRoot, 'reports', '001-existing.md'), old_string: 'old', new_string: 'new' }).status).toBe(0);
    expect(fs.readFileSync(snapshotKey(sessionDir, path.join(realRoot, 'reports', '001-existing.md')), 'utf8')).toBe('old\n');
  });
  it('resolves writes against a separate data root and records which root a changed file belongs to', () => {
    const dataRoot = fs.mkdtempSync(path.join(realRoot, 'data-root-'));
    fs.mkdirSync(path.join(dataRoot, 'reports'));
    const dir = path.join(realRoot, 'session-data');
    fs.mkdirSync(dir);
    const pf = writePolicyFile(dir, { codeRoot: realRoot, dataRoot, policy: getModePolicy('oferta')! });
    const run = (event: string, tool: string, input: Record<string, unknown>) => hookRun(dir, pf, { hook_event_name: event, tool_name: tool, tool_input: input, cwd: realRoot, session_id: 's' });
    expect(run('PreToolUse', 'Write', { file_path: path.join(dataRoot, 'reports', '009-x.md'), content: 'x' }).status).toBe(0);
    expect(run('PreToolUse', 'Write', { file_path: path.join(dataRoot, 'cv.md'), content: 'x' }).status).toBe(2);
    expect(run('PreToolUse', 'Write', { file_path: path.join(realRoot, 'reports', '009-x.md'), content: 'x' }).status).toBe(0);
    expect(run('PostToolUse', 'Write', { file_path: path.join(dataRoot, 'reports', '009-x.md') }).status).toBe(0);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'files.ndjson'), 'utf8').trim()) as { path: string; abs: string; root: string };
    expect(rec).toMatchObject({ path: 'reports/009-x.md', abs: path.join(dataRoot, 'reports', '009-x.md'), root: 'data' });
    expect(buildAllowedTools(getModePolicy('oferta')!, '/code', '/data')).toEqual(expect.arrayContaining(['Edit(//code/reports/**)', 'Edit(//data/reports/**)']));
    expect(buildAllowedTools(getModePolicy('oferta')!, '/code', '/code').filter((t) => t.includes('reports/**'))).toHaveLength(1);
  });
  it('denies writes outside the scope, outside the code root, and always the blacklist and the tracker', () => {
    const out = pre('Write', { file_path: path.join(realRoot, 'cv.md'), content: 'x' });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/not in the write scope/);
    expect(pre('Write', { file_path: '/etc/hosts', content: 'x' }).status).toBe(2);
    expect(pre('Write', { file_path: path.join(realRoot, 'data', 'blacklist.md'), content: 'x' }).status).toBe(2);
    expect(pre('Edit', { file_path: path.join(realRoot, 'data', 'applications.md'), old_string: 'a', new_string: 'b' }).status).toBe(2);
    expect(pre('MultiEdit', { file_path: path.join(realRoot, 'reports', '..', 'cv.md'), edits: [] }).status).toBe(2);
  });
  it('allows Bash only for exact script prefixes and rejects chaining, git and network tools', () => {
    expect(pre('Bash', { command: 'node set-status.mjs --row 3 Applied --source web' }).status).toBe(0);
    expect(pre('Bash', { command: 'node set-status.mjs --row 3 Applied; rm -rf /' }).status).toBe(2);
    expect(pre('Bash', { command: 'node set-status.mjs $(cat x)' }).status).toBe(2);
    expect(pre('Bash', { command: 'node set-status.mjs --row 3 | tee out' }).status).toBe(2);
    expect(pre('Bash', { command: 'node scan.mjs' }).status).toBe(2);
    expect(pre('Bash', { command: 'git push origin main' }).status).toBe(2);
    expect(pre('Bash', { command: 'curl https://x.example' }).status).toBe(2);
  });
  it('denies Playwright clicks that look like a submit', () => {
    expect(pre('mcp__playwright__browser_click', { element: 'Submit application button', ref: 'e12' }).status).toBe(2);
    expect(pre('mcp__playwright__browser_click', { element: 'Next page', ref: 'e13' }).status).toBe(0);
    expect(pre('mcp__playwright__browser_press_key', { key: 'Enter', element: 'Apply now' }).status).toBe(2);
  });
  it('folds case on a case-insensitive volume: Blacklist.md, APPLICATIONS.md and Supervisor/ are still protected', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-case-')));
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'blacklist.md'), '# blacklist\n');
    fs.mkdirSync(path.join(root, 'custom', 'control-center', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'custom', 'control-center', 'supervisor', 'index.ts'), 'ok\n');
    const dir = path.join(root, 'guard');
    const pf = writePolicyFile(dir, { codeRoot: root, policy: getModePolicy('devchat')!, deny: [...DEVCHAT_DENIED_WRITES] });
    const write = (p: string, tool = 'Write') => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: p, content: 'x' }, cwd: root, session_id: 's' });
    // Existing protected file reached through a different case: realpath.native returns the on-disk case.
    const viaCase = write(path.join(root, 'data', 'Blacklist.md'));
    expect(viaCase.status, viaCase.stderr).toBe(2);
    expect(viaCase.stderr).toMatch(/data\/blacklist\.md is always protected/);
    expect(write(path.join(root, 'DATA', 'BLACKLIST.MD'), 'Edit').status).toBe(2);
    // Not-yet-existing protected file: the tail keeps the caller's case, so globs compare case-insensitively.
    expect(write(path.join(root, 'data', 'APPLICATIONS.md')).status).toBe(2);
    fs.writeFileSync(path.join(root, 'data', 'applications.md'), '| # |\n');
    expect(write(path.join(root, 'data', 'Applications.MD')).status).toBe(2);
    expect(write(path.join(root, 'custom', 'control-center', 'Supervisor', 'index.ts')).status).toBe(2);
    expect(write(path.join(root, 'custom', 'control-center', 'SUPERVISOR', 'new-file.ts')).status).toBe(2);
    expect(write(path.join(root, 'custom', 'notes', 'Fine.md')).status).toBe(0);
  });

  it('quotes the hook command so a checkout path with spaces still runs the guard, and fails closed on any hook failure', () => {
    const spaced = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc hook space ')));
    const nodePath = path.join(spaced, 'node bin');
    const hookPath = path.join(spaced, 'guard hook.mjs');
    fs.symlinkSync(process.execPath, nodePath);
    fs.symlinkSync(GUARD_HOOK_PATH, hookPath);
    const dir = path.join(spaced, 'session dir');
    const settingsFile = writeSettingsFile(dir, { nodePath, hookPath });
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }>; PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(settings.hooks.PostToolUse[0]!.hooks[0]!.command).toBe(command);
    // Claude Code runs command hooks through a shell; only exit 2 blocks the tool call.
    const sh = (cmd: string, input: string, env: NodeJS.ProcessEnv) => spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    const env = { CC_POLICY_FILE: policy.file, CC_POLICY_SHA256: policy.sha256, CC_SESSION_DIR: sessionDir };
    const write = (file: string) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: realRoot });
    expect(sh(command, write(path.join(realRoot, 'reports', '003-spaced.md')), env).status).toBe(0);
    expect(sh(command, write(path.join(realRoot, 'data', 'blacklist.md')), env).status).toBe(2);
    // Unparsable stdin, a missing policy and a hook that cannot even start all block.
    expect(sh(command, 'not json', env).status).toBe(2);
    expect(sh(command, write(path.join(realRoot, 'reports', '003-spaced.md')), {}).status).toBe(2);
    expect(sh(command, write(path.join(realRoot, 'reports', '003-spaced.md')), { ...env, CC_POLICY_FILE: path.join(spaced, 'missing.json') }).status).toBe(2);
    fs.rmSync(hookPath);
    expect(sh(command, write(path.join(realRoot, 'reports', '003-spaced.md')), env).status).toBe(2);
  });

  it('Dev Chat cannot write session state, the guard, the supervisor, dependency manifests, build and test configs, tests or scripts', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-devchat-')));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-devchat-guard-')));
    const pf = writePolicyFile(dir, { codeRoot: root, policy: getModePolicy('devchat')!, deny: [...DEVCHAT_DENIED_WRITES] });
    const write = (rel: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, rel), content: 'x' }, cwd: root, session_id: 's' });
    const protectedPaths = [
      'data/control-center/sessions/s1/policy.json',
      'data/control-center/sessions/s1/settings.json',
      'data/control-center/sessions/s1/files.ndjson',
      'data/control-center/sessions/s1/turns/1/before/x',
      'data/control-center/sessions/s1/meta.json',
      'data/control-center/settings.json',
      'custom/control-center/server/claude/guard-hook.mjs',
      'custom/control-center/server/claude/guard-policy.mjs',
      'custom/control-center/server/claude/modes.ts',
      'custom/control-center/supervisor/recovery.ts',
      'custom/control-center/package.json',
      'custom/control-center/package-lock.json',
      'custom/control-center/vite.config.ts',
      'custom/control-center/vitest.config.ts',
      'custom/control-center/playwright.config.ts',
      'custom/control-center/eslint.config.js',
      'custom/control-center/tsconfig.json',
      'custom/control-center/tsconfig.server.json',
      'custom/control-center/tsconfig.web.json',
      'custom/control-center/tests/unit/x.test.ts',
      'custom/control-center/tests/fakes/claude.mjs',
      'custom/control-center/scripts/no-em-dash.mjs',
      'custom/control-center/node_modules/vitest/index.js',
    ];
    for (const rel of protectedPaths) expect(write(rel).status, rel).toBe(2);
    for (const rel of ['custom/control-center/server/routes/read.ts', 'custom/control-center/web/features/today/TodayPage.tsx', 'custom/immigration/run-daily.sh', 'data/notes/devchat.md', 'modes/_custom.md']) expect(write(rel).status, rel).toBe(0);
  });

  it('a tampered or unverifiable policy fails closed for every tool call', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hook-tamper-')));
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: getModePolicy('oferta')! });
    expect(pf.sha256).toMatch(/^[0-9a-f]{64}$/);
    const inScope = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(realRoot, 'reports', '004-tamper.md'), content: 'x' }, cwd: realRoot };
    expect(hookRun(dir, pf, inScope).status).toBe(0);
    // The review's trigger: rewrite the policy to allow everything and deny nothing.
    const widened = { ...JSON.parse(fs.readFileSync(pf.file, 'utf8')), allow: ['**'], deny: [] };
    fs.writeFileSync(pf.file, JSON.stringify(widened));
    const tampered = hookRun(dir, pf, { ...inScope, tool_input: { file_path: path.join(realRoot, 'data', 'blacklist.md'), content: 'x' } });
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toMatch(/policy/i);
    expect(hookRun(dir, pf, inScope).status).toBe(2);
    expect(hookRun(dir, pf, { ...inScope, tool_name: 'Bash', tool_input: { command: 'node merge-tracker.mjs' } }).status).toBe(2);
    // No hash in the environment: nothing to verify against, so nothing runs.
    expect(hookRun(dir, { file: pf.file, sha256: '' }, inScope).status).toBe(2);
  });

  it('records changed paths after a write', () => {
    const r = hookRun(sessionDir, policy, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(realRoot, 'reports', '002-new.md') }, tool_response: {}, cwd: realRoot });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(path.join(sessionDir, 'files.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { path: string });
    expect(lines.at(-1)!.path).toBe('reports/002-new.md');
  });
});

describe('stream parser', () => {
  it('normalizes the recorded stream-json shapes into session events', () => {
    const p = new StreamParser();
    const ev = (o: unknown) => p.push(JSON.stringify(o));
    expect(ev({ type: 'system', subtype: 'init', session_id: 'abc', tools: ['Read'], model: 'claude-x' })).toEqual([{ type: 'session.init', model: 'claude-x', tools: ['Read'], claudeSessionId: 'abc' }]);
    expect(ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } })).toEqual([{ type: 'text.delta', text: 'Hello ' }]);
    expect(ev({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/r/reports/009.md', content: 'x'.repeat(500) } }] } })).toEqual([{ type: 'tool.use', id: 't1', name: 'Write', summary: '/r/reports/009.md' }]);
    expect(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File written' }] } })).toEqual([{ type: 'tool.result', id: 't1', ok: true, summary: 'File written' }]);
    const denied = ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: "Permission to use Write has been denied because Claude Code is running in don't ask mode" }] } });
    expect(denied[0]).toMatchObject({ type: 'tool.result', id: 't2', ok: false });
    const done = ev({ type: 'result', subtype: 'success', total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 }, num_turns: 3, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'git status' } }], is_error: false, result: 'Done. <<cc:act {"action":"navigate","params":{"to":"/tracker"}}>>' });
    expect(done).toEqual(expect.arrayContaining([{ type: 'permission.denied', tool: 'Bash', input: { command: 'git status' } }, { type: 'turn.done', costUsd: 0.12, tokens: 18, numTurns: 3, isError: false }]));
    expect(done.some((e) => e.type === 'envelope' && e.kind === 'act')).toBe(true);
    expect(p.push('not json')).toEqual([{ type: 'stderr', text: 'not json' }]);
  });
});

describe('envelopes', () => {
  it('extracts envelopes outside code fences, hides a partial opener and flags invalid payloads', () => {
    const text = 'Found two.\n<<cc:offer {"url":"https://a.example/1","company":"A","title":"Eng"}>>\n```\n<<cc:offer {"url":"https://fence.example","company":"F","title":"X"}>>\n```\n<<cc:offer {"nope":true}>>\nMore text <<cc:off';
    const r = extractEnvelopes(text, true);
    expect(r.envelopes.filter((e) => e.ok).map((e) => (e.ok ? e.payload : null))).toEqual([{ url: 'https://a.example/1', company: 'A', title: 'Eng' }]);
    expect(r.envelopes.filter((e) => !e.ok)).toHaveLength(1);
    expect(r.visibleText).toContain('Found two.');
    // The trailing partial opener is hidden while streaming; the fenced envelope stays verbatim.
    expect(r.visibleText.endsWith('More text ')).toBe(true);
    expect(r.visibleText).toContain('<<cc:offer {"url":"https://fence.example"');
    expect(extractEnvelopes('tail <<cc:off', false).visibleText).toContain('<<cc:off');
    const answers = extractEnvelopes('<<cc:answers {"fields":[{"id":"q1","label":"Why us","type":"textarea","required":true,"value":"Because","needsConfirmation":true}]}>>', false);
    expect(answers.envelopes[0]).toMatchObject({ ok: true, kind: 'answers' });
    expect(extractEnvelopes('<<cc:bogus {"a":1}>>', false).envelopes[0]).toMatchObject({ ok: false });
  });
});
