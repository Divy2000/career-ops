import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runPreflightCli } from '../../supervisor/preflight-cli.js';
import { preflight, KEYCHAIN_HELP } from '../../supervisor/preflight.js';
import { tempDir } from '../helpers/tmp.js';

/** The host these checks assume, never this machine's: macOS and no managed settings. */
const host = () => ({ platform: 'darwin' as const, managedSettings: { dir: tempDir('cc-managed-'), plists: [] } });

function fakeBin(dir: string, name: string, body: string): string {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

/** A PATH whose `security` exits with `code` and prints `stderr`, as the real one does for a locked or absent item. */
function fakeSecurity(code: number, stderr: string): void {
  const dir = tempDir('cc-fake-security-');
  fakeBin(dir, 'security', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});`);
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
}

async function runWithKeychain(): Promise<{ code: number; output: string }> {
  const claude = fakeBin(tempDir('cc-pfcli-'), 'claude', "console.log('0.0.0-fake');");
  // CC_SKIP_KEYCHAIN=0 runs the Keychain probe under NODE_ENV=test.
  return runPreflightCli({ env: { CC_CLAUDE_BIN: claude, NODE_ENV: 'test', CC_SKIP_KEYCHAIN: '0' }, nodeVersion: 'v26.0.0', ...host() });
}

describe('preflight Keychain probe', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given a locked keychain (security exits 36), says to unlock it instead of replacing the token', async () => {
    fakeSecurity(36, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n');
    const r = await runWithKeychain();
    expect(r.code).toBe(1);
    expect(r.output).not.toContain(KEYCHAIN_HELP);
    expect(r.output).not.toContain('claude setup-token');
    expect(r.output).toContain('security unlock-keychain');
    expect(r.output).toContain('exit 36');
    expect(r.output).toContain('User interaction is not allowed');
  });

  it('given an absent item (security exits 44), prints the setup-token instructions', async () => {
    fakeSecurity(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
    const r = await runWithKeychain();
    expect(r.code).toBe(1);
    expect(r.output).toContain(KEYCHAIN_HELP);
    expect(r.output).not.toContain('unlock-keychain');
  });

  it('given a Keychain probe that times out (an unanswered unlock dialog), says to unlock it instead of replacing the token', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? { code: 1, stdout: '', stderr: '', timedOut: true } : { code: 0, stdout: '2.1.289 (Claude Code)\n' });
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec, approvedVersions: ['2.1.289'] });
    expect(r.ok).toBe(false);
    expect(r.errors).not.toContain(KEYCHAIN_HELP);
    expect(r.errors.join('\n')).toContain('timed out');
    expect(r.errors.join('\n')).toContain('security unlock-keychain');
  });

  it('given a `security` that is not on PATH, says the command is missing instead of a locked keychain', async () => {
    vi.stubEnv('PATH', tempDir('cc-no-security-'));
    const r = await runWithKeychain();
    expect(r.code).toBe(1);
    expect(r.output).not.toContain(KEYCHAIN_HELP);
    expect(r.output).not.toContain('unlock-keychain');
    expect(r.output).toContain('`security` command was not found');
  });

  it('given an item that holds an empty password, prints the setup-token instructions as a session would', async () => {
    fakeSecurity(0, '');
    const r = await runWithKeychain();
    expect(r.code).toBe(1);
    expect(r.output).toContain(KEYCHAIN_HELP);
  });

  it('given a real `security` that never answers, the probe times out and says to unlock the keychain', async () => {
    const dir = tempDir('cc-slow-security-');
    fakeBin(dir, 'security', 'setTimeout(() => {}, 30_000);');
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
    const claude = fakeBin(tempDir('cc-pfcli-'), 'claude', "console.log('0.0.0-fake');");
    const r = await preflight({ ...host(), claudeBin: claude, nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test', CC_SKIP_KEYCHAIN: '0' }, keychainTimeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.errors).not.toContain(KEYCHAIN_HELP);
    expect(r.errors.join('\n')).toContain('timed out');
    expect(r.errors.join('\n')).toContain('security unlock-keychain');
  });

  it('given a `security` that ran and exited 127, says to unlock the keychain, not that the command is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? { code: 127, stdout: '', stderr: 'security: unknown failure' } : { code: 0, stdout: '2.1.289 (Claude Code)\n' });
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec, approvedVersions: ['2.1.289'] });
    expect(r.errors.join('\n')).toContain('security unlock-keychain');
    expect(r.errors.join('\n')).not.toContain('was not found on PATH');
  });

  it('given an injected `claude --version` that timed out, reports the timeout', async () => {
    const exec = async (cmd: string) => (cmd === 'claude' ? { code: 1, stdout: '', timedOut: true } : 0);
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec, claudeTimeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('timed out');
  });

  it('given an injected `claude --version` that never started, reports ENOENT whatever its code', async () => {
    const exec = async (cmd: string) => (cmd === 'claude' ? { code: 1, stdout: '', enoent: true } : 0);
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.errors[0]).toContain('not found (ENOENT)');
  });
});
