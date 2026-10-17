import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { turnClaimGone } from '../../server/claude/manager.js';
import { tempDir } from '../helpers/tmp.js';

// R28-claude-X-01 review: a holder may remove its claim between the read and the age check.
describe('turnClaimGone', () => {
  it('given a claim cut short or missing its holder that is removed before its age is read, when checked, then it reads as gone', () => {
    const file = path.join(tempDir('cc-claim-gone-'), 'turn.claim');
    for (const text of ['{"pid":', JSON.stringify({ start: 1 })]) expect(turnClaimGone(file, text), text).toBe(true);
  });
});
