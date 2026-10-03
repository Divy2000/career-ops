import { describe, expect, it } from 'vitest';
import { preflight, versionAtLeast, KEYCHAIN_HELP, NODE_FLOOR } from '../../supervisor/preflight.js';

const execOk = async () => 0;

describe('preflight', () => {
  it('compares versions numerically against the Node floor', () => {
    expect(versionAtLeast('v22.6.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v26.4.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v22.5.9', NODE_FLOOR)).toBe(false);
    expect(versionAtLeast('v9.99.0', NODE_FLOOR)).toBe(false);
  });

  it('passes with a runnable claude, a Keychain item and no API key', async () => {
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec: execOk });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('fails loudly when the claude binary is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'claude' ? 127 : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('CC_CLAUDE_BIN');
  });

  it('prints the setup-token instructions when the Keychain item is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(KEYCHAIN_HELP);
  });

  it('skips the Keychain check under NODE_ENV=test so the fake Claude runs anywhere', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' }, exec });
    expect(r.ok).toBe(true);
  });

  it('fails below the Node floor and warns about ANTHROPIC_API_KEY', async () => {
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v20.0.0', env: { ANTHROPIC_API_KEY: 'x' }, exec: execOk });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('below the floor');
    expect(r.warnings[0]).toContain('ANTHROPIC_API_KEY');
  });
});
