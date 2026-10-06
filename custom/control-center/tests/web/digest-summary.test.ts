import { describe, expect, it } from 'vitest';
import { summarizeDigest, spansText, type DigestSpan } from '../../web/lib/digestSummary';

const LONG = 'https://www.federalregister.gov/documents/2026/09/30/2026-00001/weighted-selection-process-for-registrants';
const lines = (body: string, max?: number) => summarizeDigest(body, max).map(spansText);

describe('summarizeDigest', () => {
  it('keeps only the bold lead of a bullet that has one', () => {
    const body = `- **H-1B lottery is now wage-weighted (final rule published 2025-12-29).** Each unique beneficiary gets entries. Sources: [Federal Register](${LONG}).\n- **Second.** More text.`;
    expect(lines(body)).toEqual(['H-1B lottery is now wage-weighted (final rule published 2025-12-29).', 'Second.']);
    expect(summarizeDigest(body)[0]).toEqual([{ text: 'H-1B lottery is now wage-weighted (final rule published 2025-12-29).', bold: true }]);
  });

  it('keeps the first sentence of a bullet without a bold lead', () => {
    expect(lines('- Proposed rule on a new petition fee published for comment. Nothing else changes.\n* Agency page updated; premium unchanged.')).toEqual(['Proposed rule on a new petition fee published for comment.', 'Agency page updated; premium unchanged.']);
  });

  it('does not end the first sentence at an abbreviation (U.S., Oct., e.g., No., Dr.) (SW3-web-a-08)', () => {
    expect(lines('- The U.S. State Department paused H-1B stamping in India until Oct. 15. [source](https://state.gov/x)')).toEqual(['The U.S. State Department paused H-1B stamping in India until Oct. 15.']);
    expect(lines('- Fees rise for some forms, e.g. the I-129, under Rule No. 5 from Dr. Smith. Later text.')).toEqual(['Fees rise for some forms, e.g. the I-129, under Rule No. 5 from Dr. Smith.']);
  });

  it('recognises an abbreviation after an opening bracket or quote (SW3-web-a-08 review)', () => {
    expect(lines('- Stamping paused (U.S. State Department) until further notice. Later text.')).toEqual(['Stamping paused (U.S. State Department) until further notice.']);
    expect(lines('- Some forms ("e.g. Form I-129") cost more. Later text.')).toEqual(['Some forms ("e.g. Form I-129") cost more.']);
    expect(lines('- A memo [Dr. Smith] explains the change. Later text.')).toEqual(['A memo [Dr. Smith] explains the change.']);
  });

  it('a sentence that really ends at an abbreviation runs on into the next: a whole bullet is better than "the U."', () => {
    expect(lines('- The rule applies in the U.S. Employers must file by Monday.')).toEqual(['The rule applies in the U.S. Employers must file by Monday.']);
  });

  it('still ends the first sentence at a period before the next sentence', () => {
    expect(lines('- USCIS updated the fee page. The premium fee is unchanged.')).toEqual(['USCIS updated the fee page.']);
    expect(lines('- Processing paused! Check back Monday.')).toEqual(['Processing paused!']);
  });

  it('shows a bare URL as its host but keeps the full address as the link target', () => {
    expect(summarizeDigest(`- See ${LONG} for details.`)[0]).toEqual([{ text: 'See ' }, { text: 'www.federalregister.gov', href: LONG }, { text: ' for details.' }]);
  });

  it('keeps an <https://...> autolink as a link instead of dropping it', () => {
    expect(summarizeDigest('- See <https://www.uscis.gov/x>.')[0]).toEqual([{ text: 'See ' }, { text: 'www.uscis.gov', href: 'https://www.uscis.gov/x' }, { text: '.' }]);
  });

  it('keeps markdown link text and target together', () => {
    expect(summarizeDigest(`- Read [the rule](${LONG}) today. More.`)[0]).toEqual([{ text: 'Read ' }, { text: 'the rule', href: LONG }, { text: ' today.' }]);
  });

  it('never cuts a link in half when clipping a long sentence', () => {
    const body = `- ${'word '.repeat(30)}[cap reached and a very long link label that crosses the limit](${LONG}) tail`;
    const spans = summarizeDigest(body)[0]!;
    const link = spans.find((s: DigestSpan) => s.href);
    expect(link === undefined || link.text === 'cap reached and a very long link label that crosses the limit').toBe(true);
    expect(spansText(spans)).not.toMatch(/\[|\]\(/);
    expect(spansText(spans).length).toBeLessThanOrEqual(200);
  });

  it('limits the number of bullets and the rendered length of each', () => {
    const body = Array.from({ length: 6 }, (_, i) => `- Item ${i}.`).join('\n');
    expect(summarizeDigest(body)).toHaveLength(4);
    expect(lines(body, 2)).toEqual(['Item 0.', 'Item 1.']);
    const long = lines(`- ${'word '.repeat(80)}`)[0]!;
    expect(long.length).toBeLessThanOrEqual(161);
    expect(long.endsWith('…')).toBe(true);
    const boldLong = summarizeDigest(`- **${'word '.repeat(80).trim()}** rest`)[0]!;
    expect(boldLong.every((s) => s.bold)).toBe(true);
    expect(spansText(boldLong).endsWith('…')).toBe(true);
  });

  it('counts rendered text, not markdown syntax, against the limit', () => {
    const link = `[${'a'.repeat(100)}](${LONG}${'/x'.repeat(100)})`;
    expect(lines(`- ${link}`)[0]).toBe('a'.repeat(100));
  });

  it('ignores headings, prose and nested bullets, and drops raw HTML and images', () => {
    expect(lines('### Company alerts today\nsome prose\n- Real bullet.\n  - nested bullet')).toEqual(['Real bullet.']);
    expect(lines('- Look <img src="https://x.example/p.png"> here. ![pic](https://x.example/q.png) end.')).toEqual(['Look here.']);
    expect(lines('')).toEqual([]);
  });

  it('keeps reference-style link text and resolves its address from the definition', () => {
    const body = '- USCIS raised the fee per [the final rule][1]. More.\n- Also see [the notice] today.\n\n[1]: https://www.uscis.gov/rule\n[the notice]: https://www.uscis.gov/notice';
    expect(summarizeDigest(body)).toEqual([
      [{ text: 'USCIS raised the fee per ' }, { text: 'the final rule', href: 'https://www.uscis.gov/rule' }, { text: '.' }],
      [{ text: 'Also see ' }, { text: 'the notice', href: 'https://www.uscis.gov/notice' }, { text: ' today.' }],
    ]);
  });

  it('uses the first definition when a label is defined twice, as CommonMark does', () => {
    const body = '- Per [the rule][1].\n\n[1]: https://www.uscis.gov/rule\n[1]: https://other.example/x';
    expect(summarizeDigest(body)).toEqual([
      [{ text: 'Per ' }, { text: 'the rule', href: 'https://www.uscis.gov/rule' }, { text: '.' }],
    ]);
  });

  it('resolves a definition nested under a bullet', () => {
    const body = '- Fee rises per [the rule][1].\n\n  [1]: https://www.uscis.gov/rule';
    expect(summarizeDigest(body)).toEqual([
      [{ text: 'Fee rises per ' }, { text: 'the rule', href: 'https://www.uscis.gov/rule' }, { text: '.' }],
    ]);
  });

  it('shows a reference without a definition as the literal text markdown renders for it', () => {
    expect(lines('- Per [the rule][missing] today.')).toEqual(['Per [the rule][missing] today.']);
  });

  it('drops footnote references and image references', () => {
    expect(lines('- Fee rises[^1] for all. ![pic][x] More.\n\n[^1]: a footnote\n[x]: https://x.example/p.png')).toEqual(['Fee rises for all.']);
  });
});
