// Settings > AI engine reads the Keychain token state from /api/system/status through the same reader the sessions use
// (keychainTokenReader), so a locked keychain, a timeout or a missing `security` command reports why the token could not
// be read instead of "missing", whose fix (claude setup-token) would replace a token that is fine (R22-fu-5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { tempDir } from '../helpers/tmp.js';

/** A PATH whose `security` prints `stdout` and `stderr` and exits with `code`, as the real one does. */
function fakeSecurity(code: number, stderr: string, stdout = ''): void {
  const dir = tempDir('cc-fake-security-');
  fs.writeFileSync(path.join(dir, 'security'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
}

/** The app's own Keychain reader (no injected reader), with the test token shortcut off so `security` on PATH runs. */
async function readStatus(exec?: Exec, readToken?: () => Promise<string>) {
  vi.stubEnv('CC_FAKE_TOKEN', '');
  const t = await makeTestApp({}, { readToken, ...(exec ? { exec } : {}) });
  try {
    const res = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: t.authed });
    expect(res.statusCode).toBe(200);
    return res.json() as { keychainTokenPresent: boolean; keychainToken: { state: string; reason: string | null } };
  } finally {
    await t.close();
  }
}

describe('GET /api/system/status: the Keychain token state (R22-fu-5)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given a stored token, then it reports present', async () => {
    fakeSecurity(0, '', 'sk-ant-oat01-stored\n');
    const s = await readStatus();
    expect(s.keychainToken).toEqual({ state: 'present', reason: null });
    expect(s.keychainTokenPresent).toBe(true);
    expect(JSON.stringify(s)).not.toContain('sk-ant-oat01-stored');
  });

  it('given an absent item (security exits 44), then it reports missing', async () => {
    fakeSecurity(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
    const s = await readStatus();
    expect(s.keychainToken).toEqual({ state: 'missing', reason: null });
    expect(s.keychainTokenPresent).toBe(false);
  });

  it('given an empty stored token, then it reports missing', async () => {
    fakeSecurity(0, '', '\n');
    expect((await readStatus()).keychainToken).toEqual({ state: 'missing', reason: null });
  });

  it('given a locked keychain (security exits 36), then it reports unreadable with the reason and the unlock command', async () => {
    fakeSecurity(36, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n');
    const s = await readStatus();
    expect(s.keychainToken.state).toBe('unreadable');
    expect(s.keychainToken.reason).toContain('exit 36');
    expect(s.keychainToken.reason).toContain('User interaction is not allowed');
    expect(s.keychainToken.reason).toContain('security unlock-keychain');
    expect(s.keychainToken.reason).not.toContain('claude setup-token');
    expect(s.keychainTokenPresent).toBe(false);
  });

  it('given a read that times out, then it reports unreadable with the timeout', async () => {
    const exec: Exec = async (cmd, args, opts) =>
      cmd === 'security' ? { code: 124, stdout: '', stderr: '\nsecurity timed out after 5 s', timedOut: true } : execNoShell(cmd, args, opts);
    const s = await readStatus(exec);
    expect(s.keychainToken.state).toBe('unreadable');
    expect(s.keychainToken.reason).toContain('timed out');
    expect(s.keychainToken.reason).toContain('security unlock-keychain');
  });

  it('given no security command on PATH, then it reports unreadable saying the command was not found', async () => {
    const empty = tempDir('cc-empty-path-');
    // The fake claude binary still needs node on PATH; only `security` is absent.
    fs.symlinkSync(process.execPath, path.join(empty, 'node'));
    vi.stubEnv('PATH', empty);
    const s = await readStatus();
    expect(s.keychainToken.state).toBe('unreadable');
    expect(s.keychainToken.reason).toContain('the security command was not found on PATH');
    expect(s.keychainToken.reason).not.toContain('claude setup-token');
  });

  it('given a reader that fails without a message, then the unreadable reason still says the read failed', async () => {
    const s = await readStatus(undefined, async () => Promise.reject(new Error('')));
    expect(s.keychainToken.state).toBe('unreadable');
    expect(s.keychainToken.reason).toMatch(/\S/);
  });
});
