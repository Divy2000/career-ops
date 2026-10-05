import { describe, expect, it } from 'vitest';
import { formatLocalClock, formatLocalMinute } from '../../web/lib/time';

describe('formatLocalMinute', () => {
  it('runs under the pinned non-UTC test timezone, or the local-time assertions below prove nothing', () => {
    expect(new Date(2026, 9, 4, 8).getTimezoneOffset()).toBe(420);
  });

  it('shows the local wall clock, not the UTC one', () => {
    expect(formatLocalMinute(new Date(2026, 9, 4, 3, 5).toISOString())).toBe('2026-10-04 03:05');
    expect(formatLocalMinute(new Date(2026, 0, 1, 23, 59).toISOString())).toBe('2026-01-01 23:59');
  });
  it('returns the input unchanged when it is not a date', () => {
    expect(formatLocalMinute('soon')).toBe('soon');
  });
});

describe('formatLocalClock', () => {
  it('shows the local time of day to the second, not the UTC one', () => {
    expect(formatLocalClock('2026-10-06T02:07:09.000Z')).toBe('19:07:09');
    expect(formatLocalClock(new Date(2026, 0, 1, 0, 0, 5).toISOString())).toBe('00:00:05');
  });
  it('returns the input unchanged when it is not a date', () => {
    expect(formatLocalClock('soon')).toBe('soon');
  });
});
