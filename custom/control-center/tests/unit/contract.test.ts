import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTRACT, cliScriptPath, importCore, type CliContract } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { NODE_FLOOR } from '../../supervisor/preflight.js';
import { copyFixtureRoot } from '../helpers/app.js';
import { buildArgv, buildPermissions, writeSettingsFile } from '../../server/claude/invocation.js';
import { getModePolicy } from '../../server/claude/modes.js';
import { tempDir } from '../helpers/tmp.js';
import { NETWORK_SCAN_SOURCES } from '../../shared/network-scan.js';

const fixtureRoot = copyFixtureRoot();

function runHelp(cli: CliContract) {
  const r = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, cli.script), ...cli.helpArgs], {
    cwd: DEFAULT_CODE_ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: fixtureRoot, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout}\n${r.stderr}` };
}

/** Every file under `root` with its bytes, to tell whether a run wrote anything. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.set(path.relative(root, p), fs.readFileSync(p, 'base64'));
    }
  };
  walk(root);
  return files;
}

describe('core contract', () => {
  it('pins the Node floor the supervisor enforces', () => {
    expect(CONTRACT.nodeFloor).toBe(NODE_FLOOR);
  });

  for (const cli of CONTRACT.clis as CliContract[]) {
    it(`${cli.script} answers ${cli.helpArgs.join(' ')} with the contracted flags`, () => {
      expect(fs.existsSync(cliScriptPath(DEFAULT_CODE_ROOT, cli.id as never)), `${cli.script} exists`).toBe(true);
      if (cli.probe === false) return;
      const before = snapshot(fixtureRoot);
      const { status, signal, out } = runHelp(cli);
      // A timeout or a crash by signal has no exit status; the stream separator alone is no output.
      expect({ status, signal }, out.slice(0, 500)).toMatchObject({ signal: null });
      expect(status, out.slice(0, 500)).not.toBeNull();
      if (cli.expectExit !== null) expect(status, out.slice(0, 500)).toBe(cli.expectExit);
      expect(out.trim().length, 'help output is not empty').toBeGreaterThan(0);
      // A help probe is a read: a script that ignores the flag and runs for real (writes, lookups, live feeds) fails here.
      expect(snapshot(fixtureRoot), `${cli.script} ${cli.helpArgs.join(' ')} wrote to the data root`).toEqual(before);
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

  it('contracted writer modules exist and are never in the pure export list', () => {
    for (const w of CONTRACT.writers) {
      expect(fs.existsSync(path.join(DEFAULT_CODE_ROOT, w)), w).toBe(true);
      expect(CONTRACT.exports.some((e) => e.module === w), `${w} must not be importable into the server`).toBe(false);
    }
  });

  it('Discover > Network scan offers exactly the ATS sources scan-ats-full.mjs has a public directory for', () => {
    // A child process: scan-ats-full.mjs is a writer script and never loads into this process or the server.
    const code = `const m = await import(${JSON.stringify(pathToFileURL(path.join(DEFAULT_CODE_ROOT, 'scan-ats-full.mjs')).href)}); process.stdout.write(JSON.stringify(Object.keys(m.SOURCES)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: fixtureRoot, NO_COLOR: '1' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect([...NETWORK_SCAN_SOURCES]).toEqual(JSON.parse(r.stdout));
  });

  it('refuses to import a module outside the contract', async () => {
    await expect(importCore(DEFAULT_CODE_ROOT, 'scan.mjs' as never)).rejects.toThrow(/not a contracted/);
  });

  it('the batch runner documents the contracted flags', () => {
    const text = fs.readFileSync(path.join(DEFAULT_CODE_ROOT, CONTRACT.batchRunner.script), 'utf8');
    for (const flag of CONTRACT.batchRunner.flags) expect(text).toContain(flag);
  });

  // A host with no Claude Code installed (CI) has nothing to check; where it is installed, the check always runs.
  const realClaude = process.env.CC_REAL_CLAUDE_BIN ?? 'claude';
  // Autoupdater off: a test run must never update the developer's CLI past the approved version (SW2-tests-05).
  const noUpdate = { ...process.env, DISABLE_AUTOUPDATER: '1' };
  it.skipIf((spawnSync(realClaude, ['--version'], { timeout: 30_000, env: noUpdate }).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')('the installed Claude CLI advertises every flag the invocation builder uses (skipped where no claude is installed)', () => {
    const bin = realClaude;
    const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000, env: noUpdate });
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

/**
 * Release gate for read confinement (BUG-06): sessions are confined by the CLI layer, which only the real CLI
 * can prove, so the probe's recorded result must cover the approved version, every gate case must have passed,
 * and the invocation the app builds must still have the shape the probe ran.
 */
describe('read-confinement probe release gate', () => {
  const probe = CONTRACT.claude.readProbe;
  const GATE = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C17', 'C18', 'C20'];
  const INFO = ['C14', 'C15', 'C16', 'C19'];

  it('the probe that approves a version is wired as npm run probe:reads (the refusal message names it)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'control-center', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['probe:reads']).toBe('node scripts/claude-probe-reads.mjs');
    expect(fs.existsSync(path.join(DEFAULT_CODE_ROOT, 'custom', 'control-center', 'scripts', 'claude-probe-reads.mjs'))).toBe(true);
  });

  it('the recorded probe ran on an approved Claude Code version', () => {
    expect(CONTRACT.claude.approvedVersions.length).toBeGreaterThan(0);
    expect(CONTRACT.claude.approvedVersions).toContain(probe.version);
  });

  it('every gate case passed and every informational case was recorded', () => {
    const cases = probe.cases as Record<string, string>;
    for (const id of GATE) expect(cases[id], id).toBe('pass');
    for (const id of INFO) expect(['pass', 'info'], id).toContain(cases[id]);
    for (const [id, r] of Object.entries(cases)) expect(['pass', 'info'], `${id}: ${r}`).toContain(r);
  });

  it('buildArgv has the shape the probe recorded', () => {
    const argv = buildArgv({ claudeBin: 'claude', codeRoot: '/code', dataRoot: '/data', sessionDir: '/g/s', policyFile: '/g/s/p.json', settingsFile: '/g/s/settings.json', policy: getModePolicy('oferta')!, userMessage: 'x', claudeSessionId: '11111111-1111-4111-8111-111111111111', resume: false, preamble: 'P' });
    for (const flag of probe.shape.flags) expect(argv, flag).toContain(flag);
    const disallowed = argv[argv.indexOf('--disallowedTools') + 1]!.split(',');
    for (const t of probe.shape.alwaysDisallowed) expect(disallowed).toContain(t);
    for (const flag of ['--restricted', '--tools']) expect(CONTRACT.claude.flags).toContain(flag);
  });

  it('the settings file has the shape the probe recorded', () => {
    const file = writeSettingsFile(tempDir('cc-contract-settings-'), { permissions: buildPermissions({ policy: getModePolicy('oferta')!, codeRoot: '/code', dataRoot: '/data', guardRoot: '/guard' }) });
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const key of probe.shape.settingsKeys) {
      const [top, sub] = key.split('.') as [string, string];
      expect(settings[top]?.[sub], key).toBeDefined();
    }
    const pre = settings.hooks!.PreToolUse as Array<{ matcher: string; hooks: Array<{ timeout: number }> }>;
    expect(pre[0]!.matcher).toBe(probe.shape.preToolUseMatcher);
    for (const h of pre[0]!.hooks) expect(h.timeout).toBe(probe.shape.hookTimeout);
  });
});

