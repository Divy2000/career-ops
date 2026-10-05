import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLAUDE_SHIM_PATH, confinedArgv } from '../../server/claude/claude-shim.mjs';
import { CONTRACT } from '../../server/core/adapter.js';
import { tempDir } from '../helpers/tmp.js';

const APPROVED = CONTRACT.claude.approvedVersions[0]!;
const CONFINED = ['--restricted', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Glob,Grep,WebFetch,WebSearch,Agent,Task,PowerShell'];

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

function shim(args: string[], env: Record<string, string | undefined>) {
  const { CC_CLAUDE_BIN: _drop, ...base } = process.env;
  return spawnSync(process.execPath, [CLAUDE_SHIM_PATH, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 30_000 });
}

describe('claude shim: argv rewriting', () => {
  it("rank-pipeline.mjs's call keeps its prompt and model and gains no tools, no MCP servers and dontAsk", () => {
    expect(confinedArgv(['-p', 'You are scoring job postings...', '--model', 'sonnet'])).toEqual({ argv: ['-p', 'You are scoring job postings...', '--model', 'sonnet', ...CONFINED] });
    expect(confinedArgv(['--print', 'x', '--output-format', 'text', '--max-turns=3'])).toEqual({ argv: ['--print', 'x', '--output-format', 'text', '--max-turns=3', ...CONFINED] });
  });

  it('strips --dangerously-skip-permissions', () => {
    expect(confinedArgv(['-p', 'x', '--dangerously-skip-permissions', '--model', 'sonnet'])).toEqual({ argv: ['-p', 'x', '--model', 'sonnet', ...CONFINED] });
  });

  it('refuses any flag that would widen the call, instead of guessing which words are its values', () => {
    for (const flag of ['--allowedTools', '--allowed-tools', '--tools', '--permission-mode', '--mcp-config', '--add-dir', '--settings', '--append-system-prompt', '--plugin-dir', '--disallowedTools', '-c', '--resume']) {
      const out = confinedArgv(['-p', 'x', flag, 'Bash']);
      expect(out, flag).toEqual({ reason: expect.stringContaining(flag) });
    }
    expect(confinedArgv(['-p', 'x', '--allowedTools=Bash'])).toEqual({ reason: expect.stringContaining('--allowedTools') });
  });

  it('wraps only print-mode calls and needs a value for a value flag', () => {
    expect(confinedArgv(['hello'])).toEqual({ reason: expect.stringMatching(/print mode/) });
    expect(confinedArgv(['-p', 'x', '--model'])).toEqual({ reason: expect.stringMatching(/--model needs a value/) });
  });
});

describe('claude shim: running the real binary', () => {
  it('runs the real claude with the confined argv and the autoupdater off, passing its output, exit code and token through', () => {
    const real = realClaude(APPROVED, { out: '[{"id":0,"score":4,"reason":"fits"}]', exit: 0 });
    const r = shim(['-p', 'rank these', '--model', 'sonnet', '--dangerously-skip-permissions'], { CC_CLAUDE_BIN: real.bin, CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('[{"id":0,"score":4,"reason":"fits"}]');
    expect(real.calls()).toEqual([{ argv: ['-p', 'rank these', '--model', 'sonnet', ...CONFINED], autoupdater: '1', token: 'tok' }]);
    expect(shim(['-p', 'x'], { CC_CLAUDE_BIN: realClaude(APPROVED, { exit: 7 }).bin }).status).toBe(7);
  });

  it('an unapproved Claude Code never runs the call: exit 3 with the reason', () => {
    const real = realClaude('2.1.290');
    const r = shim(['-p', 'x'], { CC_CLAUDE_BIN: real.bin });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Claude Code 2\.1\.290 is not approved/);
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

  it('--version answers with the real version, autoupdater off', () => {
    const r = shim(['--version'], { CC_CLAUDE_BIN: realClaude(APPROVED).bin });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${APPROVED} (Claude Code)`);
  });
});
