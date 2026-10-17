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

  it('given a claim whose holder still runs but whose start ps cannot tell, however old, when checked, then it is held', () => {
    const file = path.join(tempDir('cc-claim-unknown-'), 'turn.claim');
    const text = JSON.stringify({ pid: process.pid, start: 1, at: Date.now() - 60 * 60_000 });
    expect(turnClaimGone(file, text, () => 'unknown')).toBe(false);
    expect(turnClaimGone(file, text, () => null)).toBe(true);
    expect(turnClaimGone(file, text, () => 2)).toBe(true);
  });

  it('given a claim whose holder recorded no start and still runs, however old, when checked, then it is held', () => {
    const file = path.join(tempDir('cc-claim-nostart-'), 'turn.claim');
    for (const start of [null, 'unknown']) expect(turnClaimGone(file, JSON.stringify({ pid: process.pid, start, at: Date.now() - 60 * 60_000 }), () => 5), String(start)).toBe(false);
    expect(turnClaimGone(file, JSON.stringify({ pid: process.pid, start: null, at: Date.now() }), () => null)).toBe(true);
  });

  it('given a claim naming no real process (pid 0 or below), when checked once it is old, then it reads as gone', () => {
    const file = path.join(tempDir('cc-claim-badpid-'), 'turn.claim');
    for (const pid of [0, -1]) expect(turnClaimGone(file, JSON.stringify({ pid, start: null, at: 0 }), () => 'unknown'), String(pid)).toBe(true);
  });
});
