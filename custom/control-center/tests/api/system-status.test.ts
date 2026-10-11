// /api/system/status says whether the Claude token is stored by asking the token reader the sessions use, so the
// tests (an injected reader) and the e2e apps (CC_FAKE_TOKEN) never run `security` against the developer's Keychain
// (SW-tests-18).
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

describe('GET /api/system/status: the stored token', () => {
  for (const [stored, readToken] of [
    [true, async () => 'tok'],
    [false, async () => Promise.reject(new Error('Keychain item career-ops-claude-token not found. Run: claude setup-token, then security add-generic-password -U -a "$USER" -s career-ops-claude-token -w'))],
  ] as const) {
    it(`reports keychainTokenPresent ${stored} from the token reader and never runs security itself`, async () => {
      const calls: string[] = [];
      const exec: Exec = (cmd, args, opts) => {
        calls.push(cmd);
        return execNoShell(cmd, args, opts);
      };
      const t = await makeTestApp({}, { exec, readToken });
      try {
        const res = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: t.authed });
        expect(res.statusCode).toBe(200);
        expect(res.json().keychainTokenPresent).toBe(stored);
        expect(res.json().keychainToken.state).toBe(stored ? 'present' : 'missing');
        expect(calls).not.toContain('security');
      } finally {
        await t.close();
      }
    });
  }
});

describe('execNoShell: a command that runs out of time (R17-srv-core-L3-02)', () => {
  it('reports a timeout as timed out (exit 124), not as exit 1, so no exit map reads it as a script failure', async () => {
    const r = await execNoShell(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { timeoutMs: 300 });
    expect(r).toMatchObject({ code: 124, timedOut: true });
    expect(r.stderr).toMatch(/timed out after 0\.3 s/);
  });

  it('still reports a command that fails on its own with its exit code', async () => {
    const r = await execNoShell(process.execPath, ['-e', 'process.exit(1)'], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 1, timedOut: false });
  });
});
