import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertRootsConfinable, buildArgv, buildAllowedTools, buildDisallowedTools, buildEnv, buildPermissions, buildPreamble, buildTools, neutralizeFileMentions, redact, writePolicyFile, writeSettingsFile } from '../../server/claude/invocation.js';
import { ALWAYS_DENIED_WRITES, DEVCHAT_DENIED_WRITES, HOME_READ_DENY, READ_DENY, getModePolicy, listModeIds } from '../../server/claude/modes.js';
import { GUARD_HOOK_PATH, PLAYWRIGHT_MCP_PATH, PRE_TOOL_MATCHER } from '../../server/claude/invocation.js';
import { AGENT_SPAWNING_SCRIPTS, checkBash, checkRead, checkSearch, checkWrite, locateRead, snapshotKey, URL_LIST_MAX_BYTES, urlListFilesIn, WRITER_SCRIPT_NAMES } from '../../server/claude/guard-policy.mjs';
import { StreamParser } from '../../server/claude/stream-parse.js';
import { extractEnvelopes } from '../../server/claude/envelopes.js';
import { ASK_ACTION_SPECS } from '../../shared/ask-actions.js';
import { foldsCase } from '../helpers/case.js';
import { tempDir } from '../helpers/tmp.js';
import { PACKAGE_ROOT } from '../helpers/app.js';

const codeRoot = '/repo/career-ops';
const base = { claudeBin: 'claude', codeRoot, dataRoot: '/data/root', sessionDir: '/data/root/data/control-center/sessions/s1', policyFile: '/data/root/data/control-center/sessions/s1/policy.json', settingsFile: '/data/root/data/control-center/sessions/s1/settings.json', userMessage: 'Evaluate https://x.example/1', claudeSessionId: '11111111-1111-4111-8111-111111111111', preamble: 'PREAMBLE', resume: false };

describe('invocation builder', () => {
  it('builds the contracted argv for a first turn of an evaluate mode', () => {
    const policy = getModePolicy('oferta')!;
    const argv = buildArgv({ ...base, policy });
    // Requirement change (SW-claude-07): the prompt is the last argument, after --, so no prompt is parsed as an option.
    expect(argv[0]).toBe('-p');
    expect(argv.slice(-2)).toEqual(['--', 'Evaluate https://x.example/1']);
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--session-id', base.claudeSessionId, '--permission-mode', 'dontAsk', '--append-system-prompt', 'PREAMBLE', '--settings', base.settingsFile, '--strict-mcp-config']));
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--mcp-config');
    // Requirement change (BUG-06): allow rules live in the per-turn settings file, so a path with a space or comma is never split as an argument.
    expect(argv).not.toContain('--allowedTools');
    // Requirement change (SW2-claude-02): with a separate data root, user-layer write rules name the data root only.
    expect(buildAllowedTools(policy, codeRoot, base.dataRoot)).toEqual(expect.arrayContaining(['Edit(//data/root/reports/**)', 'Bash(node set-status.mjs:*)', 'WebFetch']));
    expect(buildAllowedTools(policy, codeRoot, base.dataRoot)).not.toContain('Edit(//repo/career-ops/reports/**)');
    const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!;
    expect(disallowed.split(',')).toContain('Task');
  });
  it('a prompt that starts with a dash or looks like an option is never read as one: every option comes before --, the prompt after it', () => {
    const policy = getModePolicy('apply')!;
    for (const userMessage of ['- rename X\n- add a test', '-h', '--dangerously-skip-permissions', '--permission-mode=bypassPermissions', '--settings=/tmp/x.json', '--', '-p']) {
      for (const turn of [{ resume: false }, { resume: true, fork: true, model: 'sonnet', maxTurns: 3 }]) {
        const argv = buildArgv({ ...base, ...turn, policy, userMessage });
        expect(argv.indexOf('--'), userMessage).toBe(argv.length - 2);
        expect(argv.at(-1), userMessage).toBe(userMessage);
        expect(argv.filter((a) => a === userMessage), userMessage).toHaveLength(userMessage === '--' || userMessage === '-p' ? 2 : 1);
      }
    }
  });
  it('resumes with --resume, forks with --fork-session, and passes model and max turns when set', () => {
    const policy = getModePolicy('oferta')!;
    const argv = buildArgv({ ...base, policy, resume: true, fork: true, model: 'sonnet', maxTurns: 12 });
    expect(argv).toEqual(expect.arrayContaining(['--resume', base.claudeSessionId, '--fork-session', '--model', 'sonnet', '--max-turns', '12']));
    expect(argv).not.toContain('--session-id');
  });
  it('pins --effort medium on first and resumed turns, since --restricted loads no user settings to supply it', () => {
    const policy = getModePolicy('oferta')!;
    for (const argv of [buildArgv({ ...base, policy }), buildArgv({ ...base, policy, resume: true, fork: true })]) {
      expect(argv[argv.indexOf('--effort') + 1]).toBe('medium');
      expect(argv.filter((a) => a === '--effort')).toHaveLength(1);
    }
  });
  it('apply adds the Playwright MCP config; pdf/hm-audit keeps Task; read-only classes disallow every write tool', () => {
    expect(buildArgv({ ...base, policy: getModePolicy('apply')! })).toContain('--mcp-config');
    expect(buildDisallowedTools(getModePolicy('pdf/hm-audit')!)).not.toContain('Task');
    const ro = buildDisallowedTools(getModePolicy('advisor')!);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch']) expect(ro).toContain(t);
    // Requirement change (BUG-06): Read, Glob and Grep come from --tools; a bare allow entry for them is gone.
    expect(buildAllowedTools(getModePolicy('ai-search')!, codeRoot)).toEqual(['WebSearch']);
    expect(buildTools(getModePolicy('ai-search')!)).toEqual(['Read', 'Glob', 'Grep', 'WebSearch']);
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
  it('tells projects-ingest that the document text is in the request and that it runs nothing', () => {
    const text = buildPreamble({ policy: getModePolicy('projects-ingest')!, outputLanguage: 'en' });
    expect(text).toMatch(/<document source="documents\/\.\.\."> tags/);
    expect(text).toMatch(/<<cc:projects \{"markdown":"\.\.\."\}>>/);
    expect(text).not.toMatch(/intake\.mjs --text/);
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
  it('the advisor contract names every action the Ask drawer runs, with its params, from the list the drawer reads (SW7-web-a-01)', () => {
    const contract = buildPreamble({ policy: getModePolicy('advisor')!, outputLanguage: 'en' }).split('\n').find((l) => l.startsWith('9. '))!;
    for (const spec of ASK_ACTION_SPECS.filter((a) => a.runs)) {
      expect(contract, spec.name).toContain(`${spec.name}(${spec.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')})`);
    }
    // The names and keys the drawer's run switch reads, spelled out.
    expect(contract).toContain('navigate(to)');
    expect(contract).toContain('setStatus(row, state, note?)');
    expect(contract).toContain('filterPipeline(q)');
    expect(contract).toContain('remember(fact)');
    // What the drawer cannot run is not offered.
    expect(contract).not.toContain('setProfile');
  });
  it('a localized apply mode gets the apply envelope contract: answers first, nothing filled until confirmed', () => {
    const contract = (id: string) => buildPreamble({ policy: getModePolicy(id)!, outputLanguage: 'en' }).split('\n').find((l) => l.startsWith('9. '))!;
    for (const id of ['de/bewerben', 'fr/postuler', 'ja/oubo', 'ru/apply', 'zh-TW/apply']) expect(contract(id), id).toBe(contract('apply'));
    expect(contract('apply')).toMatch(/<<cc:answers/);
    expect(contract('apply')).toMatch(/Do not fill anything until the user confirms/);
    // A localized evaluation still has no envelope contract.
    expect(contract('de/angebot')).toMatch(/none for this mode/);
  });
  it('rule 8 names where the write scope lives: the data root when it is separate, by absolute path (SW2-claude-02)', () => {
    const rule8 = (id: string, roots: { codeRoot?: string; dataRoot?: string }) => buildPreamble({ policy: getModePolicy(id)!, outputLanguage: 'en', ...roots }).split('\n').find((l) => l.startsWith('8. '))!;
    expect(rule8('oferta', { codeRoot: '/code', dataRoot: '/code' })).toContain('Allowed write scope (paths relative to the repo root): reports/**');
    const split = rule8('oferta', { codeRoot: '/code', dataRoot: '/data' });
    expect(split).toContain('relative to the data root /data');
    expect(split).toMatch(/write there by absolute path/);
    expect(split).not.toContain('relative to the repo root):');
    const devchat = rule8('devchat', { codeRoot: '/code', dataRoot: '/data' });
    expect(devchat).toContain('relative to the data root /data');
    expect(devchat).toMatch(/custom\/\*\* relative to the repo root \/code/);
  });
  it('rule 4 names the router files where they live: _profile.md and _custom.md in the data root when it is separate, by absolute path (SW3-claude-03)', () => {
    const rule4 = (roots: { codeRoot?: string; dataRoot?: string }) => buildPreamble({ policy: getModePolicy('oferta')!, outputLanguage: 'en', ...roots }).split('\n').find((l) => l.startsWith('4. '))!;
    const one = rule4({ codeRoot: '/code', dataRoot: '/code' });
    expect(one).toContain('read modes/_shared.md when the mode file references it, then modes/_profile.md and modes/_custom.md, then the mode file for oferta');
    const split = rule4({ codeRoot: '/code', dataRoot: '/data root' });
    expect(split).toContain('then /data root/modes/_profile.md and /data root/modes/_custom.md (the data root), then the mode file for oferta');
    expect(split).toContain('read modes/_shared.md when the mode file references it');
    expect(split).not.toMatch(/then modes\/_profile\.md/);
  });
  it('rule 6 names only the web tools the session has: never WebFetch to a session without it', () => {
    const rule6 = (policy: ReturnType<typeof getModePolicy>) => buildPreamble({ policy: policy!, outputLanguage: 'en' }).split('\n').find((l) => l.startsWith('6. '))!;
    const { mcp: _mcp, ...applyWithoutPlaywright } = getModePolicy('apply')!;
    for (const policy of [applyWithoutPlaywright, getModePolicy('offer-prep'), getModePolicy('update'), getModePolicy('advisor'), getModePolicy('ai-search')]) {
      const line = rule6(policy);
      expect(line, policy!.id).not.toContain('WebFetch when');
      expect(line, policy!.id).toMatch(/ask the user to paste/);
    }
    expect(rule6(getModePolicy('ai-search'))).toMatch(/WebSearch/);
    expect(rule6(applyWithoutPlaywright)).toMatch(/no web access/);
    for (const id of ['oferta', 'research', 'master-profile']) expect(rule6(getModePolicy(id)), id).toMatch(/Use WebFetch when you need a page/);
    expect(rule6(getModePolicy('apply'))).toMatch(/Playwright MCP is available/);
  });
});

describe('invocation: read confinement', () => {
  const tmp = (prefix: string) => fs.realpathSync(tempDir(prefix));
  const oferta = getModePolicy('oferta')!;
  const roots = { claudeBin: 'claude', codeRoot: '/code', dataRoot: '/data', sessionDir: '/guard/sessions/s1', policyFile: '/guard/sessions/s1/turns/1/policy.json', settingsFile: '/guard/sessions/s1/turns/1/settings.json', userMessage: 'Evaluate https://x.example/1', claudeSessionId: base.claudeSessionId, preamble: 'P', resume: false };

  it('given oferta with roots /code and /data, the argv restricts the CLI to the class tools and disallows PowerShell and subagents', () => {
    const argv = buildArgv({ ...roots, policy: oferta });
    expect(argv).toContain('--restricted');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch');
    expect(argv).not.toContain('--allowedTools');
    const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!.split(',');
    for (const t of ['PowerShell', 'Agent', 'Task']) expect(disallowed).toContain(t);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('every class gets exactly its tools: read-only gets the read tools, Bash only with Bash rules, Agent only for pdf/hm-audit', () => {
    expect(buildTools(getModePolicy('advisor')!)).toEqual(['Read', 'Glob', 'Grep']);
    expect(buildTools(getModePolicy('pdf/hm-audit')!)).toContain('Agent');
    expect(buildDisallowedTools(getModePolicy('pdf/hm-audit')!)).not.toContain('Agent');
    expect(buildTools(getModePolicy('devchat')!)).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch']);
    for (const mode of ['advisor', 'apply', 'devchat', 'cv-ingest', 'projects-ingest']) {
      expect(buildTools(getModePolicy(mode)!), mode).not.toContain('PowerShell');
      expect(buildDisallowedTools(getModePolicy(mode)!), mode).toContain('PowerShell');
    }
  });

  it('no bare Read, Glob or Grep allow entry anywhere, in argv or in the settings permissions', () => {
    for (const mode of ['oferta', 'advisor', 'devchat', 'pdf/hm-audit']) {
      const allow = buildPermissions({ policy: getModePolicy(mode)!, codeRoot: '/code', dataRoot: '/data', guardRoot: '/guard' }).allow;
      for (const t of ['Read', 'Glob', 'Grep']) expect(allow, mode).not.toContain(t);
      expect(allow.some((r) => /^(Read|Glob|Grep)\(/.test(r)), mode).toBe(false);
    }
  });

  it('the settings file carries the data root as a working directory, the deny list, the guard root and the write and Bash rules', () => {
    const guard = tmp('cc-settings-');
    const perms = buildPermissions({ policy: oferta, codeRoot: '/code', dataRoot: '/data root', guardRoot: '/guard' });
    const file = writeSettingsFile(guard, { permissions: perms });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions: { additionalDirectories: string[]; allow: string[]; deny: string[] }; hooks: unknown };
    expect(settings.permissions.additionalDirectories).toEqual(['/data root']);
    // Requirement change (SW2-claude-02): user-layer write rules name the data root only.
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(['Edit(//data root/reports/**)', 'Bash(node set-status.mjs:*)', 'WebFetch', 'WebSearch']));
    expect(settings.permissions.allow).not.toContain('Edit(//code/reports/**)');
    const deny = settings.permissions.deny;
    for (const p of HOME_READ_DENY) expect(deny).toContain(`Read(${p})`);
    expect(deny).toContain('Read(//guard/**)');
    for (const g of READ_DENY) {
      expect(deny).toContain(`Read(//code/${g})`);
      expect(deny).toContain(`Read(//data root/${g})`);
    }
    expect(settings.hooks).toBeDefined();
    // One root: no extra working directory.
    expect(buildPermissions({ policy: oferta, codeRoot: '/code', dataRoot: '/code', guardRoot: '/guard' }).additionalDirectories).toEqual([]);
  });

  it('deny rules cover each root and the guard root under both the given and the real path', () => {
    const realRoot = tmp('cc-spelled-');
    const link = path.join(tmp('cc-spelled-link-'), 'via-link');
    fs.symlinkSync(realRoot, link);
    const deny = buildPermissions({ policy: oferta, codeRoot: link, dataRoot: link, guardRoot: link }).deny;
    expect(deny).toContain(`Read(/${link}/**/.env)`);
    expect(deny).toContain(`Read(/${realRoot}/**/.env)`);
    expect(deny).toContain(`Read(/${link}/**)`);
    expect(deny).toContain(`Read(/${realRoot}/**)`);
  });

  it('the env pins the CLI: no self-update during a turn', () => {
    const env = buildEnv({}, { token: 't', dataRoot: '/data', policyFile: '/p', policySha256: 'ab', sessionDir: '/s' });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('neutralizeFileMentions breaks every @ that is not inside a URL or e-mail address, so no prompt can attach a file', () => {
    expect(neutralizeFileMentions('see @~/.ssh/x and a@b.com')).toBe('see @\u2060~/.ssh/x and a@b.com');
    expect(neutralizeFileMentions('@/etc/passwd')).toBe('@\u2060/etc/passwd');
    // Requirement change (second review): an @ is neutralized unless the character before it can sit inside a URL or an e-mail address.
    expect(neutralizeFileMentions('(@cv.md) and\n@x\t@y')).toBe('(@\u2060cv.md) and\n@\u2060x\t@\u2060y');
    for (const [text, out] of [
      ['(@/etc/passwd)', '(@\u2060/etc/passwd)'],
      ['"@/etc/passwd"', '"@\u2060/etc/passwd"'],
      ["'@x'", "'@\u2060x'"],
      ['[@x]', '[@\u2060x]'],
      ['{@x}', '{@\u2060x}'],
      ['<@x>', '<@\u2060x>'],
      ['a,@x', 'a,@\u2060x'],
      ['line one\n@x', 'line one\n@\u2060x'],
      ['@x', '@\u2060x'],
    ] as const)
      expect(neutralizeFileMentions(text), text).toBe(out);
    expect(neutralizeFileMentions(neutralizeFileMentions('@x'))).toBe('@\u2060x');
    // URLs flow into reports and dedup keys: an @ inside one is never touched.
    for (const url of ['https://medium.com/@acme/x', 'https://jobs.example.com/a/@team?b=@c&@d', 'https://x.example/%@y', 'https://x.example/q?@z', 'mailto:me@example.com', 'first.last+tag@example.co', 'user-1@x.io', 'scheme:@x'])
      expect(neutralizeFileMentions(`read ${url} now`), url).toBe(`read ${url} now`);
    const argv = buildArgv({ ...roots, policy: oferta, userMessage: 'read @~/.ssh/id_rsa for me' });
    // The prompt is the last argument, after -- (SW-claude-07).
    expect(argv.slice(-2)).toEqual(['--', 'read @\u2060~/.ssh/id_rsa for me']);
  });

  it('assertRootsConfinable refuses a root that is the filesystem root, the home directory or a parent of it, in any spelling', () => {
    const top = tmp('cc-roots-');
    const home = path.join(top, 'home');
    const code = path.join(home, 'career-ops');
    fs.mkdirSync(code, { recursive: true });
    expect(() => assertRootsConfinable(code, code, home)).not.toThrow();
    expect(() => assertRootsConfinable(code, home, home)).toThrow(/home directory/);
    expect(() => assertRootsConfinable(home, code, home)).toThrow(/home directory/);
    expect(() => assertRootsConfinable(code, top, home)).toThrow(/home directory/);
    expect(() => assertRootsConfinable(code, '/', home)).toThrow(/filesystem root/);
    expect(() => assertRootsConfinable(code, path.join(top, 'missing'), home)).toThrow(/cannot be resolved/);
    const mixed = path.join(top, 'HOME');
    // A case-insensitive volume resolves the other spelling to the home itself; elsewhere it does not exist. Refused either way.
    expect(() => assertRootsConfinable(code, mixed, home)).toThrow(foldsCase(top) ? /home directory/ : /cannot be resolved/);
  });

  it('the preamble tells the session to read AGENTS.md first (restricted sessions load no CLAUDE.md) and where user data lives', () => {
    const text = buildPreamble({ policy: oferta, outputLanguage: 'en', codeRoot: '/code', dataRoot: '/data root' });
    expect(text).toMatch(/2\. Read AGENTS\.md before anything else/);
    // Requirement change (SW2-claude-02): user files are written there too.
    expect(text).toContain('User data lives in /data root; read and write user files there by absolute path.');
    expect(buildPreamble({ policy: oferta, outputLanguage: 'en', codeRoot: '/code', dataRoot: '/code' })).not.toContain('User data lives in');
  });
});

/** Names the hook's DNS stub answers (tests/fakes/dns-stub.mjs); every other name does not resolve. */
const TEST_DNS = { 'public.test': ['93.184.215.14'], 'private.test': ['10.0.0.7'], 'mixed.test': ['93.184.215.14', '127.0.0.1'] };
const DNS_STUB = pathToFileURL(path.join(PACKAGE_ROOT, 'tests', 'fakes', 'dns-stub.mjs')).href;

function hookRun(sessionDir: string, policy: { file: string; sha256: string }, payload: Record<string, unknown>) {
  // The hook resolves names through the DNS stub, never the machine's resolver (SW2-tests-24).
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${DNS_STUB}`.trim(), CC_TEST_DNS: JSON.stringify(TEST_DNS), CC_POLICY_FILE: policy.file, CC_POLICY_SHA256: policy.sha256, CC_SESSION_DIR: sessionDir };
  // Snapshots go to the session dir given here, never to a turn dir the suite's own environment names (SW4-tests-02).
  delete env.CC_TURN_DIR;
  const r = spawnSync(process.execPath, [GUARD_HOOK_PATH], { input: JSON.stringify(payload), encoding: 'utf8', env });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

describe('guard hook', () => {
  const root = tempDir('cc-hook-');
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
  it('snapshots a file whose encoded path is longer than a file name may be (CJK names), so the write is allowed and revertable (SW5-claude-03)', () => {
    const dir = fs.realpathSync(tempDir('cc-hook-longname-'));
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: getModePolicy('interview-prep')! });
    const file = path.join(realRoot, 'interview-prep', '北京字节跳动科技有限公司-高级机器学习平台研发工程师-面试准备笔记.md');
    expect(encodeURIComponent(file).length).toBeGreaterThan(255);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'notes before\n');
    const r = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'notes', new_string: 'Notes' }, cwd: realRoot, session_id: 's' });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(snapshotKey(dir, file), 'utf8')).toBe('notes before\n');
    expect(path.basename(snapshotKey(dir, file)).length).toBeLessThanOrEqual(255);
  });

  it('a payload with no cwd fails closed: a relative Read, a Glob or Grep with no path and any Bash command are refused (SW4-tests-24)', () => {
    const dir = fs.realpathSync(tempDir('cc-hook-nocwd-'));
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: getModePolicy('oferta')! });
    const pre = (tool: string, input: Record<string, unknown>, cwd?: unknown) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...(cwd === undefined ? {} : { cwd }), session_id: 's' });
    for (const cwd of [undefined, null, '']) {
      const label = JSON.stringify(cwd) ?? 'missing';
      const read = pre('Read', { file_path: 'cv.md' }, cwd);
      expect(read.status, `Read ${label}`).toBe(2);
      expect(read.stderr, `Read ${label}`).toMatch(/working directory/);
      expect(pre('Bash', { command: 'node merge-tracker.mjs' }, cwd).status, `Bash ${label}`).toBe(2);
      expect(pre('Glob', { pattern: '**/*.md' }, cwd).status, `Glob ${label}`).toBe(2);
      expect(pre('Grep', { pattern: 'Acme' }, cwd).status, `Grep ${label}`).toBe(2);
    }
    // The same calls from the repo root pass, and an absolute Read needs no cwd at all.
    expect(pre('Read', { file_path: 'reports/001-existing.md' }, realRoot).status).toBe(0);
    expect(pre('Bash', { command: 'node merge-tracker.mjs' }, realRoot).status).toBe(0);
    expect(pre('Read', { file_path: path.join(realRoot, 'reports', '001-existing.md') }).status).toBe(0);
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
    // Requirement change (SW2-claude-02): with a separate data root, user-layer folders are written there only.
    expect(run('PreToolUse', 'Write', { file_path: path.join(realRoot, 'reports', '009-x.md'), content: 'x' }).status).toBe(2);
    expect(run('PostToolUse', 'Write', { file_path: path.join(dataRoot, 'reports', '009-x.md') }).status).toBe(0);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'files.ndjson'), 'utf8').trim()) as { path: string; abs: string; root: string };
    expect(rec).toMatchObject({ path: 'reports/009-x.md', abs: path.join(dataRoot, 'reports', '009-x.md'), root: 'data' });
    expect(buildAllowedTools(getModePolicy('oferta')!, '/code', '/data')).toEqual(expect.arrayContaining(['Edit(//data/reports/**)']));
    expect(buildAllowedTools(getModePolicy('oferta')!, '/code', '/data')).not.toContain('Edit(//code/reports/**)');
    expect(buildAllowedTools(getModePolicy('oferta')!, '/code', '/code').filter((t) => t.includes('reports/**'))).toHaveLength(1);
  });
  it('pipeline mode may resolve its own inbox rows and log its discards; no other evaluate mode may (SW6-web-a-01)', () => {
    const code = fs.realpathSync(tempDir('cc-pipe-code-'));
    const data = fs.realpathSync(tempDir('cc-pipe-data-'));
    const policyIn = (mode: string) => {
      const dir = fs.realpathSync(tempDir(`cc-pipe-guard-${mode.replace('/', '-')}-`));
      return { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: [...ALWAYS_DENIED_WRITES] }) };
    };
    const write = (p: { dir: string; pf: { file: string; sha256: string } }, file: string) => hookRun(p.dir, p.pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: code, session_id: 's' }).status;
    // modes/pipeline.md moves each finished row to Processed and logs pre-screen discards to data/discard.log.
    for (const mode of ['pipeline', 'de/pipeline']) {
      const pipeline = policyIn(mode);
      for (const rel of ['data/pipeline.md', 'data/discard.log']) expect(write(pipeline, path.join(data, rel)), `${mode} ${rel}`).toBe(0);
      expect(write(pipeline, path.join(data, 'data', 'applications.md')), `${mode} tracker`).toBe(2);
    }
    for (const mode of ['oferta', 'auto-pipeline']) {
      const other = policyIn(mode);
      for (const rel of ['data/pipeline.md', 'data/discard.log']) expect(write(other, path.join(data, rel)), `${mode} ${rel}`).toBe(2);
    }
  });

  it('scan mode may add what it finds to the pipeline, as modes/scan.md step 8 says; discover may not (SW8-web-a-02)', () => {
    const code = fs.realpathSync(tempDir('cc-scan-code-'));
    const data = fs.realpathSync(tempDir('cc-scan-data-'));
    const policyIn = (mode: string) => {
      const dir = fs.realpathSync(tempDir(`cc-scan-guard-${mode}-`));
      return { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: [...ALWAYS_DENIED_WRITES] }) };
    };
    const write = (p: { dir: string; pf: { file: string; sha256: string } }, file: string) => hookRun(p.dir, p.pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: code, session_id: 's' }).status;
    // A found posting is a Pending line in data/pipeline.md and a scan-history row; a private one saves its JD to jds/.
    const adds = ['data/pipeline.md', 'data/scan-history.tsv', 'jds/acme-pm.md'];
    const scan = policyIn('scan');
    for (const rel of [...adds, 'portals.yml']) expect(write(scan, path.join(data, rel)), `scan ${rel}`).toBe(0);
    for (const rel of ['data/applications.md', 'jds/nested/acme.md']) expect(write(scan, path.join(data, rel)), `scan ${rel}`).toBe(2);
    const discover = policyIn('discover');
    for (const rel of adds) expect(write(discover, path.join(data, rel)), `discover ${rel}`).toBe(2);
  });

  /** The guard's answer to a Write of `rel` (relative to the data root) for each mode; 0 allows it, 2 refuses it. */
  function writesFor(modes: string[], rels: string[]): Record<string, number> {
    const code = fs.realpathSync(tempDir('cc-extra-code-'));
    const data = fs.realpathSync(tempDir('cc-extra-data-'));
    const out: Record<string, number> = {};
    for (const mode of modes) {
      const dir = fs.realpathSync(tempDir(`cc-extra-guard-${mode.replace(/\//g, '-')}-`));
      const pf = writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: [...ALWAYS_DENIED_WRITES] });
      for (const rel of rels) out[`${mode} ${rel}`] = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(data, rel), content: 'x' }, cwd: code, session_id: 's' }).status!;
    }
    return out;
  }

  it('titles mode may write portals.yml, the only file modes/titles.md writes; other profile modes may not (R14-claude-L2-01)', () => {
    expect(writesFor(['titles'], ['portals.yml', 'data/applications.md'])).toEqual({ 'titles portals.yml': 0, 'titles data/applications.md': 2 });
    expect(writesFor(['intake'], ['portals.yml'])).toEqual({ 'intake portals.yml': 2 });
  });

  it('apply may update a report in reports/ (modes/apply.md Step 8 and 9.3), and nothing else there or in the tracker (R14-claude-L2-02, R14-claude-1-01)', () => {
    const rels = ['reports/012-acme-platform-2026-10-01.md', 'reports/nested/012-acme.md', 'data/applications.md', 'cv.md'];
    for (const mode of ['apply', 'de/bewerben']) {
      expect(writesFor([mode], rels)).toEqual(Object.fromEntries(rels.map((rel, i) => [`${mode} ${rel}`, i === 0 ? 0 : 2])));
    }
  });

  it('an interview session may record a stated salary figure, as debrief mode does (SW6-web-a-05)', () => {
    const code = fs.realpathSync(tempDir('cc-int-code-'));
    const data = fs.realpathSync(tempDir('cc-int-data-'));
    for (const mode of ['interview/debrief', 'de/interview/debrief', 'interview-prep']) {
      const dir = fs.realpathSync(tempDir(`cc-int-guard-${mode.replace(/\//g, '-')}-`));
      const pf = writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: [...ALWAYS_DENIED_WRITES] });
      const status = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(data, 'data', 'salary-observations.tsv'), content: 'x' }, cwd: code, session_id: 's' }).status;
      expect(status, mode).toBe(0);
    }
  });

  it('with a separate data root, user-layer writes go to the data root only and custom/** and templates to the code root only (SW2-claude-02)', () => {
    const code = fs.realpathSync(tempDir('cc-split-code-'));
    const data = fs.realpathSync(tempDir('cc-split-data-'));
    const policyIn = (mode: string) => {
      const dir = fs.realpathSync(tempDir(`cc-split-guard-${mode.replace('/', '-')}-`));
      return { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: mode === 'devchat' ? [...DEVCHAT_DENIED_WRITES] : [...ALWAYS_DENIED_WRITES] }) };
    };
    const write = (p: { dir: string; pf: { file: string; sha256: string } }, file: string) => hookRun(p.dir, p.pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: code, session_id: 's' }).status;
    const oferta = policyIn('oferta');
    expect(write(oferta, path.join(data, 'reports', '012-x.md'))).toBe(0);
    for (const rel of ['reports/012-x.md', 'batch/tracker-additions/012-x.tsv', 'jds/x.md', 'output/x.pdf']) expect(write(oferta, path.join(code, rel)), rel).toBe(2);
    // A relative path resolves against the session cwd, the code root.
    expect(write(oferta, 'reports/012-x.md')).toBe(2);
    const devchat = policyIn('devchat');
    for (const rel of ['cv.md', 'modes/_custom.md', 'data/notes/x.md', 'reports/x.md']) {
      expect(write(devchat, path.join(data, rel)), `data ${rel}`).toBe(0);
      expect(write(devchat, path.join(code, rel)), `code ${rel}`).toBe(2);
    }
    expect(write(devchat, path.join(code, 'custom', 'projects', 'lib.mjs'))).toBe(0);
    expect(write(devchat, path.join(data, 'custom', 'projects', 'lib.mjs'))).toBe(2);
    const pdf = policyIn('pdf');
    expect(write(pdf, path.join(code, 'templates', 'cv-mine.html'))).toBe(0);
    expect(write(pdf, path.join(data, 'templates', 'cv-mine.html'))).toBe(2);
    expect(write(pdf, path.join(data, 'output', 'x.pdf'))).toBe(0);
    // Scripts' output arguments follow the same split.
    const bash = { codeRoot: code, dataRoot: data, allow: getModePolicy('pdf')!.writeGlobs, deny: [...ALWAYS_DENIED_WRITES], bash: getModePolicy('pdf')!.bashPrefixes };
    fs.mkdirSync(path.join(data, 'output'), { recursive: true });
    expect(checkBash('node generate-pdf.mjs output/x.html output/x.pdf', bash, code)).toMatch(/outside the write scope/);
    expect(checkBash(`node generate-pdf.mjs ${data}/output/x.html ${data}/output/x.pdf`, bash, code)).toBeNull();
    // The CLI's own Edit rules carry the same split.
    const tools = buildAllowedTools(getModePolicy('devchat')!, code, data);
    expect(tools).toEqual(expect.arrayContaining([`Edit(/${data}/reports/**)`, `Edit(/${data}/cv.md)`, `Edit(/${code}/custom/**)`]));
    for (const t of [`Edit(/${code}/reports/**)`, `Edit(/${code}/cv.md)`, `Edit(/${data}/custom/**)`]) expect(tools).not.toContain(t);
  });

  it('a documents session (pdf, text, latex, latex-tex, cover) can save the JD its mode needs as jds/<slug>.md, in the data root, and nothing else there (SW3-libs-01)', () => {
    const code = fs.realpathSync(tempDir('cc-jd-code-'));
    const data = fs.realpathSync(tempDir('cc-jd-data-'));
    for (const mode of ['pdf', 'text', 'latex', 'latex-tex', 'cover']) {
      const dir = fs.realpathSync(tempDir(`cc-jd-guard-${mode}-`));
      const pf = writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)!, deny: [...ALWAYS_DENIED_WRITES] });
      const write = (file: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: code, session_id: 's' }).status;
      expect(write(path.join(data, 'jds', 'acme-backend.md')), mode).toBe(0);
      expect(write(path.join(code, 'jds', 'acme-backend.md')), `${mode} code root`).toBe(2);
      expect(write(path.join(data, 'jds', 'acme', 'nested.md')), `${mode} nested`).toBe(2);
      expect(write(path.join(data, 'jds', 'acme.pdf')), `${mode} pdf`).toBe(2);
      expect(buildAllowedTools(getModePolicy(mode)!, code, data), mode).toContain(`Edit(/${data}/jds/*.md)`);
    }
  });

  it('the app\'s immigration policy pass writes only its three output files, as the daily job\'s pass does (SW7-scripts-02): never the job state', () => {
    const code = fs.realpathSync(tempDir('cc-imm-code-'));
    const data = fs.realpathSync(tempDir('cc-imm-data-'));
    const dir = fs.realpathSync(tempDir('cc-imm-guard-'));
    const pf = writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy('immigration-policy')!, deny: [...ALWAYS_DENIED_WRITES] });
    const write = (rel: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(data, rel), content: 'x' }, cwd: code, session_id: 's' }).status;
    for (const rel of ['data/immigration/policy-changes.tsv', 'data/immigration/company-alerts.tsv', 'data/immigration/policy-digest.md']) expect(write(rel), rel).toBe(0);
    for (const rel of ['data/immigration/pending.json', 'data/immigration/seen.json', 'data/immigration/companies/acme.md', 'data/immigration/batches/2026-10-06.json', 'data/immigration/.run-daily.pid', 'data/immigration/policy-digest.md.bak']) expect(write(rel), rel).toBe(2);
    expect(getModePolicy('immigration-policy')!.writeGlobs).toEqual(['data/immigration/policy-changes.tsv', 'data/immigration/company-alerts.tsv', 'data/immigration/policy-digest.md']);
  });

  it('every policy gets the split, one written by the daily job or before this change included (SW2-claude-02)', () => {
    const code = fs.realpathSync(tempDir('cc-split-old-code-'));
    const data = fs.realpathSync(tempDir('cc-split-old-data-'));
    const dir = fs.realpathSync(tempDir('cc-split-old-guard-'));
    // The daily job's policy pass writes its policy itself (run-daily.sh): data/immigration/** and nothing else.
    const bytes = JSON.stringify({ codeRoot: code, dataRoot: data, sessionDir: dir, allow: ['data/immigration/**'], deny: [], bash: [], playwright: false, readDeny: [...READ_DENY], readOnlyRoots: [], allowsAgent: false, search: true });
    fs.writeFileSync(path.join(dir, 'policy.json'), bytes);
    const pf = { file: path.join(dir, 'policy.json'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const write = (file: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: code, session_id: 's' }).status;
    expect(write(path.join(data, 'data', 'immigration', 'digest.md'))).toBe(0);
    const out = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(code, 'data', 'immigration', 'digest.md'), content: 'x' }, cwd: code, session_id: 's' });
    expect(out.status).toBe(2);
    // The refusal says where the file belongs.
    expect(out.stderr).toContain(`so write ${path.join(data, 'data', 'immigration', 'digest.md')}`);
  });

  it('denies writes outside the scope, outside the code root, and always the blacklist and the tracker', () => {
    const out = pre('Write', { file_path: path.join(realRoot, 'cv.md'), content: 'x' });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/cv\.md is outside the write scope/);
    expect(pre('Write', { file_path: '/etc/hosts', content: 'x' }).status).toBe(2);
    expect(pre('Write', { file_path: path.join(realRoot, 'data', 'blacklist.md'), content: 'x' }).status).toBe(2);
    expect(pre('Edit', { file_path: path.join(realRoot, 'data', 'applications.md'), old_string: 'a', new_string: 'b' }).status).toBe(2);
    expect(pre('MultiEdit', { file_path: path.join(realRoot, 'reports', '..', 'cv.md'), edits: [] }).status).toBe(2);
  });
  it('a Write through a dangling link goes where the link points: outside the roots it is refused and nothing is created (SW2-tests-04)', () => {
    const outside = fs.realpathSync(tempDir('cc-hook-dangling-'));
    // A file link, a folder link and a chain whose last hop leaves the roots, none of whose targets exist yet.
    fs.symlinkSync(path.join(outside, 'new.md'), path.join(realRoot, 'reports', 'dangling.md'));
    fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(realRoot, 'reports', 'dangling-dir'));
    fs.symlinkSync(path.join(realRoot, 'reports', 'hop.md'), path.join(realRoot, 'reports', 'chain.md'));
    fs.symlinkSync(path.join(outside, 'chained.md'), path.join(realRoot, 'reports', 'hop.md'));
    for (const file of ['dangling.md', 'dangling-dir/x.md', 'chain.md']) {
      const out = pre('Write', { file_path: path.join(realRoot, 'reports', file), content: 'x' });
      expect(out.status, file).toBe(2);
      expect(out.stderr, file).toMatch(/outside the repo and data roots/);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    // A dangling link whose target is inside the write scope is written like that target.
    fs.symlinkSync(path.join(realRoot, 'reports', '003-later.md'), path.join(realRoot, 'reports', 'inside-link.md'));
    expect(pre('Write', { file_path: path.join(realRoot, 'reports', 'inside-link.md'), content: 'x' }).status).toBe(0);
    // A loop of links leads nowhere that can be checked: refused.
    fs.symlinkSync(path.join(realRoot, 'reports', 'loop-b.md'), path.join(realRoot, 'reports', 'loop-a.md'));
    fs.symlinkSync(path.join(realRoot, 'reports', 'loop-a.md'), path.join(realRoot, 'reports', 'loop-b.md'));
    expect(pre('Write', { file_path: path.join(realRoot, 'reports', 'loop-a.md'), content: 'x' }).status).toBe(2);
  });
  it('refuses a write path with a .. segment or a leading ~: after a symlink the kernel resolves .. against its target, not on paper', () => {
    const outside = fs.realpathSync(tempDir('cc-hook-outside-'));
    fs.mkdirSync(path.join(outside, 'inner'));
    fs.symlinkSync(path.join(outside, 'inner'), path.join(realRoot, 'link-out'));
    // On paper this is reports/002-x.md, in scope; opened as written it lands in <outside>/reports/.
    for (const [tool, input] of [
      ['Write', { file_path: `${realRoot}/link-out/../reports/002-x.md`, content: 'x' }],
      ['Edit', { file_path: `${realRoot}/link-out/../reports/001-existing.md`, old_string: 'old', new_string: 'new' }],
      ['MultiEdit', { file_path: `${realRoot}/reports/../reports/001-existing.md`, edits: [] }],
      ['NotebookEdit', { notebook_path: `${realRoot}/link-out/../reports/n.ipynb`, new_source: 'x' }],
      ['Write', { file_path: 'link-out/../reports/002-x.md', content: 'x' }],
      ['Write', { file_path: '~/reports/002-x.md', content: 'x' }],
    ] as const) {
      const out = pre(tool, input);
      expect(out.status, JSON.stringify(input)).toBe(2);
      expect(out.stderr).toMatch(/has a \.\. segment|starts with ~/);
    }
    expect(fs.existsSync(path.join(outside, 'reports'))).toBe(false);
    expect(pre('Write', { file_path: path.join(realRoot, 'reports', '002-x.md'), content: 'x' }).status).toBe(0);
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
  it('a batch-mode turn: the hook refuses batch-runner.sh and the settings grant no Bash rule for it', () => {
    const dir = path.join(realRoot, 'session-batch');
    fs.mkdirSync(dir);
    const batch = getModePolicy('batch')!;
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: batch });
    const out = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'bash batch/batch-runner.sh --parallel 2' }, cwd: realRoot, session_id: 's' });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/starts agent CLIs outside the session guard/);
    const allow = buildPermissions({ policy: batch, codeRoot: '/code', dataRoot: '/data', guardRoot: '/guard' }).allow;
    expect(allow.filter((r) => r.startsWith('Bash('))).toEqual(expect.arrayContaining(['Bash(node reconcile-pipeline.mjs:*)']));
    expect(allow.some((r) => r.includes('batch-runner') || r.includes('rank-pipeline'))).toBe(false);
  });
  it('denies Playwright clicks that look like a submit', () => {
    const dir = path.join(realRoot, 'session-apply');
    fs.mkdirSync(dir);
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: getModePolicy('apply')! });
    const pw = (name: string, input: Record<string, unknown>) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: `mcp__playwright__${name}`, tool_input: input, cwd: realRoot, session_id: 's' }).status;
    expect(pw('browser_click', { element: 'Submit application button', ref: 'e12' })).toBe(2);
    expect(pw('browser_click', { element: 'Next page', ref: 'e13' })).toBe(0);
    // Requirement change (SW-claude-10): the inputs are the pinned @playwright/mcp 0.0.41 shapes; press_key carries only the key.
    expect(pw('browser_press_key', { key: 'Enter' })).toBe(2);
  });
  it('routes every Playwright tool to the guard and refuses those that can submit, run page code, leave the public web or upload secrets (SW-claude-10)', () => {
    const dir = path.join(realRoot, 'session-playwright');
    fs.mkdirSync(dir);
    const pf = writePolicyFile(dir, { codeRoot: realRoot, policy: getModePolicy('apply')! });
    const pw = (name: string, input: Record<string, unknown>, which = pf) => hookRun(dir, which, { hook_event_name: 'PreToolUse', tool_name: `mcp__playwright__${name}`, tool_input: input, cwd: realRoot, session_id: 's' });
    const refused: Array<[string, Record<string, unknown>]> = [
      ['browser_click', { ref: 'e14' }],
      ['browser_press_key', { key: 'NumpadEnter' }],
      ['browser_press_key', { key: 'Control+Enter' }],
      ['browser_type', { element: 'Email', ref: 'e3', text: 'me@example.com', submit: true }],
      ['browser_type', { element: 'Why us', ref: 'e4', text: 'First line\nSecond line', slowly: true }],
      ['browser_evaluate', { function: '() => document.forms[0].submit()' }],
      ['browser_evaluate', { function: '() => document.title' }],
      ['browser_navigate', { url: 'file:///etc/passwd' }],
      ['browser_navigate', { url: 'http://127.0.0.1:4317/' }],
      ['browser_navigate', { url: 'http://169.254.169.254/latest/meta-data' }],
      ['browser_file_upload', { paths: ['/etc/passwd'] }],
      ['browser_file_upload', { paths: [path.join(realRoot, 'output', 'cv.pdf'), path.join(realRoot, '.env')] }],
      ['browser_take_screenshot', { filename: '/tmp/cc-shot.png' }],
      ['browser_snapshot', { filename: 'snap.md' }],
      ['browser_tabs', { action: 'new', url: 'http://10.0.0.1/' }],
      ['browser_run_code_unsafe', { code: 'async (page) => page.title()' }],
      ['browser_mouse_click_xy', { element: 'Submit', x: 10, y: 10 }],
      // Space activates a focused button as Enter does (SW-claude-10 review): press_key takes only keys that activate nothing.
      ['browser_press_key', { key: ' ' }],
      ['browser_press_key', { key: 'Space' }],
      ['browser_press_key', { key: 'Spacebar' }],
      ['browser_press_key', { key: 'Shift+Space' }],
      ['browser_press_key', { key: 'Meta+Enter' }],
      ['browser_press_key', { key: 'Alt+s' }],
      ['browser_press_key', { key: 'F5' }],
      ['browser_press_key', { key: '' }],
      ['browser_press_key', {}],
      // Typed slowly, each character is a key press on the focused element: a space (or a tab that moves to a button, then
      // a space) submits; the guard cannot see which element a ref names, so slow typing takes no whitespace at all.
      ['browser_type', { element: 'Email', ref: 'e3', text: ' ', slowly: true }],
      ['browser_type', { element: 'Email', ref: 'e3', text: 'two words', slowly: true }],
      ['browser_type', { element: 'Email', ref: 'e3', text: 'a\t ', slowly: true }],
      // A drag that starts and ends on the submit button is a click on it.
      ['browser_drag', { startElement: 'Submit application button', startRef: 'e9', endElement: 'Submit application button', endRef: 'e9' }],
      ['browser_drag', { startElement: 'Name field', startRef: 'e2', endElement: 'Apply now', endRef: 'e9' }],
      ['browser_drag', { startRef: 'e9', endRef: 'e9' }],
    ];
    for (const [name, input] of refused) expect(pw(name, input).status, `${name} ${JSON.stringify(input)}`).toBe(2);
    const allowed: Array<[string, Record<string, unknown>]> = [
      ['browser_snapshot', {}],
      ['browser_press_key', { key: 'Tab' }],
      ['browser_press_key', { key: 'Shift+Tab' }],
      ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'a', 'Z', '7', '@', 'é'].map((key): [string, Record<string, unknown>] => ['browser_press_key', { key }]),
      // fill (not slowly) sends no key presses, and Playwright refuses to fill a button or a submit input.
      ['browser_type', { element: 'Why us', ref: 'e4', text: 'two words' }],
      ['browser_type', { element: 'Email', ref: 'e3', text: 'acme', slowly: true }],
      ['browser_drag', { startElement: 'Card A', startRef: 'e5', endElement: 'Card B', endRef: 'e6' }],
      ['browser_type', { element: 'Email', ref: 'e3', text: 'me@example.com' }],
      ['browser_type', { element: 'Why us', ref: 'e4', text: 'First line\nSecond line' }],
      ['browser_fill_form', { fields: [{ name: 'Name', type: 'textbox', ref: 'e2', value: 'Ada' }] }],
      ['browser_select_option', { element: 'Country', ref: 'e5', values: ['Canada'] }],
      ['browser_navigate', { url: 'https://93.184.215.14/jobs/1' }],
      ['browser_file_upload', { paths: [path.join(realRoot, 'output', 'cv.pdf')] }],
      ['browser_take_screenshot', {}],
      ['browser_wait_for', { time: 1 }],
      ['browser_tabs', { action: 'list' }],
    ];
    for (const [name, input] of allowed) expect(pw(name, input).status, `${name} ${JSON.stringify(input)}`).toBe(0);
    // These are the tool shapes of the pinned MCP version; a version change needs this guard re-read.
    expect(JSON.parse(fs.readFileSync(PLAYWRIGHT_MCP_PATH, 'utf8')).mcpServers.playwright.args).toContain('@playwright/mcp@0.0.41');
    // A session whose policy grants no Playwright gets none of it, whatever the tool.
    expect(pw('browser_snapshot', {}, policy).status).toBe(2);
    // The settings route every Playwright tool to the hook through a second group; the probed matcher stays as recorded.
    const settings = JSON.parse(fs.readFileSync(writeSettingsFile(path.join(dir, 'settings')), 'utf8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    const groups = settings.hooks.PreToolUse.map((g) => g.matcher);
    expect(groups[0]).toBe(PRE_TOOL_MATCHER);
    expect(groups).toHaveLength(2);
    const playwright = new RegExp(groups[1]!);
    for (const name of ['mcp__playwright__browser_evaluate', 'mcp__playwright__browser_navigate', 'mcp__playwright__anything_new']) expect(playwright.test(name), name).toBe(true);
    for (const name of ['Bash', 'Write', 'mcp__other__browser_click', 'x_mcp__playwright__y']) expect(playwright.test(name), name).toBe(false);
  });
  it('protects Blacklist.md, APPLICATIONS.md and Supervisor/ in any case, on a case-insensitive or a case-sensitive volume', () => {
    const root = fs.realpathSync(tempDir('cc-hook-case-'));
    const folding = foldsCase(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'blacklist.md'), '# blacklist\n');
    fs.mkdirSync(path.join(root, 'custom', 'control-center', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(root, 'custom', 'control-center', 'supervisor', 'index.ts'), 'ok\n');
    const dir = path.join(root, 'guard');
    const pf = writePolicyFile(dir, { codeRoot: root, policy: getModePolicy('devchat')!, deny: [...DEVCHAT_DENIED_WRITES] });
    const write = (p: string, tool = 'Write') => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: p, content: 'x' }, cwd: root, session_id: 's' });
    const viaCase = write(path.join(root, 'data', 'Blacklist.md'));
    expect(viaCase.status, viaCase.stderr).toBe(2);
    if (folding) {
      // The same file reached through a different case: realpath.native returns the on-disk case.
      expect(viaCase.stderr).toMatch(/data\/blacklist\.md is always protected/);
    } else {
      // A different (not yet existing) file: its path keeps the caller's case, and the deny globs compare case-insensitively.
      expect(viaCase.stderr).toMatch(/data\/Blacklist\.md is always protected/);
      expect(fs.existsSync(path.join(root, 'data', 'Blacklist.md'))).toBe(false);
    }
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
    const spaced = fs.realpathSync(tempDir('cc hook space '));
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
    const root = fs.realpathSync(tempDir('cc-hook-devchat-'));
    const dir = fs.realpathSync(tempDir('cc-hook-devchat-guard-'));
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

  it('Dev Chat cannot write any custom test suite, the shared test helpers or the installer: they run outside any guard (SW2-libs-01, SW2-tests-17)', () => {
    const root = fs.realpathSync(tempDir('cc-hook-devchat-suites-'));
    const dir = fs.realpathSync(tempDir('cc-hook-devchat-suites-guard-'));
    const pf = writePolicyFile(dir, { codeRoot: root, policy: getModePolicy('devchat')!, deny: [...DEVCHAT_DENIED_WRITES] });
    const hook = (rel: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, rel), content: 'x' }, cwd: root, session_id: 's' });
    // The bulk of the files is checked in-process with the hook's own write check, against the policy file it loads: one
    // hook process per file grew with every new test file toward the test timeout (SW5-tests-16).
    const policy = JSON.parse(fs.readFileSync(pf.file, 'utf8')) as Parameters<typeof checkWrite>[0];
    const why = (rel: string) => checkWrite(policy, 'Write', path.join(root, rel));
    // The real files of this checkout: install.sh and upstream-sync run `node --test custom/*/tests/*.spec.mjs`, and every
    // spec imports custom/test-support.
    const custom = path.join(PACKAGE_ROOT, '..');
    // node_modules is never entered: Vite creates and removes its deps_temp folders there while other suites run.
    const walk = (rel: string): string[] => fs.readdirSync(path.join(custom, rel), { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules') return [];
      const child = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(child) : e.isFile() ? [`custom/${child}`] : [];
    });
    const files = walk('');
    const suites = files.filter((f) => /^custom\/[^/]+\/tests\//.test(f) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(f) || f.startsWith('custom/test-support/') || f.startsWith('custom/install/'));
    const musts = ['custom/test-support/tmp.mjs', 'custom/install/install.sh', 'custom/install/bootstrap.sh', 'custom/projects/tests/rank.spec.mjs'];
    for (const must of musts) expect(suites, must).toContain(must);
    expect(suites.length).toBeGreaterThan(20);
    for (const rel of suites) expect(why(rel), rel).toMatch(/^Write: .* is always protected/);
    // The hook process refuses them with that same reason.
    for (const must of musts) {
      const r = hook(must);
      expect(r.status, must).toBe(2);
      expect(r.stderr.trim(), must).toBe(why(must));
    }
    // The custom modules those suites test stay Dev Chat's to edit.
    for (const rel of ['custom/projects/lib.mjs', 'custom/cv/build-html.mjs', 'custom/pipeline/shortlist.mjs', 'custom/immigration/freshness.mjs']) {
      expect(files, rel).toContain(rel);
      expect(why(rel), rel).toBeNull();
      expect(hook(rel).status, rel).toBe(0);
    }
  });

  it('Dev Chat cannot write any file the supervisor loads at startup, so a bad edit never stops /__recovery (SW2-claude-05)', () => {
    const root = fs.realpathSync(tempDir('cc-hook-devchat-supervisor-'));
    const dir = fs.realpathSync(tempDir('cc-hook-devchat-supervisor-guard-'));
    const pf = writePolicyFile(dir, { codeRoot: root, policy: getModePolicy('devchat')!, deny: [...DEVCHAT_DENIED_WRITES] });
    const write = (rel: string) => hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(root, rel), content: 'x' }, cwd: root, session_id: 's' }).status;
    // Static and dynamic imports alike: running editable code at all lets it hang or kill the supervisor (SW2-claude-05 review).
    const STATIC = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    const seen = new Set<string>();
    const stack = ['supervisor/index.ts', 'supervisor/preflight-cli.ts'].map((f) => path.join(PACKAGE_ROOT, f));
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (file.endsWith('.json')) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(STATIC)) {
        const spec = path.resolve(path.dirname(file), (m[1] ?? m[2] ?? m[3])!);
        const found = [spec, spec.replace(/\.js$/, '.ts'), spec.replace(/\.js$/, '.tsx'), `${spec}.ts`].find((f) => fs.existsSync(f));
        expect(found, `${file} imports ${spec}`).toBeDefined();
        stack.push(found!);
      }
    }
    const loaded = [...seen].map((f) => `custom/control-center/${path.relative(PACKAGE_ROOT, f).split(path.sep).join('/')}`).sort();
    expect(loaded).toEqual(expect.arrayContaining(['custom/control-center/supervisor/recovery.ts', 'custom/control-center/server/claude/guard-policy.mjs']));
    for (const rel of loaded) expect(write(rel), rel).toBe(2);
    // server/core holds contract.json, whose claude.approvedVersions is the confinement gate: never Dev Chat's to change.
    expect(write('custom/control-center/server/core/contract.json')).toBe(2);
    expect(write('custom/control-center/server/core/adapter.ts')).toBe(2);
  });

  it('a tampered or unverifiable policy fails closed for every tool call', () => {
    const dir = fs.realpathSync(tempDir('cc-hook-tamper-'));
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

describe('guard hook: read confinement', () => {
  const base = fs.realpathSync(tempDir('cc-hook-read-'));
  const code = path.join(base, 'code');
  const data = path.join(base, 'data');
  const outside = path.join(base, 'outside');
  for (const d of [code, data, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(code, 'cv.md'), 'cv\n');
  fs.writeFileSync(path.join(code, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(outside, 's.txt'), 'outside\n');
  const guardDir = (name: string) => {
    const d = path.join(base, 'guard', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const evaluate = (() => {
    const dir = guardDir('oferta');
    return { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy('oferta')! }) };
  })();
  const pre = (tool: string, input: Record<string, unknown>, which = evaluate) => hookRun(which.dir, which.pf, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: code, session_id: 's' });

  it('Read outside the roots, of a secret file, or through ~ exits 2; a read inside a root exits 0', () => {
    expect(pre('Read', { file_path: path.join(code, 'cv.md') }).status).toBe(0);
    const out = pre('Read', { file_path: path.join(outside, 's.txt') });
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/outside the repo and data roots/);
    expect(pre('Read', { file_path: path.join(code, '.env') }).status).toBe(2);
    expect(pre('Read', { file_path: '~/.ssh/id_ed25519' }).status).toBe(2);
    expect(pre('Read', {}).status).toBe(2);
  });

  it('Glob and Grep inside the roots exit 0; outside, or with a pattern that climbs out, exit 2', () => {
    expect(pre('Glob', { pattern: '**/*.md', path: code }).status).toBe(0);
    expect(pre('Grep', { pattern: 'Score', path: data, glob: '*.md' }).status).toBe(0);
    expect(pre('Glob', { pattern: '*', path: outside }).status).toBe(2);
    expect(pre('Glob', { pattern: '../outside/*', path: code }).status).toBe(2);
    expect(pre('Grep', { pattern: 'x', glob: '{/etc,a}/*' }).status).toBe(2);
  });

  it('WebFetch of file:, of a loopback address, or of a name that does not resolve exits 2; a public literal address exits 0', () => {
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1:1/', 'http://localhost/', 'http://[::1]/', 'https://nothing.invalid/']) {
      const r = pre('WebFetch', { url, prompt: 'x' });
      expect(r.status, url).toBe(2);
    }
    expect(pre('WebFetch', { url: 'https://nothing.invalid/', prompt: 'x' }).stderr).toMatch(/could not resolve/);
    expect(pre('WebFetch', { url: 'https://93.184.216.34/', prompt: 'x' }).status).toBe(0);
    // Names go through the DNS check: one that resolves to a private address, or to any loopback one, is refused.
    expect(pre('WebFetch', { url: 'https://private.test/', prompt: 'x' }).stderr).toMatch(/private\.test resolves to 10\.0\.0\.7/);
    expect(pre('WebFetch', { url: 'https://mixed.test/', prompt: 'x' }).stderr).toMatch(/mixed\.test resolves to 127\.0\.0\.1/);
    expect(pre('WebFetch', { url: 'https://public.test/jobs/1', prompt: 'x' }).status).toBe(0);
  });

  it('a Bash script URL argument goes through the same DNS check', () => {
    expect(pre('Bash', { command: 'node check-liveness.mjs https://nothing.invalid/x' }).stderr).toMatch(/could not resolve/);
    expect(pre('Bash', { command: 'node check-liveness.mjs https://93.184.216.34/x' }).status).toBe(0);
    expect(pre('Bash', { command: 'node check-liveness.mjs https://private.test/x' }).stderr).toMatch(/resolves to 10\.0\.0\.7/);
    expect(pre('Bash', { command: 'node check-liveness.mjs https://public.test/x' }).status).toBe(0);
    expect(pre('Bash', { command: 'node check-liveness.mjs file:///etc/passwd' }).status).toBe(2);
  });

  it('a Bash command naming more than 4 hosts exits 2 before any lookup', () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.nothing.invalid/x`).join(' ');
    const r = pre('Bash', { command: `node check-liveness.mjs ${urls}` });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/5 different hosts/);
  });

  it('names the files the audited scripts read URLs from, in both flag forms', () => {
    expect(urlListFilesIn('node check-liveness.mjs --file output/urls.txt')).toEqual([{ file: 'output/urls.txt', format: 'lines' }]);
    expect(urlListFilesIn('node check-liveness.mjs --file=output/urls.txt')).toEqual([{ file: 'output/urls.txt', format: 'lines' }]);
    expect(urlListFilesIn('node verify-portals.mjs --file alt.yml --strict')).toEqual([{ file: 'alt.yml', format: 'text' }]);
    expect(urlListFilesIn('node audit-portals.mjs --summary --file=alt.yml')).toEqual([{ file: 'alt.yml', format: 'text' }]);
    expect(urlListFilesIn('node discover-ats.mjs --in companies.yml --summary')).toEqual([{ file: 'companies.yml', format: 'text' }]);
    expect(urlListFilesIn('node check-liveness.mjs https://jobs.example.com/1')).toEqual([]);
    expect(urlListFilesIn('node merge-tracker.mjs --file x')).toEqual([]);
    expect(URL_LIST_MAX_BYTES).toBe(256 * 1024);
  });

  it('check-liveness --file: the URLs inside the list file get the same checks as URL arguments', () => {
    const list = (name: string, text: string) => {
      fs.writeFileSync(path.join(code, name), text);
      return name;
    };
    const liveness = (file: string) => pre('Bash', { command: `node check-liveness.mjs --file ${file}` });
    const loopback = liveness(list('loopback.txt', '# one posting\nhttps://93.184.216.34/jobs/1\nhttp://127.0.0.1/\n'));
    expect(loopback.status).toBe(2);
    expect(loopback.stderr).toMatch(/127\.0\.0\.1/);
    expect(pre('Bash', { command: `node check-liveness.mjs --file=${list('inline.txt', 'http://169.254.169.254/latest\n')}` }).status).toBe(2);
    expect(liveness(list('public.txt', '# public postings\nhttps://93.184.216.34/jobs/1\n\nhttps://93.184.216.34/jobs/2\nhttps://8.8.8.8/x\n')).status).toBe(0);
    expect(liveness(list('scheme.txt', 'file:///etc/passwd\n')).stderr).toMatch(/not an http/);
    expect(liveness(list('word.txt', 'https://93.184.216.34/a\nnot-a-url\n')).stderr).toMatch(/not an http/);
    expect(liveness(list('dns.txt', 'https://nothing.invalid/x\n')).stderr).toMatch(/could not resolve/);
    expect(liveness(list('private-name.txt', 'https://public.test/1\nhttps://private.test/2\n')).stderr).toMatch(/resolves to 10\.0\.0\.7/);
    expect(liveness(list('public-name.txt', 'https://public.test/1\n')).status).toBe(0);
    expect(liveness(list('big.txt', `https://93.184.216.34/${'x'.repeat(URL_LIST_MAX_BYTES)}\n`)).stderr).toMatch(/larger than/);
    expect(liveness('missing.txt').stderr).toMatch(/cannot read/);
    expect(liveness(path.join(outside, 's.txt')).status).toBe(2);
  });

  it('verify-portals --file, audit-portals --file and discover-ats --in: every URL in the YAML is checked', () => {
    const policyFor = (mode: string) => {
      const dir = guardDir(mode);
      return { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy(mode)! }) };
    };
    // Each script under the mode that runs it, so a refusal can only come from the URL check.
    const scan = policyFor('scan');
    const discover = policyFor('discover');
    const yml = (name: string, text: string) => {
      fs.writeFileSync(path.join(code, name), text);
      return name;
    };
    const bad = yml('bad.yml', 'tracked_companies:\n  - name: Acme\n    careers_url: http://169.254.169.254/latest\n');
    const good = yml('good.yml', 'tracked_companies:\n  - name: Acme\n    careers_url: https://93.184.216.34/careers\n    about: plain text\n');
    const local = yml('local.yml', 'companies:\n  - name: Acme\n    workday: file:///etc/passwd\n');
    const run = (cmd: string) => pre('Bash', { command: cmd }, cmd.includes('discover-ats') ? discover : scan);
    for (const cmd of [`node verify-portals.mjs --file ${good}`, `node audit-portals.mjs --file=${good}`, `node discover-ats.mjs --in ${good}`]) expect(run(cmd).status, cmd).toBe(0);
    for (const cmd of [`node verify-portals.mjs --file ${bad}`, `node audit-portals.mjs --file=${bad}`, `node discover-ats.mjs --in ${bad}`]) expect(run(cmd).stderr, cmd).toMatch(/169\.254\.169\.254/);
    expect(run(`node discover-ats.mjs --in ${local}`).stderr).toMatch(/file: URLs/);
  });

  it('PowerShell always exits 2', () => {
    const r = pre('PowerShell', { command: 'Get-Content ~/.ssh/id_rsa' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PowerShell/);
  });

  it('Agent and Task exit 2 unless the policy allows subagents', () => {
    expect(pre('Agent', { description: 'x', prompt: 'read things' }).status).toBe(2);
    expect(pre('Task', { description: 'x', prompt: 'read things' }).status).toBe(2);
    const dir = guardDir('hm-audit');
    const audit = { dir, pf: writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy('pdf/hm-audit')! }) };
    expect(pre('Agent', { description: 'x', prompt: 'audit' }, audit).status).toBe(0);
    expect(pre('Task', { description: 'x', prompt: 'audit' }, audit).status).toBe(0);
  });

  it('a policy written before read confinement refuses every tool call', () => {
    const dir = guardDir('old');
    const bytes = JSON.stringify({ codeRoot: code, dataRoot: data, sessionDir: dir, allow: ['reports/**'], deny: [...ALWAYS_DENIED_WRITES], bash: [], playwright: false });
    fs.writeFileSync(path.join(dir, 'policy.json'), bytes);
    const old = { dir, pf: { file: path.join(dir, 'policy.json'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
    for (const [tool, input] of [['Read', { file_path: path.join(code, 'cv.md') }], ['Write', { file_path: path.join(code, 'reports', 'x.md'), content: 'x' }], ['Bash', { command: 'node merge-tracker.mjs' }]] as const) {
      const r = pre(tool, input, old);
      expect(r.status, tool).toBe(2);
      expect(r.stderr).toMatch(/predates read confinement/);
    }
  });

  it('the settings file gives every hook a 30 second timeout and routes the read, search, fetch and agent tools to it', () => {
    const file = writeSettingsFile(guardDir('settings'));
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ timeout?: number }> }>> };
    const groups = Object.values(settings.hooks).flat();
    for (const h of groups.flatMap((g) => g.hooks)) expect(h.timeout).toBe(30);
    const matcher = settings.hooks.PreToolUse![0]!.matcher.split('|');
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'Agent', 'Task', 'PowerShell', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(matcher, tool).toContain(tool);
  });
});

describe('checkBash: exact per-command argument grammars', () => {
  const root = fs.realpathSync(tempDir('cc-bash-'));
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

  it('refuses a word starting with = (zsh expands =curl to the path of curl) in a command the policy otherwise allows, saying so (SW5-tests-04)', () => {
    ok(oferta, 'node merge-tracker.mjs');
    expect(checkBash('node merge-tracker.mjs =curl', oferta, root)).toMatch(/words starting with = are not allowed/);
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

  it('declared flags are exempt from the output-flag rule whatever their role, and documented switches are accepted', () => {
    const interview = { codeRoot: root, dataRoot: root, allow: ['interview-prep/**'], deny: [...ALWAYS_DENIED_WRITES], bash: [['node', 'weekly-digest.mjs']] };
    // weekly-digest --dir only reads a sessions directory (role input).
    ok(interview, 'node weekly-digest.mjs --dir interview-prep/sessions --summary');
    ok(interview, 'node weekly-digest.mjs --dir=interview-prep/sessions --from 2026-09-28 --to 2026-10-04');
    no(interview, 'node weekly-digest.mjs --dir /tmp/elsewhere');
    const scan = { codeRoot: root, dataRoot: root, allow: ['portals.yml'], deny: [...ALWAYS_DENIED_WRITES], bash: [['node', 'discover-new-companies.mjs']] };
    ok(scan, 'node discover-new-companies.mjs --summary');
    ok(scan, 'node discover-new-companies.mjs --json --since 7 --limit 20');
    no(scan, 'node discover-new-companies.mjs --out data/new.yml');
  });

  it('application-answers --report: the section is written only inside the write scope; --read and --read-draft only read the report', () => {
    const apply = { ...policyFor('apply', [...ALWAYS_DENIED_WRITES]), readDeny: [...READ_DENY] };
    ok(apply, 'node application-answers.mjs --report output/r.md --input output/a.json --state filled --date 2026-10-05');
    ok(apply, 'node application-answers.mjs --input output/a.json --report output/r.md');
    // The review trigger: the script appends the answers it is given to whatever file --report names.
    for (const target of ['modes/_custom.md', 'modes/_shared.md', 'AGENTS.md', 'cv.md', 'config/profile.yml', 'custom/control-center/server/claude/guard-hook.mjs', 'reports/nested/001-acme.md', 'data/applications.md', '../outside.md', '/etc/hosts'])
      no(apply, `node application-answers.mjs --report ${target} --input output/a.json --state filled`);
    // The matched report itself is in scope: modes/apply.md Step 8 and 9.3 upsert its ## Application Answers section (R14-claude-1-01).
    ok(apply, 'node application-answers.mjs --report reports/001-acme.md --input output/a.json --state filled');
    // Its parser takes the next token as the value even when it starts with a single dash, and path.resolve drops -x/..
    no(apply, 'node application-answers.mjs --report -x/../modes/_custom.md --input output/a.json');
    // The last --report wins in the script, so every one is checked.
    no(apply, 'node application-answers.mjs --report output/r.md --report modes/_custom.md --input output/a.json');
    // It has no --flag=value form: --report=x would be a key named "report=x" taking the next token.
    no(apply, 'node application-answers.mjs --report=output/r.md --input output/a.json');
    no(apply, 'node application-answers.mjs --input output/a.json --report');
    no(apply, 'node application-answers.mjs --report output/r.md --input output/a.json --out modes/_custom.md');
    no(apply, 'node application-answers.mjs modes/_custom.md --report output/r.md --input output/a.json');
    no(apply, 'node application-answers.mjs --report output/r.md --input /etc/passwd');
    no(apply, 'node application-answers.mjs --report output/r.md --input .env');
    // The read modes print a section and write nothing, so the report is only read (inside the roots, never a secret).
    ok(apply, 'node application-answers.mjs --report reports/001-acme.md --read --strict');
    ok(apply, 'node application-answers.mjs --report reports/001-acme.md --read-draft');
    ok(apply, 'node application-answers.mjs --read --report reports/001-acme.md');
    no(apply, 'node application-answers.mjs --report /etc/hosts --read');
    no(apply, 'node application-answers.mjs --report .env --read-draft');
    no(apply, 'node application-answers.mjs --report reports/001-acme.md --read=1');
    expect(checkBash('node application-answers.mjs --report modes/_custom.md --input output/a.json', apply, root)).toMatch(/modes\/_custom\.md is outside the write scope/);
  });

  it('reconcile-pipeline --pipeline: the rewritten file and its .pre-reconcile.bak copy stay inside the write scope; --dry-run only reads', () => {
    // Only the batch mode grants it today, and batch never runs as a session: latent, but the grammar must hold wherever it is granted.
    const pipeline = { ...policyFor('batch', [...ALWAYS_DENIED_WRITES]), readDeny: [...READ_DENY] };
    // With no --pipeline it rewrites data/pipeline.md, its own file.
    for (const cmd of ['node reconcile-pipeline.mjs', 'node reconcile-pipeline.mjs --dry-run', 'node reconcile-pipeline.mjs --state batch/batch-state.tsv', 'node reconcile-pipeline.mjs --pipeline output/p.md --state=output/s.tsv', 'node reconcile-pipeline.mjs --pipeline=output/p.md'])
      ok(pipeline, cmd);
    // The audit trigger: --pipeline names the file it rewrites and copies, anywhere inside the roots.
    for (const cmd of [
      'node reconcile-pipeline.mjs --pipeline modes/_custom.md',
      'node reconcile-pipeline.mjs --pipeline=AGENTS.md',
      'node reconcile-pipeline.mjs --pipeline data/pipeline.md',
      'node reconcile-pipeline.mjs --pipeline -x/../cv.md',
      'node reconcile-pipeline.mjs --pipeline output/p.md --pipeline modes/pipeline.md',
      'node reconcile-pipeline.mjs --pipeline',
      'node reconcile-pipeline.mjs --pipeline output/p.md --state /etc/hosts',
      'node reconcile-pipeline.mjs --state .env',
      'node reconcile-pipeline.mjs modes/_custom.md',
      'node reconcile-pipeline.mjs --dry-run=1',
    ])
      no(pipeline, cmd);
    // The backup copy is written next to the file, so the scope must allow it too.
    const exact = { ...pipeline, allow: ['output/p.md'] };
    expect(checkBash('node reconcile-pipeline.mjs --pipeline output/p.md', exact, root)).toMatch(/output\/p\.md\.pre-reconcile\.bak is outside the write scope/);
    // A dry run writes nothing, so --pipeline is only read.
    ok(pipeline, 'node reconcile-pipeline.mjs --pipeline modes/_custom.md --dry-run');
    no(pipeline, 'node reconcile-pipeline.mjs --pipeline /etc/hosts --dry-run');
  });

  it('h1b-sponsor check: a company name in any number of words and its switches; never a caller-chosen cache directory', () => {
    const sponsor = { ...policyFor('sponsorship-check', [...ALWAYS_DENIED_WRITES]), readDeny: [...READ_DENY] };
    for (const cmd of ['node plugins/h1b-sponsor/check.mjs Acme', 'node plugins/h1b-sponsor/check.mjs "Acme Robotics" --summary', 'node plugins/h1b-sponsor/check.mjs Acme Robotics Inc --json --refresh', 'node plugins/h1b-sponsor/check.mjs --search Acme.io'])
      ok(sponsor, cmd);
    ok(oferta, 'node plugins/h1b-sponsor/check.mjs "Acme Robotics" --summary');
    // The audit trigger: --cache-dir makes the directory and writes <name>-<hash>.json cache files into it.
    for (const cmd of ['node plugins/h1b-sponsor/check.mjs --cache-dir modes Acme', 'node plugins/h1b-sponsor/check.mjs Acme --cache-dir custom/control-center/server/claude', 'node plugins/h1b-sponsor/check.mjs --cache-dir data/immigration/companies Acme', 'node plugins/h1b-sponsor/check.mjs --cache-dir=modes Acme', 'node plugins/h1b-sponsor/check.mjs --json=1 Acme'])
      no(sponsor, cmd);
    no(oferta, 'node plugins/h1b-sponsor/check.mjs --cache-dir reports Acme');
  });

  it('reply-watch: the candidates file it creates when missing must be inside the write scope', () => {
    const outreach = { ...policyFor('reply-watch', [...ALWAYS_DENIED_WRITES]), readDeny: [...READ_DENY] };
    ok(outreach, 'node reply-watch.mjs');
    ok(outreach, 'node reply-watch.mjs data/reply-candidates.json');
    // The audit trigger: a missing path is created (with its folders) and filled with mock candidates.
    for (const cmd of ['node reply-watch.mjs modes/new-mode.md', 'node reply-watch.mjs .claude/commands/x.md', 'node reply-watch.mjs output/candidates.json', 'node reply-watch.mjs -x/../modes/y.md', 'node reply-watch.mjs data/reply-candidates.json modes/z.md', 'node reply-watch.mjs --file modes/a.md'])
      no(outreach, cmd);
  });

  it('doctor: its checks and onboarding copies run on the configured root, never on a --target the session names', () => {
    for (const mode of ['intake', 'update', 'triage']) {
      const p = { ...policyFor(mode, [...ALWAYS_DENIED_WRITES]), readDeny: [...READ_DENY] };
      for (const cmd of ['node doctor.mjs', 'node doctor.mjs --json', 'node doctor.mjs --json --init-templates', 'node doctor.mjs --strict', 'node doctor.mjs --cli claude --json']) ok(p, cmd);
      // The audit trigger: --target makes data/, output/ and reports/ and seeds data/pipeline.md and the onboarding templates there.
      for (const cmd of ['node doctor.mjs --target modes', 'node doctor.mjs --target custom/control-center --json --init-templates', 'node doctor.mjs --target=output', 'node doctor.mjs --json --target .', 'node doctor.mjs --cli=claude', 'node doctor.mjs modes'])
        no(p, cmd);
    }
  });

  it('fork CV and projects scripts: outputs inside the write scope, render-pdf rewrites its input, rank reads a JD inside the roots', () => {
    ok(pdf, 'node custom/cv/build-html.mjs output/payload.json output/cv.html');
    no(pdf, 'node custom/cv/build-html.mjs output/payload.json cv.md');
    no(pdf, 'node custom/cv/build-html.mjs output/payload.json output/cv.html output/extra.html');
    no(pdf, 'node custom/cv/build-html.mjs output/payload.json output/cv.html --template=x');
    ok(pdf, 'node custom/cv/render-pdf.mjs output/cv.html output/cv.pdf --format=letter --report=008 --max-pages=1');
    ok(pdf, 'node custom/cv/render-pdf.mjs output/cv.html output/cv.pdf --format letter --max-pages 1 --strict-pages');
    no(pdf, 'node custom/cv/render-pdf.mjs output/cv.html cv.md');
    // The input HTML is rewritten with the fitted density, so it must be writable too.
    no(pdf, 'node custom/cv/render-pdf.mjs reports/cv.html output/cv.pdf');
    no(pdf, 'node custom/cv/render-pdf.mjs output/cv.html output/cv.pdf --out=cv.md');
    no(pdf, 'node custom/cv/render-pdf.mjs output/cv.html output/cv.pdf --max-pages');
    ok(oferta, 'node custom/projects/rank.mjs jds/acme.md --json');
    ok(oferta, 'node custom/projects/rank.mjs --check');
    no(oferta, 'node custom/projects/rank.mjs /etc/passwd --json');
  });

  it('projects-ingest: no command is allowed, not even intake.mjs --text (it creates the documents/ scaffold)', () => {
    const ingest = policyFor('projects-ingest', [...ALWAYS_DENIED_WRITES]);
    for (const cmd of ['node intake.mjs --text projects/kites.pdf', 'node intake.mjs', 'node intake.mjs --commit --all']) no(ingest, cmd);
  });

  it('a batch-mode session cannot run batch-runner.sh, nor a pipeline session rank-pipeline.mjs: both start agent CLIs outside the guard', () => {
    const batch = policyFor('batch', [...ALWAYS_DENIED_WRITES]);
    const pipeline = policyFor('pipeline', [...ALWAYS_DENIED_WRITES]);
    for (const cmd of ['bash batch/batch-runner.sh', 'bash batch/batch-runner.sh --dry-run', 'bash batch/batch-runner.sh --parallel 2']) no(batch, cmd);
    for (const cmd of ['node rank-pipeline.mjs', 'node rank-pipeline.mjs --dry-run', 'node rank-pipeline.mjs --cli codex']) no(pipeline, cmd);
    // The rest of each class still runs.
    ok(batch, 'node reconcile-pipeline.mjs --dry-run');
    ok(pipeline, 'node check-liveness.mjs https://jobs.example.com/1');
  });

  it('agent-spawning scripts are refused even when a policy lists them, in any spelling the shell would run', () => {
    const forged = { ...oferta, bash: [...oferta.bash, ['bash', 'batch/batch-runner.sh'], ['node', 'rank-pipeline.mjs'], ['bash', './batch/batch-runner.sh'], ['node', 'Rank-Pipeline.mjs']] };
    for (const cmd of ['bash batch/batch-runner.sh --dry-run', 'node rank-pipeline.mjs --limit 5', 'bash ./batch/batch-runner.sh', 'node Rank-Pipeline.mjs']) {
      expect(checkBash(cmd, forged, root), cmd).toMatch(/starts agent CLIs outside the session guard/);
    }
    expect(AGENT_SPAWNING_SCRIPTS).toEqual(['batch/batch-runner.sh', 'rank-pipeline.mjs']);
  });

  it('refuses Bash when the session is not running from the repo root', () => {
    expect(checkBash('git status', devchat, path.join(root, 'data'))).toMatch(/repo root/);
    expect(checkBash('git status', devchat, root)).toBeNull();
  });
});

describe('every script a session may run is audited for the files it writes', () => {
  // The generic script grammar only read-checks path arguments, so it is right only for scripts that write nothing or
  // only their own fixed files. Each one below was audited (its parser and every write call, imports included); a script
  // whose arguments choose a file it writes is modelled in guard-policy.mjs (WRITER_SCRIPTS) instead. A script a mode
  // starts granting fails here until someone has read it.
  const FIXED_OR_NO_WRITES: Record<string, string> = {
    'add-entry.mjs': 'cv.md and article-digest.md',
    'agent-inbox.mjs': 'data/agent-inbox.md (or CAREER_OPS_INBOX) and .gitignore',
    'analyze-patterns.mjs': 'nothing; --self-test makes and removes tagged files in reports/',
    'archive-posting.mjs': 'jds/<date>_<slug>_<slug>.pdf; company and role are slugified and --report must be digits',
    'audit-portals.mjs': 'nothing',
    'browser-extract.mjs': 'nothing',
    'calibrate.mjs': 'nothing',
    'career-profile.mjs': 'data/career-profile.yml; its path argument is only read',
    'check-liveness.mjs': 'nothing',
    'company-history.mjs': 'nothing; --self-test writes in a temp folder',
    'contact-extract.mjs': 'data/contacts.tsv; --file is only read',
    'custom/immigration/freshness.mjs': 'nothing',
    'custom/projects/rank.mjs': 'nothing',
    'cv-sync-check.mjs': 'nothing',
    'cv-templates.mjs': 'nothing',
    'cv-title-check.mjs': 'nothing; --self-test writes in a temp folder',
    'dedup-tracker.mjs': 'the tracker and its backup',
    'discover-ats.mjs': 'portals.yml (--write); --in is only read',
    'fetch-jd.mjs': 'nothing',
    'find.mjs': 'nothing',
    'followup-cadence.mjs': 'nothing',
    'followup-seed.mjs': 'data/follow-ups.md and its lock',
    'funnel-velocity.mjs': 'nothing',
    'intake.mjs': 'data/intake-state.json and the documents/ scaffold; --text reads inside documents/',
    'jd-skill-gap.mjs': 'nothing',
    'keyword-match.mjs': 'nothing',
    'mark-pdf-ready.mjs': 'the tracker',
    'match-star.mjs': 'nothing',
    'merge-tracker.mjs': 'the tracker and batch/tracker-additions/',
    'normalize-statuses.mjs': 'the tracker and its backup',
    'outcome.mjs': 'data/outcomes/<row>/ and the tracker; --clean-output removes output/ files only after a verified copy',
    'paste-reply.mjs': 'data/reply-candidates.json; --file is only read',
    'prepare-application.mjs': 'nothing',
    'rejection-latency.mjs': 'nothing',
    'reserve-report-num.mjs': 'reports/NNN-RESERVED.md sentinels',
    'salary-gap.mjs': 'nothing',
    'scan.mjs': 'data/pipeline.md, data/scan-history.tsv and its run logs',
    'set-status.mjs': 'the tracker and data/status-log.tsv',
    'stats.mjs': 'nothing',
    'story-provenance-check.mjs': 'nothing',
    'update-system.mjs': 'the code checkout (apply, rollback), its lock and dismiss files',
    'upskill.mjs': 'nothing; --self-test makes and removes tagged files in reports/',
    'validate-portals.mjs': 'nothing; --file is only read, --self-test writes in a temp folder',
    'validate-profile.mjs': 'nothing',
    'verify-ats.mjs': 'nothing',
    'verify-cv-facts.mjs': 'nothing',
    'verify-pipeline.mjs': 'removes stale reports/*-RESERVED.md sentinels',
    'verify-portals.mjs': 'nothing; --file is only read',
  };
  const granted = new Set<string>();
  for (const id of listModeIds()) for (const [bin, script] of getModePolicy(id)!.bashPrefixes) if ((bin === 'node' || bin === 'bash') && script) granted.add(script);

  it('each granted script is modelled as a writer or listed with the fixed files it writes', () => {
    expect([...granted].filter((s) => !WRITER_SCRIPT_NAMES.includes(s) && !Object.hasOwn(FIXED_OR_NO_WRITES, s)).sort()).toEqual([]);
    expect(Object.keys(FIXED_OR_NO_WRITES).filter((s) => WRITER_SCRIPT_NAMES.includes(s))).toEqual([]);
  });

  it('the audit list names only scripts some session is granted', () => {
    expect(Object.keys(FIXED_OR_NO_WRITES).filter((s) => !granted.has(s))).toEqual([]);
  });
});

describe('read confinement: guard policy', () => {
  const base = fs.realpathSync(tempDir('cc-read-'));
  const code = path.join(base, 'code');
  const data = path.join(base, 'data root');
  const outside = path.join(base, 'outside');
  const results = path.join(base, 'claude', 'tool-results');
  for (const d of [code, data, outside, results, path.join(data, 'Data')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(code, 'cv.md'), 'code cv\n');
  fs.writeFileSync(path.join(data, 'cv.md'), 'data cv\n');
  fs.writeFileSync(path.join(code, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(data, 'Data', '.ENV'), 'SECRET=1\n');
  fs.writeFileSync(path.join(outside, 's.txt'), 'outside\n');
  fs.writeFileSync(path.join(results, 'big.txt'), 'oversized output\n');
  fs.symlinkSync(outside, path.join(code, 'link-out'));
  fs.symlinkSync(path.join(outside, 's.txt'), path.join(data, 'file-link'));
  const policy = { codeRoot: code, dataRoot: data, allow: getModePolicy('oferta')!.writeGlobs, deny: [...ALWAYS_DENIED_WRITES], readDeny: [...READ_DENY], readOnlyRoots: [results], search: true };
  const read = (file_path: string, cwd: string | undefined = code) => checkRead(policy, { file_path }, cwd);

  it('given an evaluate policy, a read outside both roots is denied', () => {
    expect(read(path.join(outside, 's.txt'))).toMatch(/outside the repo and data roots/);
    expect(read('/etc/hosts')).toMatch(/outside the repo and data roots/);
    expect(read(path.join(code, '..', 'outside', 's.txt'))).toMatch(/outside/);
  });

  it('a symlink inside a root that points outside is denied, by its real path', () => {
    expect(read(path.join(code, 'link-out', 's.txt'))).toMatch(/outside the repo and data roots/);
    expect(read(path.join(data, 'file-link'))).toMatch(/outside the repo and data roots/);
  });

  it('~ paths, .env and Data/.ENV are denied', () => {
    expect(read('~/x')).toMatch(/use the absolute path/);
    expect(read('~')).toMatch(/use the absolute path/);
    expect(read(path.join(code, '.env'))).toMatch(/protected secret file/);
    expect(read('.env')).toMatch(/protected secret file/);
    // Deny globs compare case-insensitively: an over-deny on a case-sensitive volume, by design.
    expect(read(path.join(data, 'Data', '.ENV'))).toMatch(/protected secret file/);
  });

  it('cv.md relative to the code root is allowed from the code root and denied from any other cwd', () => {
    expect(read('cv.md')).toBeNull();
    expect(locateRead(policy, 'cv.md')).toMatchObject({ abs: path.join(code, 'cv.md'), root: 'code', rel: 'cv.md' });
    expect(read('cv.md', data)).toMatch(/relative path/);
    expect(read('cv.md', outside)).toMatch(/relative path/);
  });

  it('the data root cv.md by absolute path is allowed and located in the data root', () => {
    expect(read(path.join(data, 'cv.md'))).toBeNull();
    expect(read(path.join(data, 'cv.md'), outside)).toBeNull();
    expect(locateRead(policy, path.join(data, 'cv.md'))).toMatchObject({ abs: path.join(data, 'cv.md'), root: 'data', rel: 'cv.md' });
  });

  it('a .. segment is refused before any resolution, even when the path stays inside a root on paper', () => {
    expect(read(`${code}/link-out/../cv.md`)).toMatch(/has a \.\. segment/);
    expect(read(`${code}/data/../cv.md`)).toMatch(/has a \.\. segment/);
    expect(read('link-out/../cv.md')).toMatch(/has a \.\. segment/);
    expect(read(`${code}/cv.md`)).toBeNull();
  });

  it('the root itself is allowed', () => {
    expect(locateRead(policy, code)).toMatchObject({ rel: '', root: 'code' });
    expect(locateRead(policy, data)).toMatchObject({ rel: '', root: 'data' });
    expect(read(code)).toBeNull();
  });

  it('a read in a read-only root is allowed while a write there is denied', () => {
    expect(read(path.join(results, 'big.txt'))).toBeNull();
    expect(locateRead(policy, path.join(results, 'big.txt'))).toMatchObject({ root: 'readonly' });
    const dir = tempDir('cc-read-guard-');
    const pf = writePolicyFile(dir, { codeRoot: code, dataRoot: data, policy: getModePolicy('oferta')!, readOnlyRoots: [results] });
    const write = hookRun(dir, pf, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(results, 'big.txt'), content: 'x' }, cwd: code });
    expect(write.status).toBe(2);
    expect(write.stderr).toMatch(/outside the repo and data roots/);
  });

  it('a policy without a read-deny list refuses every read', () => {
    const { readDeny: _readDeny, ...old } = policy;
    expect(checkRead(old, { file_path: path.join(code, 'cv.md') }, code)).toMatch(/policy/);
  });

  it('Glob and Grep: the path passes the read checks, and patterns cannot climb out, start at ~ or brace in an absolute path', () => {
    const search = (tool: string, input: Record<string, unknown>, cwd: string = code) => checkSearch(policy, tool, input, cwd);
    expect(search('Glob', { pattern: '**/*.md' })).toBeNull();
    expect(search('Glob', { pattern: '**/*.md', path: data })).toBeNull();
    expect(search('Glob', { pattern: `${data}/reports/*.md` })).toBeNull();
    expect(search('Grep', { pattern: 'Score', path: code, glob: '*.md' })).toBeNull();
    expect(search('Grep', { pattern: 'Score' })).toBeNull();
    expect(search('Glob', { pattern: '*', path: outside })).toMatch(/outside/);
    expect(search('Grep', { pattern: 'x', path: path.join(code, 'link-out') })).toMatch(/outside/);
    expect(search('Grep', { pattern: 'x', path: path.join(code, '.env') })).toMatch(/protected secret file/);
    expect(search('Glob', { pattern: '*', path: '~/.ssh' })).toMatch(/absolute path/);
    expect(search('Glob', { pattern: '*' }, outside)).toMatch(/repo root/);
    for (const pattern of ['../outside/*', '**/../../x', 'a\\..\\b', '~/.ssh/*', '{/etc,src}/*', 'src/{a,/etc}/*', '{~,x}/*', 'a,~/x', `${outside}/*`, '/etc/*', '/*'])
      expect(search('Glob', { pattern }), pattern).toEqual(expect.any(String));
    for (const glob of ['../outside/*', '~/x', '{/etc,a}', `${outside}/*`]) expect(search('Grep', { pattern: 'x', glob }), glob).toEqual(expect.any(String));
  });

  it('Glob and Grep are refused when the policy does not grant search', () => {
    expect(checkSearch({ ...policy, search: false }, 'Glob', { pattern: '*' }, code)).toMatch(/not granted/);
    const { search: _search, ...old } = policy;
    expect(checkSearch(old, 'Grep', { pattern: 'x' }, code)).toMatch(/not granted/);
  });
});

describe('checkBash: URL arguments and protected inputs', () => {
  const root = fs.realpathSync(tempDir('cc-bash-url-'));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  const p = getModePolicy('oferta')!;
  const oferta = { codeRoot: root, dataRoot: root, allow: p.writeGlobs, deny: [...ALWAYS_DENIED_WRITES], readDeny: [...READ_DENY], bash: p.bashPrefixes };

  it('file:, view-source:, data: and the other local or non-http schemes are refused as script arguments', () => {
    for (const cmd of [
      'node archive-posting.mjs file:///etc/passwd',
      'node archive-posting.mjs file:/x',
      'node archive-posting.mjs FILE:///etc/passwd',
      'node check-liveness.mjs view-source:file:///etc/passwd',
      'node check-liveness.mjs --url=file:///etc/passwd',
      'node archive-posting.mjs data:text/html,x',
      'node archive-posting.mjs javascript:alert',
      'node archive-posting.mjs chrome://settings',
      'node archive-posting.mjs ftp://x.example/y',
      'node archive-posting.mjs ws://x.example/y',
      'node generate-pdf.mjs file:///etc/passwd output/x.pdf',
    ])
      expect(checkBash(cmd, oferta, root), cmd).toEqual(expect.any(String));
  });

  it('http and https arguments must name a public host', () => {
    for (const cmd of ['node check-liveness.mjs http://127.0.0.1/', 'node check-liveness.mjs http://localhost:8080/x', 'node check-liveness.mjs https://[::1]/', 'node archive-posting.mjs http://169.254.169.254/latest/meta-data', 'node check-liveness.mjs http://intranet/x', 'node check-liveness.mjs http://0x7f.1/'])
      expect(checkBash(cmd, oferta, root), cmd).toEqual(expect.any(String));
    expect(checkBash('node check-liveness.mjs https://jobs.example.com/x/1', oferta, root)).toBeNull();
  });

  it('a protected secret file is refused as a script input', () => {
    expect(checkBash('node jd-skill-gap.mjs .env', oferta, root)).toMatch(/protected/);
    expect(checkBash('node jd-skill-gap.mjs jds/acme.md --summary', oferta, root)).toBeNull();
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

  it('takes envelopes from every assistant message of the turn, not only the last one in the result, once each (SW4-claude-03)', () => {
    const p = new StreamParser();
    const ev = (o: unknown) => p.push(JSON.stringify(o));
    const offer = (n: number) => `<<cc:offer {"url":"https://jobs.example.com/a/${n}","company":"C${n}","title":"Engineer"}>>`;
    // The result holds only the last message; offer 1 and its duplicate were written before a tool call.
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: `Found one:\n${offer(1)}\nLet me search further.` }, { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'more' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'results' }] } });
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: `Still that one:\n${offer(1)}` }, { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'again' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'results' }] } });
    const last = `Found another:\n${offer(2)}\nThat is all.`;
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: last }] } });
    const done = ev({ type: 'result', subtype: 'success', result: last, num_turns: 5, is_error: false, usage: {} });
    expect(done.filter((e) => e.type === 'envelope').map((e) => (e.type === 'envelope' ? (e.payload as { company: string }).company : ''))).toEqual(['C1', 'C2']);
    // The visible text is every message's, envelopes removed, so the transcript keeps what was said before the last tool call (SW7-web-a-04).
    expect(done.find((e) => e.type === 'text.done')).toEqual({ type: 'text.done', text: 'Found one:\nLet me search further.\n\nStill that one:\n\nFound another:\nThat is all.' });
  });

  it('streams a break between two assistant messages, so their text does not run together (SW7-web-a-04)', () => {
    const p = new StreamParser();
    const ev = (o: unknown) => p.push(JSON.stringify(o));
    const delta = (text: string) => ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    expect(delta('Let me search.')).toEqual([{ type: 'text.delta', text: 'Let me search.' }]);
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me search.' }, { type: 'tool_use', id: 't1', name: 'WebSearch', input: { query: 'x' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'results' }] } });
    expect(delta('Found it.')).toEqual([{ type: 'text.delta', text: '\n\nFound it.' }]);
    expect(delta(' Done.')).toEqual([{ type: 'text.delta', text: ' Done.' }]);
  });

  it('a result with no text shows each streamed message once, not the whole stream again after them (review fix)', () => {
    const p = new StreamParser();
    const ev = (o: unknown) => p.push(JSON.stringify(o));
    const delta = (text: string) => ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    delta('a');
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/cv.md' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'cv' }] } });
    delta('b');
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } });
    const done = ev({ type: 'result', subtype: 'success', result: '', num_turns: 2, is_error: false, usage: {} });
    expect(done.find((e) => e.type === 'text.done')).toEqual({ type: 'text.done', text: 'a\n\nb' });
  });

  it('an apply answers envelope written before a later tool call is kept, so the turn has its terminal envelope (SW4-claude-03)', () => {
    const p = new StreamParser();
    const ev = (o: unknown) => p.push(JSON.stringify(o));
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: '<<cc:answers {"fields":[{"id":"q1","label":"Why us","type":"textarea","required":true,"value":"Because","needsConfirmation":true}]}>>' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/r/cv.md' } }] } });
    ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'cv' }] } });
    ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Review the answers above.' }] } });
    const done = ev({ type: 'result', subtype: 'success', result: 'Review the answers above.', num_turns: 3, is_error: false, usage: {} });
    expect(done.filter((e) => e.type === 'envelope')).toEqual([expect.objectContaining({ type: 'envelope', kind: 'answers' })]);
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
    const projects = extractEnvelopes('<<cc:projects {"markdown":"## Chess Engine\\n- Wrote it."}>>', false);
    expect(projects.envelopes[0]).toMatchObject({ ok: true, kind: 'projects', payload: { markdown: '## Chess Engine\n- Wrote it.' } });
    expect(extractEnvelopes('<<cc:projects {"markdown":""}>>', false).envelopes[0]).toMatchObject({ ok: false });
  });

  it('a "}>>" inside a JSON string does not end the envelope', () => {
    const r = extractEnvelopes('<<cc:cv {"markdown":"contains }>> here"}>>', false);
    expect(r.envelopes).toEqual([expect.objectContaining({ ok: true, kind: 'cv', payload: { markdown: 'contains }>> here' } })]);
    expect(r.visibleText).toBe('');
    const nested = extractEnvelopes('Hi <<cc:act {"action":"x","params":{"a":{"b":"}"}}}>> bye', false);
    expect(nested.envelopes).toEqual([expect.objectContaining({ ok: true, kind: 'act', payload: { action: 'x', params: { a: { b: '}' } } } })]);
    expect(nested.visibleText).toBe('Hi  bye');
    // Malformed JSON still ends at the first closer and comes back as a warning, never as visible raw text.
    const bad = extractEnvelopes('<<cc:act {"action":"x"}}>> tail', false);
    expect(bad.envelopes).toEqual([expect.objectContaining({ ok: false, kind: 'act' })]);
    expect(bad.visibleText).toBe(' tail');
  });

  it('while streaming, a partial envelope after a complete one on the same line is hidden', () => {
    const r = extractEnvelopes('Go <<cc:act {"action":"a"}>> next <<cc:act {"action":"', true);
    expect(r.envelopes).toEqual([expect.objectContaining({ ok: true, kind: 'act' })]);
    expect(r.visibleText).toBe('Go  next');
    // A string still open at the end of the stream is a partial envelope, even when it already holds a "}>>".
    expect(extractEnvelopes('Saved <<cc:cv {"markdown":"a }>> b', true)).toEqual({ envelopes: [], visibleText: 'Saved ' });
  });

  it('an envelope kind named after an Object property is an unknown kind, never a crash', () => {
    for (const kind of ['constructor', 'tostring', 'hasownproperty', 'valueof', 'isprototypeof']) {
      const r = extractEnvelopes(`Done.\n<<cc:${kind} {}>>`, false);
      expect(r.envelopes, kind).toEqual([{ ok: false, kind, error: `unknown envelope kind ${kind}`, raw: `<<cc:${kind} {}>>` }]);
    }
  });
});
