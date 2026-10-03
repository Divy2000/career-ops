import { describe, expect, it } from 'vitest';
import { summarizeDigest } from '../../web/lib/digestSummary';

const LONG = 'https://www.federalregister.gov/documents/2026/09/30/2026-00001/weighted-selection-process-for-registrants';

describe('summarizeDigest', () => {
  it('keeps only the bold lead of a bullet that has one', () => {
    const body = `- **H-1B lottery is now wage-weighted (final rule published 2025-12-29).** Each unique beneficiary gets entries. Sources: [Federal Register](${LONG}).\n- **Second.** More text.`;
    expect(summarizeDigest(body)).toEqual(['**H-1B lottery is now wage-weighted (final rule published 2025-12-29).**', '**Second.**']);
  });

  it('keeps the first sentence of a bullet without a bold lead', () => {
    expect(summarizeDigest('- Proposed rule on a new petition fee published for comment. Nothing else changes.\n* Agency page updated; premium unchanged.')).toEqual(['Proposed rule on a new petition fee published for comment.', 'Agency page updated; premium unchanged.']);
  });

  it('replaces a bare URL with its host and keeps markdown link text', () => {
    expect(summarizeDigest(`- See ${LONG} for details.`)).toEqual(['See www.federalregister.gov for details.']);
    expect(summarizeDigest(`- Read [the rule](${LONG}) today. More.`)).toEqual([`Read [the rule](${LONG}) today.`]);
  });

  it('limits the number of bullets and the length of each', () => {
    const body = Array.from({ length: 6 }, (_, i) => `- Item ${i}.`).join('\n');
    expect(summarizeDigest(body)).toHaveLength(4);
    expect(summarizeDigest(body, 2)).toEqual(['Item 0.', 'Item 1.']);
    const long = summarizeDigest(`- ${'word '.repeat(80)}`)[0]!;
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith('…')).toBe(true);
  });

  it('ignores headings, prose and nested bullets', () => {
    expect(summarizeDigest('### Company alerts today\nsome prose\n- Real bullet.\n  - nested bullet')).toEqual(['Real bullet.']);
    expect(summarizeDigest('')).toEqual([]);
  });
});
