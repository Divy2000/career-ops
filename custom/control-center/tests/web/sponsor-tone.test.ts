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
});
