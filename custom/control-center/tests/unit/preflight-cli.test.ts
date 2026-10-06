import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPreflightCli } from '../../supervisor/preflight-cli.js';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

function fakeClaude(body: string): string {
  const dir = tempDir('cc-pfcli-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

/** The host these checks assume, never this machine's: macOS and no managed settings (Linux or an MDM profile would fail them). */
const host = () => ({ platform: 'darwin' as const, managedSettings: { dir: tempDir('cc-managed-'), plists: [] } });

describe('runPreflightCli', () => {
  it('exits 1 and prints the error when CC_CLAUDE_BIN does not exist', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: '/nonexistent/claude', NODE_ENV: 'test' }, nodeVersion: 'v26.0.0', ...host() });
    expect(r.code).toBe(1);
    expect(r.output).toContain('error: Claude CLI not runnable at "/nonexistent/claude"');
    expect(r.output).toContain('not found (ENOENT)');
  });

  it('exits 0 and says so when everything passes', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test' }, nodeVersion: 'v26.0.0', ...host() });
    expect(r.code).toBe(0);
    expect(r.output).toContain('preflight ok');
  });

  it('exits 1 below the Node floor, and on a version above it that the dependencies do not support', async () => {
    for (const nodeVersion of ['v20.0.0', 'v23.0.0', 'v24.14.0', 'v25.0.0']) {
      const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test' }, nodeVersion, ...host() });
      expect(r.code, nodeVersion).toBe(1);
      // Requirement change: the message names the supported versions (it said "below the floor").
      expect(r.output, nodeVersion).toContain(`Node ${nodeVersion.slice(1)} is not supported; use 22.22.2+, 24.15+ or 26+`);
    }
  });

  it('an unapproved Claude Code version is a warning, not an error: exits 0 so the app starts and only sessions are refused', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('2.1.290 (Claude Code)');"), NODE_ENV: 'test' }, nodeVersion: 'v26.0.0', ...host() });
    expect(r.code).toBe(0);
    expect(r.output).toContain('warning: Claude Code 2.1.290 is not approved');
    expect(r.output).not.toContain('error:');
    expect(r.output).toContain('preflight ok');
  });

  it('keeps warnings in the output but exits 0', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, nodeVersion: 'v26.0.0', ...host() });
    expect(r.code).toBe(0);
    expect(r.output).toContain('warning: ANTHROPIC_API_KEY');
    expect(r.output).toContain('preflight ok');
  });
});

describe('npm run preflight entry point', () => {
  const tsx = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
  // tsx keeps its IPC dir (tsx-<uid>) in the temp dir; give it one that is removed with the file.
  const tmp = tempDir('cc-pfcli-tsx-');
  // A pinned host (NODE_ENV=test only), so the entry point never passes or fails with this machine's platform or MDM settings.
  const pinnedHost = { CC_FAKE_PLATFORM: 'darwin', CC_FAKE_MANAGED_SETTINGS_DIR: tempDir('cc-pfcli-managed-') };
  const run = (env: Record<string, string>) =>
    spawnSync(tsx, [path.join(PACKAGE_ROOT, 'supervisor', 'preflight-cli.ts')], {
      env: { ...process.env, NODE_ENV: 'test', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...pinnedHost, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('checks the pinned host, not this machine: a pinned Linux or an unconfinable managed setting is refused (SW4-tests-22)', () => {
    const linux = run({ CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), CC_FAKE_PLATFORM: 'linux' });
    expect(linux.status, linux.stdout + linux.stderr).toBe(1);
    expect(linux.stderr).toMatch(/runs on macOS only \(this is linux\)/);
    const managed = tempDir('cc-pfcli-managed-bad-');
    fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify({ disableAllHooks: true }));
    const mdm = run({ CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), CC_FAKE_MANAGED_SETTINGS_DIR: managed });
    expect(mdm.status, mdm.stdout + mdm.stderr).toBe(1);
    expect(mdm.stderr).toContain('set disableAllHooks');
  });

  it('really exits non-zero for CC_CLAUDE_BIN=/nonexistent', () => {
    const r = run({ CC_CLAUDE_BIN: '/nonexistent' });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('Claude CLI not runnable');
  });

  it('really exits 0 with a runnable claude', () => {
    const r = run({ CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('preflight ok');
  });

  it('is wired as the preflight npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.preflight).toBe('tsx supervisor/preflight-cli.ts');
  });
});
