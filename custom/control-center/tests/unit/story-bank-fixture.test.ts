// The fixture story bank is in the shape story-provenance-check.mjs reads (### [Theme] Title, **Label:** lines), so the
// Interviews > Story provenance tab has rows to show: one claim cv.md backs and one marked user-cannot-confirm
// (SW3-tests-11).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { FIXTURE_ROOT } from '../helpers/app.js';

describe('the fixture story bank', () => {
  it('gives the provenance checker a claim cv.md backs and one the user cannot confirm', () => {
    const run = spawnSync(process.execPath, [path.join(DEFAULT_CODE_ROOT, 'story-provenance-check.mjs')], { cwd: DEFAULT_CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: FIXTURE_ROOT, NO_COLOR: '1' }, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { existing: Array<{ story: string; claim: string }>; userCannotConfirm: Array<{ story: string; claim: string }> };
    expect(out.existing.map((c) => [c.story, c.claim])).toContainEqual(['Led the platform team through a migration', '15-person']);
    expect(out.userCannotConfirm.map((c) => [c.story, c.claim])).toEqual([['Moved a batch pipeline to streaming', '85%']]);
  });
});
