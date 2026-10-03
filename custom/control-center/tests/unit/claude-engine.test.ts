import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildArgv, buildAllowedTools, buildDisallowedTools, buildEnv, buildPreamble, redact, writePolicyFile, writeSettingsFile } from '../../server/claude/invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, getModePolicy } from '../../server/claude/modes.js';
import { GUARD_HOOK_PATH } from '../../server/claude/invocation.js';
import { checkBash, snapshotKey } from '../../server/claude/guard-policy.mjs';
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
    // The CLI's own switch: its Bash and hook children run without CLAUDE_CODE_OAUTH_TOKEN and the other credentials.
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
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
      // Run outside any session guard: by launchd (daily and weekly jobs, with the OAuth token) or by the user.
      'custom/immigration/run-daily.sh',
      'custom/immigration/daily-prompt.md',
      'custom/upstream-sync/sync.sh',
      'custom/upstream-sync/sync-prompt.md',
      'custom/launchd/install.sh',
      // Tests there are run by the user and CI.
      'custom/immigration/tests/watch.test.mjs',
      'custom/pipeline/tests/shortlist.test.mjs',
      'custom/immigration/freshness.test.mjs',
    ];
    for (const rel of protectedPaths) expect(write(rel).status, rel).toBe(2);
    for (const rel of ['custom/control-center/server/routes/read.ts', 'custom/control-center/web/features/today/TodayPage.tsx', 'data/notes/devchat.md', 'modes/_custom.md']) expect(write(rel).status, rel).toBe(0);
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

  it('records the sha256 of the bytes it just wrote with each change record', () => {
    const target = path.join(realRoot, 'reports', '003-hashed.md');
    fs.writeFileSync(target, 'written by the tool\n');
    expect(hookRun(sessionDir, policy, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: target }, tool_response: {}, cwd: realRoot }).status).toBe(0);
    const last = JSON.parse(fs.readFileSync(path.join(sessionDir, 'files.ndjson'), 'utf8').trim().split('\n').at(-1)!) as { path: string; sha256: string };
    expect(last).toMatchObject({ path: 'reports/003-hashed.md', sha256: crypto.createHash('sha256').update('written by the tool\n').digest('hex') });
  });

  it('records changed paths after a write', () => {
    const r = hookRun(sessionDir, policy, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(realRoot, 'reports', '002-new.md') }, tool_response: {}, cwd: realRoot });
    expect(r.status).toBe(0);
    const lines = fs.readFileSync(path.join(sessionDir, 'files.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { path: string });
    expect(lines.at(-1)!.path).toBe('reports/002-new.md');
  });
});

describe('checkBash: exact per-command argument grammars', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bash-')));
  for (const d of ['custom/immigration', 'custom/pipeline', 'custom/control-center/tests/unit', 'output', 'reports', 'data', 'jds']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const policyFor = (mode: string, deny: string[]) => {
    const p = getModePolicy(mode)!;
    return { codeRoot: root, dataRoot: root, allow: p.writeGlobs, deny, bash: p.bashPrefixes };
  };
  const devchat = policyFor('devchat', [...DEVCHAT_DENIED_WRITES]);
  const oferta = policyFor('oferta', [...ALWAYS_DENIED_WRITES]);
  const pdf = policyFor('pdf', [...ALWAYS_DENIED_WRITES]);
  const ok = (policy: typeof devchat, cmd: string) => expect(checkBash(cmd, policy, root), cmd).toBeNull();
  const no = (policy: typeof devchat, cmd: string) => expect(checkBash(cmd, policy, root), cmd).toEqual(expect.any(String));

  it('rejects the review triggers', () => {
    no(devchat, 'git status\nrm -rf ~/Documents');
    no(devchat, 'git diff --no-index --output=data/applications.md /dev/null README.md');
    no(oferta, 'node generate-pdf.mjs output/x.html /Users/me/anywhere.pdf');
    no(devchat, 'node --test custom/immigration/../../../tmp/x.mjs');
  });

  it('rejects line breaks, control characters and every shell operator or expansion, even inside quotes', () => {
    for (const cmd of [
      'git status\rrm -rf x',
      'git status\u0000',
      'git status\tx',
      'git status\u2028x',
      'git status; rm -rf x',
      'git status && rm -rf x',
      'git status || rm -rf x',
      'git status & rm -rf x',
      'git status | tee x',
      'git status > x',
      'git status < x',
      'git log $(id)',
      'git log `id`',
      'git log $HOME',
      'git log "${HOME}"',
      'git log "$(id)"',
      'git diff (x)',
      'git diff {a,b}',
      'git diff *',
      'git diff custom/?',
      'git diff [ab]',
      'git diff ~/x',
      'git diff --relative=~/x',
      'git diff !x',
      'git diff #x',
      'git diff a\\ b',
      'git diff HEAD^',
      'git diff "unbalanced',
      'node --test =node',
    ])
      no(devchat, cmd);
  });

  it('git: only status, diff and log with read-only flags and in-repo paths; never --output, -o or --no-index', () => {
    for (const cmd of ['git status', 'git status --short custom/control-center/package.json', 'git status -s -b', 'git diff', 'git diff --stat -- custom/', 'git diff --cached --name-only', 'git diff HEAD~1 -- custom/control-center/server', 'git diff main..feat/x --stat', 'git log --oneline -n 5', 'git log --oneline -5 -- custom/', 'git log --format=%h --since=2.weeks'])
      ok(devchat, cmd);
    for (const cmd of [
      'git diff --output=x.patch',
      'git diff --output x.patch',
      'git log --output=data/applications.md',
      'git diff -o x',
      'git diff -ox',
      'git diff --no-index a b',
      'git diff --ext-diff',
      'git status ../../etc',
      'git diff /etc/passwd',
      'git -C / status',
      'git push origin main',
      'git status --porcelain=v3 --exec=x',
      'git log --output-indicator-new=x',
    ])
      no(devchat, cmd);
  });

  it('npm and npx: the exact scripts and vitest filters inside the app tests, nothing else', () => {
    for (const cmd of ['npm --prefix custom/control-center run test', 'npm --prefix custom/control-center run typecheck', 'npm --prefix custom/control-center run lint', 'npm --prefix custom/control-center run build', 'npx --prefix custom/control-center vitest run', 'npx --prefix custom/control-center vitest run recovery', 'npx --prefix custom/control-center vitest run custom/control-center/tests/unit/recovery.test.ts'])
      ok(devchat, cmd);
    for (const cmd of [
      'npm --prefix custom/control-center run test -- --config /tmp/x.ts',
      'npm --prefix custom/control-center run start',
      'npm --prefix custom/control-center run test x',
      'npm --prefix /tmp run test',
      'npx --prefix custom/control-center vitest run --config /tmp/evil.ts',
      'npx --prefix custom/control-center vitest run ../../../tmp/x.test.ts',
      'npx --prefix custom/control-center vitest run /tmp/x.test.ts',
      'npx --prefix custom/control-center vitest watch',
    ])
      no(devchat, cmd);
  });

  it('node --test is not allowed at all: the tests import modules Dev Chat can edit and run them outside any guard', () => {
    expect(getModePolicy('devchat')!.bashPrefixes.some((p) => p[0] === 'node' && p[1] === '--test')).toBe(false);
    for (const cmd of ['node --test custom/immigration/freshness.test.mjs', 'node --test custom/immigration/', 'node --test custom/pipeline/a.test.mjs custom/pipeline/b.test.mjs', 'node --test', 'node --test custom/immigration/../../../tmp/x.mjs'])
      no(devchat, cmd);
  });

  it('scripts: path arguments stay inside the roots, outputs inside the write scope, protected files never appear', () => {
    for (const cmd of [
      'node validate-portals.mjs',
      'node validate-portals.mjs --file portals.yml',
      'node validate-profile.mjs --profile config/profile.yml --json',
    ])
      ok(devchat, cmd);
    for (const cmd of ['node validate-portals.mjs --file /etc/passwd', 'node validate-portals.mjs --file=../x.yml', 'node validate-profile.mjs --profile data/control-center/settings.json', 'node set-status.mjs --row 3 Applied']) no(devchat, cmd);
    for (const cmd of [
      'node set-status.mjs --row 3 Applied --source web',
      'node set-status.mjs 8 Applied --note "Recruiter called, follow up next week"',
      'node merge-tracker.mjs',
      'node reserve-report-num.mjs --release 008',
      'node check-liveness.mjs https://jobs.example.com/x/1',
      'node custom/immigration/freshness.mjs "Acme Robotics"',
      'node plugins/h1b-sponsor/check.mjs Acme',
      'node jd-skill-gap.mjs jds/acme.md --summary',
      'node generate-pdf.mjs output/x.html output/x.pdf --format=letter --report=008',
    ])
      ok(oferta, cmd);
    for (const cmd of [
      'node generate-pdf.mjs output/x.html ../anywhere.pdf',
      'node generate-pdf.mjs output/x.html cv.md',
      'node generate-pdf.mjs output/x.html data/applications.md',
      'node generate-pdf.mjs --batch=output/manifest.json',
      'node generate-pdf.mjs --batch output/manifest.json',
      'node set-status.mjs --row 3 Applied --output data/applications.md',
      'node set-status.mjs --row 3 Applied -o x',
      'node merge-tracker.mjs data/blacklist.md',
      'node check-liveness.mjs --file /etc/passwd',
      'node scan.mjs',
      'NODE_OPTIONS=--require=/tmp/x.js node merge-tracker.mjs',
      'curl https://x.example',
    ])
      no(oferta, cmd);
    for (const cmd of ['node build-cv-latex.mjs output/cv.json output/cv.tex', 'node generate-cover-letter.mjs --payload output/p.json --out output/c.pdf']) ok(pdf, cmd);
    for (const cmd of ['node build-cv-latex.mjs output/cv.json data/x.tex', 'node generate-cover-letter.mjs --payload output/p.json --out reports/c.pdf', 'node generate-cover-letter.mjs --payload output/p.json --out=../c.pdf']) no(pdf, cmd);
  });

  it('writer scripts: every positional after the first and every output flag value is checked against the write scope, path-like or not', () => {
    for (const cmd of [
      'node generate-pdf.mjs output/x.html LICENSE',
      'node generate-pdf.mjs output/x.html cv',
      'node generate-pdf.mjs --allow-reorder output/x.html Makefile',
      'node generate-pdf.mjs output/x.html output/x.pdf README',
    ])
      no(oferta, cmd);
    for (const cmd of ['node build-cv-latex.mjs output/cv.json Makefile', 'node generate-cover-letter.mjs --out LICENSE --payload output/p.json', 'node generate-cover-letter.mjs --payload output/p.json --out=LICENSE']) no(pdf, cmd);
    for (const cmd of ['node generate-pdf.mjs output/x.html output/x.pdf --format=letter --report=008', 'node generate-pdf.mjs --allow-reorder output/x.html output/x.pdf']) ok(oferta, cmd);
    for (const cmd of ['node generate-cover-letter.mjs --payload output/p.json --out output/c.pdf --format letter --report 008', 'node build-cv-latex.mjs output/cv.json output/cv.tex --template=cjk']) ok(pdf, cmd);
    // Values of declared value flags are not outputs; --root is.
    const artifacts = { ...oferta, bash: [['node', 'application-artifacts.mjs']] };
    ok(artifacts, 'node application-artifacts.mjs --report 12 --company "Acme Robotics" --role Backend --version 2');
    no(artifacts, 'node application-artifacts.mjs --report 12 --company Acme --role Backend --root data');
    ok(artifacts, 'node application-artifacts.mjs --report 12 --company Acme --role Backend --root output/artifacts');
  });

  it('a dash-prefixed token a script would read as a path is refused, never skipped as a flag', () => {
    // The review triggers: generate-pdf takes any unrecognized token as a positional, and path.resolve normalizes -x/.. away.
    no(oferta, 'node generate-pdf.mjs output/a.html -x/../data/applications.md');
    no(oferta, 'node generate-pdf.mjs -x/../output/a.html cv.md');
    // jd-skill-gap takes the first token not starting with -- as its input.
    no(oferta, 'node jd-skill-gap.mjs -x/../../../etc/passwd --summary');
    ok(oferta, 'node jd-skill-gap.mjs jds/acme.md --summary');
    no(oferta, 'node set-status.mjs --row 3 -x/../../etc/passwd');
    // generate-pdf only knows --format=, --report[=], --kind[=], --max-pages= and its boolean switches.
    ok(oferta, 'node generate-pdf.mjs output/a.html output/a.pdf --format=letter --report=008 --kind=cv --max-pages=2 --allow-reorder --strict-pages');
    no(oferta, 'node generate-pdf.mjs output/a.html output/a.pdf --format letter');
    no(oferta, 'node generate-pdf.mjs output/a.html output/a.pdf --report 008');
    no(oferta, 'node generate-pdf.mjs output/a.html output/a.pdf --unknown-flag');
    no(oferta, 'node generate-pdf.mjs output/a.html output/a.pdf output/b.pdf');
    const writers = (script: string) => ({ ...pdf, bash: [['node', script]] });
    // Value flags take the next token even when it starts with a single dash; it is still checked as an output.
    no(writers('generate-cover-letter.mjs'), 'node generate-cover-letter.mjs --payload output/p.json --out -x/../cv.md');
    ok(writers('generate-cover-letter.mjs'), 'node generate-cover-letter.mjs --payload=output/p.json --out=output/c.pdf --format=a4');
    no(writers('generate-cover-letter.mjs'), 'node generate-cover-letter.mjs --payload output/p.json --open');
    // Scripts that read positionals by index: a flag before them would become a path.
    no(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs --template=cjk output/cv.json output/cv.tex');
    ok(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs output/cv.json output/cv.tex --template=cjk');
    no(writers('patch-latex-content.mjs'), 'node patch-latex-content.mjs -x/../cv.tex output/p.json output/cv.tex');
    ok(writers('patch-latex-content.mjs'), 'node patch-latex-content.mjs output/cv.tex output/p.json output/cv-new.tex');
    ok(writers('build-cv-html.mjs'), 'node build-cv-html.mjs --preview output/cv.json templates/cv-modern.html');
    no(writers('build-cv-html.mjs'), 'node build-cv-html.mjs output/cv.json --preview templates/cv-modern.html');
    no(writers('extract-latex-content.mjs'), 'node extract-latex-content.mjs --out=output/m.json output/cv.tex');
    ok(writers('extract-latex-content.mjs'), 'node extract-latex-content.mjs output/cv.tex --out output/m.json');
    ok(writers('generate-latex.mjs'), 'node generate-latex.mjs output/cv.tex output/cv.pdf --compile-only');
    no(writers('generate-latex.mjs'), 'node generate-latex.mjs output/cv.tex --compileonly');
  });

  it('scripts that read paths by index: a flag can never fill a path slot, even when fewer paths are given', () => {
    const writers = (script: string) => ({ ...pdf, bash: [['node', script]] });
    // The review trigger: build-cv-latex reads [input, output] = argv, so a lone input makes --template=... the output.
    no(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs output/cv.json --template=x/../cv.md');
    no(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs output/cv.json --template=x/../data/applications.md');
    no(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs output/cv.json --test');
    ok(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs output/cv.json output/cv.tex --template=cjk');
    no(writers('build-cv-latex.mjs'), 'node build-cv-latex.mjs --test');
    // build-cv-html reads [input, output, template] = argv (or input and template after --preview).
    no(writers('build-cv-html.mjs'), 'node build-cv-html.mjs output/cv.json --test');
    no(writers('build-cv-html.mjs'), 'node build-cv-html.mjs output/cv.json output/cv.html --test');
    no(writers('build-cv-html.mjs'), 'node build-cv-html.mjs --preview output/cv.json --test');
    ok(writers('build-cv-html.mjs'), 'node build-cv-html.mjs output/cv.json output/cv.html');
    ok(writers('build-cv-html.mjs'), 'node build-cv-html.mjs output/cv.json output/cv.html templates/cv-modern.html --test');
    ok(writers('build-cv-html.mjs'), 'node build-cv-html.mjs --preview output/cv.json');
  });

  it('generate-latex: the files it compiles next to its input must be writable too, with or without an output path', () => {
    const latex = { ...pdf, bash: [['node', 'generate-latex.mjs']] };
    // The review trigger: with no output it writes templates/cv-template.pdf, outside the documents scope.
    no(latex, 'node generate-latex.mjs templates/cv-template.tex --compile-only');
    // With an output it still compiles (and deletes) <base>.pdf, .aux and .log next to the input.
    no(latex, 'node generate-latex.mjs templates/cv-template.tex output/cv.pdf --compile-only');
    no(latex, 'node generate-latex.mjs cv.tex');
    ok(latex, 'node generate-latex.mjs output/cv.tex');
    ok(latex, 'node generate-latex.mjs output/cv.tex output/final/cv.pdf --compile-only');
    const reason = checkBash('node generate-latex.mjs templates/cv-template.tex --compile-only', latex, root);
    expect(reason).toMatch(/templates\/cv-template\.pdf/);
    // A protected sibling (here a .log the deny list names) blocks the compile as well.
    const data = { codeRoot: root, dataRoot: root, allow: ['data/**'], deny: ['data/x.log'], bash: [['node', 'generate-latex.mjs']] };
    no(data, 'node generate-latex.mjs data/x.tex data/out.pdf');
    ok(data, 'node generate-latex.mjs data/y.tex data/out.pdf');
  });

  it('refuses Bash when the session is not running from the repo root', () => {
    expect(checkBash('git status', devchat, path.join(root, 'data'))).toMatch(/repo root/);
    expect(checkBash('git status', devchat, root)).toBeNull();
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
