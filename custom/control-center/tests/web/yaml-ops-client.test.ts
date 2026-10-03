import { describe, expect, it } from 'vitest';
import { applyOpJs, applyOpsJs } from '../../web/lib/yamlOpsClient';

describe('client-side yaml ops mirror', () => {
  const doc = { title_filter: { include: ['backend'] }, tracked_companies: [{ name: 'A', enabled: true }], max_posting_age_days: 30 };
  it('set replaces a nested value and creates missing containers without mutating the input', () => {
    const out = applyOpJs(doc, { op: 'set', path: ['tracked_companies', 0, 'enabled'], value: false }) as typeof doc;
    expect(out.tracked_companies[0]!.enabled).toBe(false);
    expect(doc.tracked_companies[0]!.enabled).toBe(true);
    const created = applyOpJs({}, { op: 'set', path: ['followup_cadence', 'applied_first_days'], value: 10 }) as Record<string, Record<string, number>>;
    expect(created.followup_cadence!.applied_first_days).toBe(10);
    expect(applyOpJs(null, { op: 'set', path: ['a'], value: 1 })).toEqual({ a: 1 });
  });
  it('insert appends or inserts at an index, delete removes keys and list items', () => {
    const out = applyOpsJs(doc, [
      { op: 'insert', path: ['title_filter', 'include'], index: 0, value: 'platform' },
      { op: 'insert', path: ['search_queries'], value: 'staff engineer' },
      { op: 'delete', path: ['max_posting_age_days'] },
      { op: 'delete', path: ['tracked_companies', 0] },
    ]) as Record<string, unknown>;
    expect((out.title_filter as { include: string[] }).include).toEqual(['platform', 'backend']);
    expect(out.search_queries).toEqual(['staff engineer']);
    expect('max_posting_age_days' in out).toBe(false);
    expect(out.tracked_companies).toEqual([]);
  });
});
