import { describe, expect, it } from 'vitest';
import { emptyReason } from '../../web/lib/insightEmpty';

describe('emptyReason', () => {
  it('returns the message of a script that reports missing data as an error object', () => {
    expect(emptyReason({ error: 'No applications found in tracker.', noData: true })).toBe('No applications found in tracker.');
    expect(emptyReason({ error: 'Not enough data: 0/5 scored reports. Evaluate more offers and come back.', current: 0, threshold: 5 })).toBe('Not enough data: 0/5 scored reports. Evaluate more offers and come back.');
  });

  it('returns null for real results and for non-objects', () => {
    expect(emptyReason({ metadata: {}, signals: [] })).toBeNull();
    expect(emptyReason(null)).toBeNull();
    expect(emptyReason('text')).toBeNull();
    expect(emptyReason([{ error: 'x' }])).toBeNull();
    expect(emptyReason({ error: '' })).toBeNull();
    expect(emptyReason({ error: { code: 1 } })).toBeNull();
  });
});
