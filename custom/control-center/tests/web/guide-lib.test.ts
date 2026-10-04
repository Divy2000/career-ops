import { afterEach, describe, expect, it, vi } from 'vitest';
import { countReviewed, filterSections, guideKeyAction, readReviewed, stepSection, writeReviewed } from '../../web/lib/guide';

const sections = [
  { id: 'today', title: 'Today', summary: 'The daily shortlist.', steps: ['Open the page.', 'Pick a row.'] },
  { id: 'tracker', title: 'Tracker', summary: 'Every application in one table.', steps: ['Filter by status.'] },
  { id: 'followups', title: 'Follow-ups', summary: 'Who to nudge.', steps: ['Log a follow-up.'] },
];

describe('filterSections', () => {
  it('returns every section for an empty or blank term', () => {
    expect(filterSections(sections, '')).toBe(sections);
    expect(filterSections(sections, '   ')).toBe(sections);
  });

  it.each([
    ['a title word', 'track', ['tracker']],
    ['a summary word', 'nudge', ['followups']],
    ['a step word', 'filter', ['tracker']],
    ['any case', 'TODAY', ['today']],
    ['several matches', 'follow', ['followups']],
    ['padding around the term', '  pick  ', ['today']],
    ['nothing', 'zebra', []],
  ])('matches %s', (_label, term, ids) => {
    expect(filterSections(sections, term).map((s) => s.id)).toEqual(ids);
  });

  it('does not search tips, ids or file names', () => {
    expect(filterSections([{ ...sections[0]!, tips: ['secret tip'] } as (typeof sections)[0]], 'secret')).toEqual([]);
    expect(filterSections(sections, 'followups')).toEqual([]);
  });
});

describe('stepSection', () => {
  it.each([
    ['today', 1, 'tracker'],
    ['tracker', 1, 'followups'],
    ['followups', 1, null],
    ['followups', -1, 'tracker'],
    ['today', -1, null],
  ] as const)('from %s by %s goes to %s', (current, delta, expected) => {
    expect(stepSection(sections, current, delta)).toBe(expected);
  });

  it('starts at the first section when the current one is not in the list', () => {
    expect(stepSection(sections, 'gone', 1)).toBe('today');
    expect(stepSection(sections, undefined, 1)).toBe('today');
    expect(stepSection(sections, 'gone', -1)).toBeNull();
  });

  it('has nowhere to go in an empty list', () => {
    expect(stepSection([], 'today', 1)).toBeNull();
  });
});

describe('countReviewed', () => {
  it('counts only sections that still exist', () => {
    expect(countReviewed(sections, new Set(['today', 'removed-long-ago']))).toBe(1);
    expect(countReviewed(sections, new Set())).toBe(0);
    expect(countReviewed(sections, new Set(['today', 'tracker', 'followups']))).toBe(3);
  });
});

describe('guideKeyAction', () => {
  const key = (k: string, over: Partial<Parameters<typeof guideKeyAction>[0]> = {}) => guideKeyAction({ key: k, target: 'body', ctrlKey: false, metaKey: false, altKey: false, ...over });

  it.each([
    ['j', 'next'],
    ['J', 'next'],
    ['ArrowDown', 'next'],
    ['k', 'prev'],
    ['K', 'prev'],
    ['ArrowUp', 'prev'],
  ])('%s is %s', (k, action) => {
    expect(key(k)).toBe(action);
  });

  it.each(['x', ' ', 'Enter', 'ArrowLeft', 'l', 'c'])('ignores %j', (k) => {
    expect(key(k)).toBeNull();
  });

  it('works from a button or a link, but not while typing or with a modifier', () => {
    expect(key('j', { target: 'button' })).toBe('next');
    expect(key('j', { target: 'link' })).toBe('next');
    for (const target of ['input', 'textarea', 'select', 'editable']) expect(key('j', { target })).toBeNull();
    expect(key('j', { ctrlKey: true })).toBeNull();
    expect(key('j', { metaKey: true })).toBeNull();
    expect(key('j', { altKey: true })).toBeNull();
  });
});

describe('reviewed sections in localStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('reads back what was written, per tutorial', () => {
    writeReviewed('tour', ['today', 'tracker']);
    writeReviewed('other', ['x']);
    expect(readReviewed('tour')).toEqual(['today', 'tracker']);
    expect(readReviewed('other')).toEqual(['x']);
    expect(readReviewed('never-written')).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['not a list', '{"a":1}'],
    ['a list with other things in it', '["today", 3, null]'],
  ])('reads %s as what can be trusted', (_label, stored) => {
    window.localStorage.setItem('cc.tutorials.guide.reviewed.tour', stored);
    expect(readReviewed('tour')).toEqual(stored.startsWith('[') ? ['today'] : []);
  });

  it('works when storage throws on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readReviewed('tour')).toEqual([]);
    expect(() => writeReviewed('tour', ['today'])).not.toThrow();
  });
});
