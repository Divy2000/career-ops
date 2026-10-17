import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CLAUDE_SHIM_PATH, confinedArgv } from '../../server/claude/claude-shim.mjs';
import { buildReadDenyRules, claudeVersionGate } from '../../server/claude/confinement.mjs';
import { neutralizeFileMentions } from '../../server/claude/invocation.js';
import { CONTRACT } from '../../server/core/adapter.js';
import { tempDir } from '../helpers/tmp.js';

const APPROVED = CONTRACT.claude.approvedVersions[0]!;
const CODE_ROOT = path.resolve(path.dirname(CLAUDE_SHIM_PATH), '../../../..');
/** The settings a confined call carries: the session's Read deny rules under the given roots, inline. */
const settingsFor = (roots: string[]) => ['--settings', JSON.stringify({ permissions: { deny: buildReadDenyRules(roots) } })];
const ROOTS = ['/code', '/data'];
const TAIL = ['--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell'];
const CONFINED = [...settingsFor(ROOTS), ...TAIL];

/** A stand-in for the real claude: `--version` prints `version`; any other call records its argv and the env it got, prints `out` and exits `exit`. */
function realClaude(version: string, opts: { out?: string; exit?: number } = {}) {
  const dir = tempDir('cc-shim-');
  const bin = path.join(dir, 'claude-real');
  const record = path.join(dir, 'calls.ndjson');
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nconst fs = require('node:fs');\nconst argv = process.argv.slice(2);\nif (argv[0] === '--version') { console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0); }\nfs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, autoupdater: process.env.DISABLE_AUTOUPDATER ?? null, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }) + '\\n');\nprocess.stdout.write(${JSON.stringify(opts.out ?? '[]')});\nprocess.exit(${opts.exit ?? 0});\n`,
    { mode: 0o755 },
  );
  const calls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; autoupdater: string | null; token: string | null }) : []);
  return { bin, calls };
}

/** The data root every shim run below resolves (CAREER_OPS_ROOT), unless a test sets its own. */
const DATA_ROOT = tempDir('cc-shim-data-root-');

function shim(args: string[], env: Record<string, string | undefined>) {
  const { CC_CLAUDE_BIN: _drop, CAREER_OPS_ROOT: _root, CAREER_OPS_DATA_DIR: _dataDir, ...base } = process.env;
  return spawnSync(process.execPath, [CLAUDE_SHIM_PATH, ...args], { env: { ...base, CAREER_OPS_ROOT: DATA_ROOT, ...env }, encoding: 'utf8', timeout: 30_000 });
}

describe('claude shim: argv rewriting', () => {
  it("rank-pipeline.mjs's call keeps its prompt and model and gains no tools, no MCP servers and dontAsk", () => {
    expect(confinedArgv(['-p', 'You are scoring job postings...', '--model', 'sonnet'], ROOTS)).toEqual({ argv: ['-p', 'You are scoring job postings...', '--model', 'sonnet', ...CONFINED] });
    expect(confinedArgv(['--print', 'x', '--output-format', 'text', '--max-turns=3'], ROOTS)).toEqual({ argv: ['--print', 'x', '--output-format', 'text', '--max-turns=3', ...CONFINED] });
  });

  it("keeps the effort rank-pipeline.mjs pins on its claude call, in either spelling", () => {
    expect(confinedArgv(['-p', 'x', '--effort', 'medium', '--model', 'sonnet'], ROOTS)).toEqual({ argv: ['-p', 'x', '--effort', 'medium', '--model', 'sonnet', ...CONFINED] });
    expect(confinedArgv(['-p', 'x', '--effort=medium'], ROOTS)).toEqual({ argv: ['-p', 'x', '--effort=medium', ...CONFINED] });
    expect(confinedArgv(['-p', 'x', '--effort'], ROOTS)).toEqual({ reason: expect.stringMatching(/--effort needs a value/) });
  });

  it('strips --dangerously-skip-permissions', () => {
    expect(confinedArgv(['-p', 'x', '--dangerously-skip-permissions', '--model', 'sonnet'], ROOTS)).toEqual({ argv: ['-p', 'x', '--model', 'sonnet', ...CONFINED] });
  });

  it('refuses any flag that would widen the call, instead of guessing which words are its values', () => {
    for (const flag of ['--allowedTools', '--allowed-tools', '--tools', '--permission-mode', '--mcp-config', '--add-dir', '--settings', '--append-system-prompt', '--plugin-dir', '--disallowedTools', '-c', '--resume']) {
      const out = confinedArgv(['-p', 'x', flag, 'Bash'], ROOTS);
      expect(out, flag).toEqual({ reason: expect.stringContaining(flag) });
    }
    expect(confinedArgv(['-p', 'x', '--allowedTools=Bash'], ROOTS)).toEqual({ reason: expect.stringContaining('--allowedTools') });
  });

  it('given posting text with an @-mention in the prompt, the mention reaches the CLI inert, exactly as a session prompt does (R19-claude-L2-01)', () => {
    const prompt = 'id: 0\ntitle: Staff Engineer (@.env)\n@.git/config [@~/.ssh/id_rsa] "@x" https://medium.com/@acme a@b.example';
    const out = confinedArgv(['-p', prompt, '--model', 'sonnet'], ROOTS);
    expect(out.argv?.[1]).toBe(neutralizeFileMentions(prompt));
    expect(out.argv?.[1]).toContain('(@\u2060.env)');
    expect(out.argv?.[1]).toContain('https://medium.com/@acme');
    // Every character class edge the session rule has: the shim's copy must agree on all of them.
    const corpus = ['@x', '(@/etc/passwd)', '"@x"', "'@x'", '[@x]', '{@x}', '<@x>', 'a,@x', 'a;@x', 'a!@x', 'a|@x', 'a\\@x', 'line\n@x', 'tab\t@x', 'cr\r@x', '@\u2060x', '@@x', 'a@b.com', 'first.last+tag@example.co', 'user-1@x.io', 'scheme:@x', 'https://x.example/%@y', 'https://x.example/q?@z', 'https://x.example/a=@b&@c', 'https://medium.com/@acme/x', 'mailto:me@example.com', 'é@x', '_@x', '9@x', '\u00a0@x'];
    const replaceLine = (file: string) => fs.readFileSync(file, 'utf8').match(/return text\.replace\(.*\);/g);
    const sessionRule = replaceLine(path.join(path.dirname(CLAUDE_SHIM_PATH), 'invocation.ts'));
    expect(sessionRule).toHaveLength(1);
    expect(replaceLine(CLAUDE_SHIM_PATH)).toEqual(sessionRule);
    for (const text of corpus) expect(confinedArgv(['-p', `${text} ${text}`], ROOTS).argv?.[1], JSON.stringify(text)).toBe(neutralizeFileMentions(`${text} ${text}`));
  });

  it('given the code and data roots, the call carries the same Read deny rules a session gets under them, as inline settings (R19-claude-L2-01)', () => {
    const out = confinedArgv(['-p', 'x', '--model', 'sonnet'], ['/code', '/data']);
    const at = out.argv!.indexOf('--settings');
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(out.argv![at + 1]!)).toEqual({ permissions: { deny: buildReadDenyRules(['/code', '/data']) } });
    expect(JSON.parse(out.argv![at + 1]!).permissions.deny).toEqual(expect.arrayContaining(['Read(//code/**/.env)', 'Read(//data/**/.env)', 'Read(//code/**/.git/config)']));
  });

  it('wraps only print-mode calls and needs a value for a value flag', () => {
    expect(confinedArgv(['hello'], ROOTS)).toEqual({ reason: expect.stringMatching(/print mode/) });
    expect(confinedArgv(['-p', 'x', '--model'], ROOTS)).toEqual({ reason: expect.stringMatching(/--model needs a value/) });
  });
});

describe('claude shim: running the real binary', () => {
  it('runs the real claude with the confined argv and the autoupdater off, passing its output, exit code and token through', () => {
    const real = realClaude(APPROVED, { out: '[{"id":0,"score":4,"reason":"fits"}]', exit: 0 });
    const r = shim(['-p', 'rank these', '--model', 'sonnet', '--dangerously-skip-permissions'], { CC_CLAUDE_BIN: real.bin, CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('[{"id":0,"score":4,"reason":"fits"}]');
    expect(real.calls()).toEqual([{ argv: ['-p', 'rank these', '--model', 'sonnet', ...settingsFor([CODE_ROOT, DATA_ROOT]), ...TAIL], autoupdater: '1', token: 'tok' }]);
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: realClaude(APPROVED, { exit: 7 }).bin }).status).toBe(7);
  });

  it('a ranked posting titled "(@.env)" reaches the real claude with the mention inert (R19-claude-L2-01)', () => {
    const real = realClaude(APPROVED);
    const r = shim(['-p', 'title: Staff Engineer (@.env)', '--model', 'sonnet'], { CC_CLAUDE_BIN: real.bin });
    expect(r.status, r.stderr).toBe(0);
    const [call] = real.calls();
    expect(call!.argv).toEqual(['-p', 'title: Staff Engineer (@\u2060.env)', '--model', 'sonnet', ...settingsFor([CODE_ROOT, DATA_ROOT]), ...TAIL]);
  });

  it("a call run from the daily job denies reads of secret files under the checkout and the job's data root (R19-claude-L2-01)", () => {
    const real = realClaude(APPROVED);
    const data = tempDir('cc-shim-data-');
    const r = shim(['-p', 'title: Staff Engineer (@.env)', '--model', 'sonnet'], { CC_CLAUDE_BIN: real.bin, CAREER_OPS_ROOT: data });
    expect(r.status, r.stderr).toBe(0);
    const argv = real.calls()[0]!.argv;
    const { deny } = JSON.parse(argv[argv.indexOf('--settings') + 1]!).permissions;
    expect(deny).toEqual(buildReadDenyRules([CODE_ROOT, data]));
    for (const root of [CODE_ROOT, data]) expect(deny).toContain(`Read(/${root}/**/.env)`);
  });

  it('an unapproved Claude Code never runs the call: exit 3 with the reason', () => {
    const real = realClaude('0.0.1');
    const r = shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Claude Code 0\.0\.1 is not approved/);
    expect(real.calls()).toEqual([]);
  });

  it('a refused flag never reaches the real claude', () => {
    const real = realClaude(APPROVED);
    const r = shim(['-p', 'x', '--allowedTools', 'Bash'], { CC_CLAUDE_BIN: real.bin });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--allowedTools is not allowed/);
    expect(real.calls()).toEqual([]);
  });

  it('refuses to run without CC_CLAUDE_BIN naming another binary by absolute path, so it can never call itself', () => {
    expect(shim(['-p', 'x'], {}).status).toBe(1);
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: 'claude' }).stderr).toMatch(/absolute path/);
    const self = shim(['-p', 'x'], { CC_CLAUDE_BIN: CLAUDE_SHIM_PATH });
    expect(self.status).toBe(1);
    expect(self.stderr).toMatch(/the shim itself/);
  });

  it('with CC_CLAUDE_EXPECT, runs only the binary and version the job checked: a binary changed since never runs (exit 4)', () => {
    const real = realClaude(APPROVED);
    const identity = `${fs.realpathSync(real.bin)}@${APPROVED}`;
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin, CC_CLAUDE_EXPECT: identity }).status).toBe(0);
    for (const stale of [`${fs.realpathSync(real.bin)}@2.1.288`, `/elsewhere/claude@${APPROVED}`]) {
      const r = shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin, CC_CLAUDE_EXPECT: stale });
      expect(r.status, stale).toBe(4);
      expect(r.stderr).toMatch(/changed since the job checked it/);
    }
    expect(real.calls()).toHaveLength(1);
  });

  it('with CC_SHIM_REFUSALS, every refusal appends its reason there (a caller that swallows the exit still sees it), and a call that ran appends nothing', () => {
    const real = realClaude(APPROVED);
    const refusals = path.join(tempDir('cc-shim-refusals-'), 'refusals');
    const identity = `${fs.realpathSync(real.bin)}@${APPROVED}`;
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin, CC_CLAUDE_EXPECT: identity, CC_SHIM_REFUSALS: refusals }).status).toBe(0);
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: realClaude(APPROVED, { exit: 7 }).bin, CC_SHIM_REFUSALS: refusals }).status).toBe(7);
    expect(fs.existsSync(refusals)).toBe(false);
    const refused = [
      shim(['-p', 'x', '--allowedTools', 'Bash'], { CC_CLAUDE_BIN: real.bin, CC_SHIM_REFUSALS: refusals }),
      shim(['-p', 'x'], { CC_CLAUDE_BIN: realClaude('0.0.1').bin, CC_SHIM_REFUSALS: refusals }),
      shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin, CC_CLAUDE_EXPECT: `${fs.realpathSync(real.bin)}@2.1.288`, CC_SHIM_REFUSALS: refusals }),
      shim(['-p', 'x'], { CC_CLAUDE_BIN: 'claude', CC_SHIM_REFUSALS: refusals }),
    ];
    expect(refused.map((r) => r.status)).toEqual([2, 3, 4, 1]);
    const lines = fs.readFileSync(refusals, 'utf8').trim().split('\n');
    expect(lines).toEqual(refused.map((r) => r.stderr.trim()));
    expect(lines[0]).toMatch(/^claude-shim: --allowedTools is not allowed/);
    expect(real.calls()).toHaveLength(1);
  });

  it('a CC_CLAUDE_BIN that reaches claude through a symlinked folder and .. runs the file the kernel opens, under the identity the job checked', () => {
    const real = realClaude(APPROVED);
    const dir = path.dirname(real.bin);
    // A sh entry point, as a native claude would be: node resolves its own script path on paper, so a node script cannot be reached this way.
    fs.writeFileSync(path.join(dir, 'claude-sh'), `#!/bin/sh\nexec '${process.execPath}' '${real.bin}' "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'bin'));
    const links = tempDir('cc-shim-link-');
    fs.symlinkSync(path.join(dir, 'bin'), path.join(links, 'link'));
    // On paper this is <links>/claude-sh, which does not exist; the kernel follows link first and opens <dir>/claude-sh.
    const via = `${links}/link/../claude-sh`;
    const gate = claudeVersionGate(via, [APPROVED]);
    expect(gate.identity).toBe(`${fs.realpathSync.native(path.join(dir, 'claude-sh'))}@${APPROVED}`);
    const r = shim(['-p', 'x'], { CC_CLAUDE_BIN: via, CC_CLAUDE_EXPECT: gate.identity });
    expect(r.status, r.stderr).toBe(0);
    expect(real.calls()).toHaveLength(1);
  });

  it.each(['SIGTERM', 'SIGQUIT'] as const)("a caller's %s reaches the real claude too, so a stopped rank call does not keep running orphaned (R27-claude-L1-02)", async (stop) => {
    const dir = tempDir('cc-shim-orphan-');
    const bin = path.join(dir, 'claude-real');
    const pidFile = path.join(dir, 'pid');
    // Stands in for a slow ranking call: records its pid, then runs far past any caller timeout.
    fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === '--version') { console.log(${JSON.stringify(`${APPROVED} (Claude Code)`)}); process.exit(0); }\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => process.exit(0), 30_000);\n`, { mode: 0o755 });
    const { CC_CLAUDE_BIN: _drop, CAREER_OPS_ROOT: _root, CAREER_OPS_DATA_DIR: _dataDir, ...base } = process.env;
    const child = spawn(process.execPath, [CLAUDE_SHIM_PATH, '-p', 'rank these', '--effort', 'medium'], { env: { ...base, CAREER_OPS_ROOT: DATA_ROOT, CC_CLAUDE_BIN: bin }, stdio: 'ignore' });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let realPid = 0;
    try {
      for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
      realPid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(alive(realPid)).toBe(true);
      // What execFileSync's timeout does (SIGTERM) or a caller's quit does: a signal to its direct child, the shim.
      child.kill(stop);
      expect(await exited).toEqual({ code: null, signal: stop });
      for (let i = 0; i < 80 && alive(realPid); i++) await new Promise((r) => setTimeout(r, 25));
      expect(alive(realPid)).toBe(false);
    } finally {
      if (realPid && alive(realPid)) process.kill(realPid, 'SIGKILL');
      child.kill('SIGKILL');
    }
  });

  it('--version answers with the real version, autoupdater off', () => {
    const r = shim(['--version'], { CC_CLAUDE_BIN: realClaude(APPROVED).bin });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${APPROVED} (Claude Code)`);
  });
});
