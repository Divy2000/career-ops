import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT, cliScriptPath, importCore, type CliContract } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { NODE_FLOOR } from '../../supervisor/preflight.js';
import { copyFixtureRoot } from '../helpers/app.js';

const fixtureRoot = copyFixtureRoot();

function runHelp(cli: CliContract) {
  const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, cli.script), ...cli.helpArgs], {
    cwd: DEFAULT_CODE_ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: fixtureRoot, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('core contract', () => {
  it('pins the Node floor the supervisor enforces', () => {
    expect(CONTRACT.nodeFloor).toBe(NODE_FLOOR);
  });

  for (const cli of CONTRACT.clis as CliContract[]) {
    it(`${cli.script} answers ${cli.helpArgs.join(' ')} with the contracted flags`, () => {
      expect(fs.existsSync(cliScriptPath(DEFAULT_CODE_ROOT, cli.id as never)), `${cli.script} exists`).toBe(true);
      const { status, out } = runHelp(cli);
      if (cli.expectExit !== null) expect(status, out.slice(0, 500)).toBe(cli.expectExit);
      expect(out.length, 'help output is not empty').toBeGreaterThan(0);
      expect(out, `${cli.script} help should not be a crash`).not.toMatch(/ERR_MODULE_NOT_FOUND|SyntaxError|TypeError/);
      for (const flag of cli.flags) expect(out, `${cli.script} mentions ${flag}`).toContain(flag);
    });
  }

  for (const entry of CONTRACT.exports) {
    it(`${entry.module} exports ${entry.names.join(', ')}`, async () => {
      const mod = await importCore<Record<string, unknown>>(DEFAULT_CODE_ROOT, entry.module as never);
      for (const name of entry.names) expect(mod[name], `${entry.module}#${name}`).toBeDefined();
    });
  }

  it('refuses to import a module outside the contract', async () => {
    await expect(importCore(DEFAULT_CODE_ROOT, 'scan.mjs' as never)).rejects.toThrow(/not a contracted/);
  });

  it('the batch runner documents the contracted flags', () => {
    const text = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, CONTRACT.batchRunner.script), 'utf8');
    for (const flag of CONTRACT.batchRunner.flags) expect(text).toContain(flag);
  });

  it('the installed Claude CLI advertises every flag the invocation builder uses', () => {
    const bin = process.env.CC_REAL_CLAUDE_BIN ?? 'claude';
    const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, `${bin} --help failed: ${r.stderr}`).toBe(0);
    for (const flag of CONTRACT.claude.flags) expect(r.stdout, `claude --help mentions ${flag}`).toContain(flag);
  });

  it('records the P0 probe facts the engine relies on', () => {
    const p = CONTRACT.claude.probes;
    expect(p.dontAskDeniesUnlistedTool).toBe(true);
    expect(p.editRuleCoversWrite).toBe(true);
    expect(p.settingsAcceptsInlineHooksJson).toBe(true);
    expect(p.hookExit2Blocks).toBe(true);
    expect(p.resumeKeepsSessionId).toBe(true);
    expect(p.hookStdinKeys).toEqual(expect.arrayContaining(['tool_name', 'tool_input', 'session_id', 'cwd']));
    expect(p.streamJson.result.keys).toEqual(expect.arrayContaining(['total_cost_usd', 'usage', 'num_turns', 'permission_denials', 'is_error']));
  });
});
