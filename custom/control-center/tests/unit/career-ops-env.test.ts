// The suites run against fixture roots only: a CAREER_OPS_* override exported in the developer's shell
// (CAREER_OPS_TRACKER, _PIPELINE, _PORTALS and the rest outrank the data root in path-resolver.mjs and scan.mjs)
// must never reach a test or the scripts it spawns (SW-tests-10).
import { describe, expect, it } from 'vitest';
import { dropCareerOpsOverrides, dropSessionEnv } from '../helpers/env.js';

describe('CAREER_OPS_* overrides in the test environment', () => {
  it('dropCareerOpsOverrides removes every CAREER_OPS_ variable and nothing else, and names what it removed', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', CAREER_OPS_TRACKER: '/real/applications.md', CAREER_OPS_ROOT: '/real', CAREER_OPS_PIPELINE: '/real/pipeline.md', CC_PORT: '1' };
    expect(dropCareerOpsOverrides(env).sort()).toEqual(['CAREER_OPS_PIPELINE', 'CAREER_OPS_ROOT', 'CAREER_OPS_TRACKER']);
    expect(env).toEqual({ PATH: '/bin', CC_PORT: '1' });
  });

  it('a test worker carries none, whatever the shell that started vitest exported', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('CAREER_OPS_'))).toEqual([]);
  });
});

// Dev Chat may run this suite (npx vitest run): its Bash commands carry the turn's CC_TURN_DIR, CC_SESSION_DIR, CC_POLICY_*
// and CC_MODE, and a guard hook a test runs would put its snapshots into that live turn (SW4-tests-02).
describe('a Claude session\'s variables in the test environment', () => {
  it('dropSessionEnv removes the variables a session turn sets and nothing else', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', CC_TURN_DIR: '/g/s/turns/3', CC_SESSION_DIR: '/g/s', CC_POLICY_FILE: '/g/s/turns/3/policy.json', CC_POLICY_SHA256: 'ab', CC_MODE: 'devchat', CC_PORT: '1' };
    expect(dropSessionEnv(env).sort()).toEqual(['CC_MODE', 'CC_POLICY_FILE', 'CC_POLICY_SHA256', 'CC_SESSION_DIR', 'CC_TURN_DIR']);
    expect(env).toEqual({ PATH: '/bin', CC_PORT: '1' });
  });

  it('a test worker carries none of them, even when vitest runs inside a session turn', () => {
    expect(['CC_TURN_DIR', 'CC_SESSION_DIR', 'CC_POLICY_FILE', 'CC_POLICY_SHA256', 'CC_MODE'].filter((k) => k in process.env)).toEqual([]);
  });
});
