// The per-turn Keychain token read (keychainTokenReader) tells an absent token (security exits 44) apart from one it
// could not read (a locked keychain, no UI to prompt, a timeout, no security command), as the supervisor's preflight
// does: only an absent or empty token is worth replacing (R22-fu-4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { keychainTokenReader } from '../../server/claude/manager.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { tempDir } from '../helpers/tmp.js';

/** A PATH whose `security` prints `stdout` and `stderr` and exits with `code`, as the real one does. */
function fakeSecurity(code: number, stderr: string, stdout = ''): void {
  const dir = tempDir('cc-fake-security-');
  fs.writeFileSync(path.join(dir, 'security'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`);
}

/** Reads the token for real: the test token shortcut off, so `security` on PATH is what runs. */
const readToken = (exec: Exec = execNoShell) => {
  vi.stubEnv('CC_FAKE_TOKEN', '');
  return keychainTokenReader(exec)();
};

describe('keychainTokenReader (R22-fu-4)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given a stored token, when a turn reads it, then it gets the token', async () => {
    fakeSecurity(0, '', 'sk-ant-oat01-stored\n');
    await expect(readToken()).resolves.toBe('sk-ant-oat01-stored');
  });

  it('given a locked keychain (security exits 36), when a turn reads the token, then it says to unlock it instead of replacing the token', async () => {
    fakeSecurity(36, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n');
    const err = (await readToken().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('claude setup-token');
    expect(err.message).toContain('security unlock-keychain');
    expect(err.message).toContain('exit 36');
    expect(err.message).toContain('User interaction is not allowed');
  });

  it('given an absent item (security exits 44), when a turn reads the token, then it says how to store one', async () => {
    fakeSecurity(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n');
    const err = (await readToken().catch((e: Error) => e)) as Error;
    expect(err.message).toContain('claude setup-token');
    expect(err.message).not.toContain('unlock-keychain');
  });

  it('given an empty stored token, when a turn reads it, then it says how to store one', async () => {
    fakeSecurity(0, '', '\n');
    const err = (await readToken().catch((e: Error) => e)) as Error;
    expect(err.message).toContain('claude setup-token');
  });

  it('given a read that times out (an unanswered unlock dialog), when a turn reads the token, then it says to unlock the keychain', async () => {
    const exec: Exec = async () => ({ code: 124, stdout: '', stderr: '\nsecurity timed out after 5 s', timedOut: true });
    const err = (await readToken(exec).catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain('claude setup-token');
    expect(err.message).toContain('timed out');
    expect(err.message).toContain('security unlock-keychain');
  });

  it('given no security command on PATH, when a turn reads the token, then it says the command was not found instead of replacing the token', async () => {
    vi.stubEnv('PATH', tempDir('cc-empty-path-'));
    const err = (await readToken().catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain('claude setup-token');
    expect(err.message).not.toContain('unlock-keychain');
    expect(err.message).toContain('the security command was not found on PATH');
  });
});
