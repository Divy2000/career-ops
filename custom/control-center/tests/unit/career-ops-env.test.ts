// The suites run against fixture roots only: a CAREER_OPS_* override exported in the developer's shell
// (CAREER_OPS_TRACKER, _PIPELINE, _PORTALS and the rest outrank the data root in path-resolver.mjs and scan.mjs)
// must never reach a test or the scripts it spawns (SW-tests-10).
import { describe, expect, it } from 'vitest';
import { dropCareerOpsOverrides } from '../helpers/env.js';

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
