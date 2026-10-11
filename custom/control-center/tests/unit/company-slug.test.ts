// The sponsorship check writes data/immigration/companies/<companySlug>.md, so the control center keys a company by
// the same rule (R24-FU-01c): one shared normalizer that must equal companySlug() in custom/immigration/lib.mjs.
import { describe, expect, it } from 'vitest';
import { companySlug } from '../../../immigration/lib.mjs';
import { sponsorCheckCompany } from '../../shared/company-slug.js';

describe('sponsorCheckCompany', () => {
  it('equals companySlug for names with punctuation, accents, ampersands, extra spaces and legal suffixes', () => {
    for (const name of ['Acme, Inc.', 'Acme Inc', '  acme   inc  ', 'Société Générale', 'Ben & Jerry\'s', 'AT&T', 'Procter & Gamble Co.', 'Foo-Bar LLC', 'Initech GmbH', 'Acme (US) Corp.', 'Zoë Ltd', 'O\'Reilly Media, LLC', 'Coinbase']) {
      expect(sponsorCheckCompany(name), name).toBe(companySlug(name));
    }
  });

  it('folds "Acme, Inc." and "Acme Inc" into one key', () => {
    expect(sponsorCheckCompany('Acme, Inc.')).toBe(sponsorCheckCompany('Acme Inc'));
  });

  it('keeps a name with nothing left after slugging as its trimmed lowercase self', () => {
    expect(sponsorCheckCompany(' 株式会社 ')).toBe('株式会社');
  });
});
