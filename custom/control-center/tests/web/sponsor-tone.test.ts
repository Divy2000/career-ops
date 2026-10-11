// The sponsor pill takes either a DOL tier (strong, moderate, ...) or a company check's verdict, which the sponsorship
// check writes as sponsoring | paused | stopped | restricted | unclear (custom/install/templates/_custom-sponsorship.md).
// paused, stopped and restricted are hard blockers there, so they must not look like a sponsoring company (SW-tests-01).
import { describe, expect, it } from 'vitest';
import { sponsorTone } from '@web/components/ui';

describe('sponsor pill tone', () => {
  it.each([
    ['sponsoring', 'ok'],
    ['paused', 'danger'],
    ['stopped', 'danger'],
    ['Restricted', 'danger'],
    ['unclear', 'warn'],
  ])('a company check verdict %s reads as %s', (verdict, tone) => {
    expect(sponsorTone(verdict)).toBe(tone);
  });

  it.each([
    ['strong', 'ok'],
    ['moderate', 'info'],
    ['weak', 'warn'],
    ['none', 'danger'],
    ['staffing-shop', 'danger'],
    [null, 'neutral'],
  ])('a DOL tier %s keeps its tone %s', (tier, tone) => {
    expect(sponsorTone(tier)).toBe(tone);
  });

  // A company file with no verdict yet falls back to its whole dol_tier line, which check.mjs writes as the tier plus
  // its counts (custom/install/templates/_custom-sponsorship.md), so the tone comes from the leading tier word (R25-shared-comp-L2-02).
  it.each([
    ['staffing-shop (900 LCAs, 82% secondary)', 'danger'],
    ['strong (120 LCAs FY2025)', 'ok'],
    ['Moderate (40 LCAs)', 'info'],
    ['weak (3 LCAs)', 'warn'],
  ])('a dol_tier line %s reads as %s', (line, tone) => {
    expect(sponsorTone(line)).toBe(tone);
  });
});
