import { describe, expect, it } from 'vitest';
import { localDate, localDatePlusDays } from '@shared/local-date';

describe('local calendar dates', () => {
  it('runs under the pinned non-UTC test timezone, or the assertions below prove nothing', () => {
    expect(new Date(2026, 9, 4, 8).getTimezoneOffset()).toBe(420);
  });

  it('today is the local day: a US evening is still today, though UTC has moved on', () => {
    const evening = new Date(2026, 9, 5, 19, 0);
    expect(evening.toISOString().slice(0, 10)).toBe('2026-10-06');
    expect(localDate(evening)).toBe('2026-10-05');
    expect(localDate(new Date(2026, 9, 5, 0, 5))).toBe('2026-10-05');
    expect(localDate(new Date(2026, 0, 9, 12, 0))).toBe('2026-01-09');
  });

  it('adds whole local days, across a month end and a DST change', () => {
    expect(localDatePlusDays(7, new Date(2026, 9, 5, 19, 0))).toBe('2026-10-12');
    expect(localDatePlusDays(7, new Date(2026, 9, 28, 23, 30))).toBe('2026-11-04');
    expect(localDatePlusDays(1, new Date(2026, 10, 1, 0, 30))).toBe('2026-11-02');
    expect(localDatePlusDays(0, new Date(2026, 9, 5, 19, 0))).toBe('2026-10-05');
  });
});
