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

  it('keeps the content after a bold label that is not a headline (R33-shared-comp-L2-01)', () => {
    const body = '- **What changed:** USCIS raised the H-1B petition fee to $100,000. More text.\n- **Effective date:** 2026-11-01.\n- **USCIS** raised the fee for new petitions. Later text.\n- **H-1B fee:** $100,000 for petitions filed from abroad.';
    expect(lines(body)).toEqual([
      'What changed: USCIS raised the H-1B petition fee to $100,000.',
      'Effective date: 2026-11-01.',
      'USCIS raised the fee for new petitions.',
      'H-1B fee: $100,000 for petitions filed from abroad.',
    ]);
    expect(summarizeDigest(body)[1]).toEqual([{ text: 'Effective date:', bold: true }, { text: ' 2026-11-01.' }]);
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

  it('does not end the first sentence after a one-letter initial or a citation abbreviation (R33-shared-comp-X-01)', () => {
    expect(lines('- President Donald J. Trump signed a proclamation raising the H-1B fee to $100,000. Later text.')).toEqual(['President Donald J. Trump signed a proclamation raising the H-1B fee to $100,000.']);
    expect(lines('- DHS published the weighted-selection rule at 90 Fed. Reg. 45678 today. Later text.')).toEqual(['DHS published the weighted-selection rule at 90 Fed. Reg. 45678 today.']);
    expect(lines('- The rule cites 8 U.S.C. Sec. 1184 and Pub. L. 117 in Pt. 214. Later text.')).toEqual(['The rule cites 8 U.S.C. Sec. 1184 and Pub. L. 117 in Pt. 214.']);
  });

  it('still ends the first sentence at a bare agency name or a lone letter that closes it (R33-shared-comp-X-01 fix-check FC-01)', () => {
    expect(lines('- Employers must file with the SEC. Later text.')).toEqual(['Employers must file with the SEC.']);
    expect(lines('- The change was announced by the Fed. Employers must update filings.')).toEqual(['The change was announced by the Fed.']);
    expect(lines('- Filings are due under schedule B. Employers must update them.')).toEqual(['Filings are due under schedule B.']);
  });

  it('ends the first sentence at a lettered form part, and reads an initial after a link with the link in view (R33-shared-comp-X-01 fix-check 2)', () => {
    expect(lines('- File it under Schedule A. Employers must update them.')).toEqual(['File it under Schedule A.']);
    expect(lines('- Medicare Part B. Later text.')).toEqual(['Medicare Part B.']);
    expect(lines('- President [Donald](https://example.test/p) J. Trump signed it. Later text.')).toEqual(['President Donald J. Trump signed it.']);
    expect(lines('- President Donald [J.](https://example.test/p) Trump signed it. Later text.')).toEqual(['President Donald J. Trump signed it.']);
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

  it('keeps a link labelled with its own mailto: address instead of collapsing it to an empty host (R33-feat-b-L2-01)', () => {
    expect(summarizeDigest('- Contact <mailto:help@uscis.gov> today.')[0]).toEqual([{ text: 'Contact ' }, { text: 'help@uscis.gov', href: 'mailto:help@uscis.gov' }, { text: ' today.' }]);
    expect(summarizeDigest('- Write [mailto:help@uscis.gov](mailto:help@uscis.gov) today.')[0]).toEqual([{ text: 'Write ' }, { text: 'help@uscis.gov', href: 'mailto:help@uscis.gov' }, { text: ' today.' }]);
    expect(summarizeDigest('- Call [tel:+15551234](tel:+15551234) today.')[0]).toEqual([{ text: 'Call ' }, { text: '+15551234', href: 'tel:+15551234' }, { text: ' today.' }]);
  });

  it('ends the first sentence at a period inside a link label, keeping the link whole (R33-feat-c-X-02)', () => {
    expect(summarizeDigest('- Read [the final rule.](https://example.test/rule) The fee is unchanged.')[0]).toEqual([{ text: 'Read ' }, { text: 'the final rule.', href: 'https://example.test/rule' }]);
    expect(summarizeDigest('- See [Rule one. Rule two](https://example.test/r) for more. Later text.')[0]).toEqual([{ text: 'See ' }, { text: 'Rule one. Rule two', href: 'https://example.test/r' }]);
    expect(lines('- Per [the U.S.](https://example.test/us) rule today. Later text.')).toEqual(['Per the U.S. rule today.']);
  });


  it('keeps every piece of a link whose label holds the sentence end, and reads on past a label period before lowercase text (R33 fix-check FC-01)', () => {
    const u = 'https://example.test/r';
    expect(summarizeDigest(`- See [Read it.\\\nNow](${u}) later. More.`)[0]).toEqual([{ text: 'See ' }, { text: 'Read it.', href: u }, { text: ' ', href: u }, { text: 'Now', href: u }]);
    expect(summarizeDigest(`- See [Rule one. *Two*](${u}) later. More.`)[0]).toEqual([{ text: 'See ' }, { text: 'Rule one. ', href: u }, { text: 'Two', href: u }]);
    expect(lines(`- See [rule 5.](${u}) applies today. Next.`)).toEqual(['See rule 5. applies today.']);
  });
  it('keeps a hard break inside a link label as part of the link (R33-feat-c-X-03)', () => {
    expect(summarizeDigest('- Read [the final\\\nrule](https://example.test/rule).')[0]).toEqual([
      { text: 'Read ' },
      { text: 'the final', href: 'https://example.test/rule' },
      { text: ' ', href: 'https://example.test/rule' },
      { text: 'rule', href: 'https://example.test/rule' },
      { text: '.' },
    ]);
  });
  it('drops struck-through text, so a withdrawn figure never reads as current policy (R33-weblib-X-01)', () => {
    expect(lines('- H-1B filing fee is now ~~$5,000~~ $100,000 per petition. Source: [USCIS](https://www.uscis.gov/x)')).toEqual(['H-1B filing fee is now $100,000 per petition.']);
    expect(lines('- **Fee is ~~proposed~~ final.** Details follow.')).toEqual(['Fee is final.']);
    expect(summarizeDigest('- See [the ~~draft~~ final rule](https://example.test/r) today.')[0]).toEqual([{ text: 'See ' }, { text: 'the ', href: 'https://example.test/r' }, { text: 'final rule', href: 'https://example.test/r' }, { text: ' today.' }]);
    expect(lines('- ~~Old guidance withdrawn.~~\n- New guidance applies.')).toEqual(['New guidance applies.']);
    expect(lines('- Fee is ~~$5,000. It was~~ $100,000. Later text.')).toEqual(['Fee is $100,000.']);
  });

  it.each([
    ['a closing double quote', '- State Dept said visa processing is "under review." Consular posts will contact applicants once the review completes.', 'State Dept said visa processing is "under review."'],
    ['a closing curly quote', '- State Dept said processing is \u201cunder review.\u201d Posts will contact applicants.', 'State Dept said processing is \u201cunder review.\u201d'],
    ['a closing single quote', "- The officer said 'come back Monday.' Posts will contact applicants.", "The officer said 'come back Monday.'"],
    ['a closing bracket', '- Fees rise (for petitions filed abroad.) Posts will contact applicants.', 'Fees rise (for petitions filed abroad.)'],
    ['a closing square bracket', '- Fees rise [see notice.] Posts will contact applicants.', 'Fees rise [see notice.]'],
    ['a question mark and quote', '- Asked "is the fee final?" Officials declined to say.', 'Asked "is the fee final?"'],
    ['an exclamation and a bracket', '- Processing paused (again!) Check back Monday.', 'Processing paused (again!)'],
    ['a quote and a bracket', '- Fees rise ("per the rule.") Posts will contact applicants.', 'Fees rise ("per the rule.")'],
    ['closing punctuation at the end', '- Status is "under review."', 'Status is "under review."'],
  ])('ends the first sentence at terminal punctuation followed by %s (R33-weblib-L2-01)', (_shape, body, expected) => {
    expect(lines(`${body}`)).toEqual([expected]);
  });

  it.each([
    ['an abbreviation in brackets', '- Stamping paused (in the U.S.) Later text here.', 'Stamping paused (in the U.S.) Later text here.'],
    ['a quoted question before lowercase', '- "Is it final?" he asked the officer. Later text.', '"Is it final?" he asked the officer.'],
    ['a quoted abbreviation', '- The memo says "see Dr." Smith for details. Later text.', 'The memo says "see Dr." Smith for details.'],
    ['a bracketed abbreviation', '- Per Rule (No.) Five the fee rises. Later text.', 'Per Rule (No.) Five the fee rises.'],
    ['a quoted word before lowercase', '- Said "go." now. Later text.', 'Said "go." now.'],
  ])('does not end the first sentence at closing punctuation after %s (R33-weblib-L2-01)', (_shape, body, expected) => {
    expect(lines(body)).toEqual([expected]);
  });
});
