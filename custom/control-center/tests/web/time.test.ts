import { describe, expect, it } from 'vitest';
import { formatLocalMinute } from '../../web/lib/time';

describe('formatLocalMinute', () => {
  it('shows the local wall clock, not the UTC one', () => {
    expect(formatLocalMinute(new Date(2026, 9, 4, 3, 5).toISOString())).toBe('2026-10-04 03:05');
    expect(formatLocalMinute(new Date(2026, 0, 1, 23, 59).toISOString())).toBe('2026-01-01 23:59');
  });
  it('returns the input unchanged when it is not a date', () => {
    expect(formatLocalMinute('soon')).toBe('soon');
  });
});
