import { describe, expect, it } from 'vitest';
import { formatCount } from '../../web/lib/format';

describe('formatCount', () => {
  it('groups thousands with commas in en-US', () => {
    expect(formatCount(66934)).toBe('66,934');
    expect(formatCount(1234567)).toBe('1,234,567');
  });
  it('leaves numbers below a thousand and zero untouched', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });
  it('does not depend on the process locale', () => {
    expect(formatCount(1000)).toBe('1,000');
  });
});
