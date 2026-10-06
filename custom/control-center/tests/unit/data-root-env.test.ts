import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataRootFromEnv } from '../../supervisor/data-root.js';
import { configFromEnv } from '../../server/config.js';

describe('dataRootFromEnv: did the data root come from the environment?', () => {
  it('is true when CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR holds a path', () => {
    expect(dataRootFromEnv({ CAREER_OPS_ROOT: '/data' })).toBe(true);
    expect(dataRootFromEnv({ CAREER_OPS_DATA_DIR: '/data' })).toBe(true);
  });
  it('is false when neither is set, or when they are empty or only whitespace (path-resolver trims them)', () => {
    expect(dataRootFromEnv({})).toBe(false);
    expect(dataRootFromEnv({ CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: '' })).toBe(false);
    expect(dataRootFromEnv({ CAREER_OPS_ROOT: '   ', CAREER_OPS_DATA_DIR: '\t\n' })).toBe(false);
  });
  it('is true when a blank CAREER_OPS_ROOT is followed by a real CAREER_OPS_DATA_DIR', () => {
    expect(dataRootFromEnv({ CAREER_OPS_ROOT: ' ', CAREER_OPS_DATA_DIR: '/data' })).toBe(true);
  });
});

describe('configFromEnv dataRootFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());
  // configFromEnv reads the required variables from process.env and the rest from its argument.
  beforeEach(() => {
    for (const [k, v] of Object.entries({ CC_DATA_ROOT: '/d', CC_GUARD_DIR: '/g', CC_TOKEN: 't', CC_SESSION_SECRET: 's' })) vi.stubEnv(k, v);
  });
  const base = { CC_PUBLIC_PORT: '4999' };
  it('is false only when the supervisor says the root did not come from the environment', () => {
    expect(configFromEnv({ ...base, CC_DATA_ROOT_FROM_ENV: '0' }).dataRootFromEnv).toBe(false);
    expect(configFromEnv({ ...base, CC_DATA_ROOT_FROM_ENV: '1' }).dataRootFromEnv).toBe(true);
  });
  it('defaults to pinning the root when the flag is absent', () => {
    expect(configFromEnv(base).dataRootFromEnv).toBe(true);
  });
});

describe('configFromEnv claudeBin', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    for (const [k, v] of Object.entries({ CC_DATA_ROOT: '/d', CC_GUARD_DIR: '/g', CC_TOKEN: 't', CC_SESSION_SECRET: 's' })) vi.stubEnv(k, v);
  });
  const base = { CC_PUBLIC_PORT: '4999', PATH: '' };
  it('resolves a relative CC_CLAUDE_BIN to an absolute path once, so sessions, the plist and Run the daily job now share it', () => {
    expect(configFromEnv({ ...base, CC_CLAUDE_BIN: './bin/claude', INIT_CWD: '/work/here' }).claudeBin).toBe('/work/here/bin/claude');
    expect(configFromEnv({ ...base, CC_CLAUDE_BIN: '/opt/custom/claude' }).claudeBin).toBe('/opt/custom/claude');
  });
});
