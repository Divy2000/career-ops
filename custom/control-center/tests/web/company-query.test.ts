import { describe, expect, it } from 'vitest';
import { MAX_COMPANY_QUERY_LENGTH, parseCompanyQuery } from '@shared/companyQuery';

describe('parseCompanyQuery', () => {
  it('trims a valid name', () => {
    expect(parseCompanyQuery('  Acme Robotics  ')).toEqual({ ok: true, value: 'Acme Robotics' });
  });

  it('accepts names with punctuation that a shell would treat specially, since they are never given to a shell', () => {
    expect(parseCompanyQuery('AT&T (Services) Inc.')).toEqual({ ok: true, value: 'AT&T (Services) Inc.' });
  });

  it('accepts the longest allowed name and rejects one more character', () => {
    expect(parseCompanyQuery('a'.repeat(MAX_COMPANY_QUERY_LENGTH)).ok).toBe(true);
    expect(parseCompanyQuery('a'.repeat(MAX_COMPANY_QUERY_LENGTH + 1)).ok).toBe(false);
  });

  it.each([undefined, null, 42, '', '   '])('rejects a missing or blank value (%s)', (v) => {
    expect(parseCompanyQuery(v)).toEqual({ ok: false, error: 'a company name is required' });
  });

  it.each(['a\nb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u009fb'])('rejects control characters (%j)', (v) => {
    expect(parseCompanyQuery(v)).toEqual({ ok: false, error: 'the company name contains control characters' });
  });

  it('rejects a leading dash', () => {
    expect(parseCompanyQuery('-x')).toEqual({ ok: false, error: 'the company name must not start with a dash' });
  });
});
