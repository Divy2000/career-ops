// The paid sponsorship check is guarded per company file: Sponsorship > Lookup names the company by its DOL entity
// ("STRIPE, INC.") and an application's Sponsorship tab by its tracker name ("Stripe"), but both checks write
// data/immigration/companies/<companySlug>.md, so the guard key folds names the way that slug does (R13-feat-c-L1-02,
// R13-feat-c-L2-01, R13-feat-c-L3-01).
import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped core helper (pure, no I/O)
import { companySlug } from '../../../immigration/lib.mjs';
import { sponsorCheckCompany } from '@web/features/sponsorship/companyKey';

describe('sponsorCheckCompany', () => {
  it('folds a DOL entity name and the tracker name of one company together', () => {
    expect(sponsorCheckCompany('STRIPE, INC.')).toBe(sponsorCheckCompany('Stripe'));
    expect(sponsorCheckCompany('GOOGLE LLC')).toBe(sponsorCheckCompany(' google '));
  });

  it('is the slug the company file is named by', () => {
    for (const name of ['STRIPE, INC.', 'GOOGLE LLC', 'AT&T', 'AT T', 'JPMorgan Chase & Co.', 'Acme (US) Corp', 'Initech GmbH', 'Café Ltd']) {
      expect(sponsorCheckCompany(name)).toBe(companySlug(name));
    }
  });

  it('keeps names with nothing left after slugging apart instead of folding them into one key', () => {
    expect(sponsorCheckCompany('株式会社')).not.toBe(sponsorCheckCompany('Ltd'));
    expect(sponsorCheckCompany('株式会社')).toBe('株式会社');
  });
});
