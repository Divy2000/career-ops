// /api/system/status says whether the Claude token is stored by asking the token reader the sessions use, so the
// tests (an injected reader) and the e2e apps (CC_FAKE_TOKEN) never run `security` against the developer's Keychain
// (SW-tests-18).
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../helpers/app.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';

describe('GET /api/system/status: the stored token', () => {
  for (const [stored, readToken] of [
    [true, async () => 'tok'],
    [false, async () => Promise.reject(new Error('Keychain item career-ops-claude-token not found'))],
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
        expect(calls).not.toContain('security');
      } finally {
        await t.close();
      }
    });
  }
});
