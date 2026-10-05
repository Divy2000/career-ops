import { describe, expect, it } from 'vitest';
import { chapterIndexAt, chapterTarget, filterTranscript, formatTimestamp, keyAction, nextPart, resolvePart } from '../../web/lib/tutorials';

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [600, '10:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [-4, '0:00'],
    [Number.NaN, '0:00'],
  ])('%s seconds reads %s', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });
});

describe('chapterIndexAt', () => {
  const chapters = [
    { title: 'A', start: 0 },
    { title: 'B', start: 30 },
    { title: 'C', start: 90.5 },
  ];
  it.each([
    [0, 0],
    [29.9, 0],
    [30, 1],
    [90, 1],
    [90.5, 2],
    [10_000, 2],
  ])('at %s seconds the chapter is %s', (t, expected) => {
    expect(chapterIndexAt(chapters, t)).toBe(expected);
  });

  it('is -1 before the first chapter and for no chapters', () => {
    expect(chapterIndexAt([{ title: 'Late', start: 5 }], 1)).toBe(-1);
    expect(chapterIndexAt([], 10)).toBe(-1);
  });

  it('counts a seek that lands a hair before a chapter start as that chapter', () => {
    expect(chapterIndexAt(chapters, 29.995)).toBe(1);
  });
});

describe('filterTranscript', () => {
  const md = '# Script\n\nIntro text about safety.\n\n## 1. Today [today]\n\n<!-- highlight the shortlist -->\nThe shortlist shows the top rows.\n\nSecond paragraph about follow-ups.\n\n## 2. Tracker\n\nSafety again, in the tracker.\n';

  it('returns the whole text and no match count for an empty term', () => {
    expect(filterTranscript(md, '  ')).toEqual({ text: md, matches: null });
  });

  it('keeps matching paragraphs under the heading they belong to, case-insensitively', () => {
    const r = filterTranscript(md, 'SAFETY');
    expect(r.matches).toBe(2);
    expect(r.text).toBe('# Script\n\nIntro text about safety.\n\n## 2. Tracker\n\nSafety again, in the tracker.');
  });

  it('does not match inside authoring comments', () => {
    expect(filterTranscript(md, 'highlight').matches).toBe(0);
  });

  it('matches a paragraph that follows an authoring comment on the line above, and drops the comment from the result', () => {
    const r = filterTranscript(md, 'shortlist');
    expect(r.matches).toBe(1);
    expect(r.text).toBe('## 1. Today [today]\n\nThe shortlist shows the top rows.');
  });

  it('strips a comment that spans blank lines', () => {
    const multi = '## A\n\n<!-- note one\n\nnote two -->\nVisible narration.\n';
    expect(filterTranscript(multi, 'note')).toEqual({ text: '', matches: 0 });
    expect(filterTranscript(multi, 'narration')).toEqual({ text: '## A\n\nVisible narration.', matches: 1 });
  });

  it('counts a matching heading and keeps it', () => {
    const r = filterTranscript(md, 'tracker');
    expect(r.text).toContain('## 2. Tracker');
    expect(r.matches).toBe(2);
  });

  it('is empty when nothing matches', () => {
    expect(filterTranscript(md, 'zebra')).toEqual({ text: '', matches: 0 });
  });
});

describe('keyAction', () => {
  const key = (k: string, extra: Partial<{ target: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => keyAction({ key: k, target: extra.target ?? 'body', ctrlKey: extra.ctrl ?? false, metaKey: extra.meta ?? false, altKey: extra.alt ?? false });

  it.each([
    [' ', 'toggle'],
    ['k', 'toggle'],
    ['K', 'toggle'],
    ['j', 'back'],
    ['l', 'forward'],
    ['c', 'captions'],
    ['ArrowUp', 'prevChapter'],
    ['ArrowDown', 'nextChapter'],
  ])('%j maps to %s', (k, action) => {
    expect(key(k)).toBe(action);
  });

  it('ignores other keys and any modifier combination', () => {
    expect(key('x')).toBeNull();
    expect(key('k', { meta: true })).toBeNull();
    expect(key('k', { ctrl: true })).toBeNull();
    expect(key('c', { alt: true })).toBeNull();
  });

  it('leaves text entry alone', () => {
    for (const target of ['input', 'textarea', 'select', 'editable']) expect(key('k', { target })).toBeNull();
    expect(key('ArrowDown', { target: 'select' })).toBeNull();
  });

  it('leaves space to a focused button or link so it still activates, but still handles the letter keys', () => {
    expect(key(' ', { target: 'button' })).toBeNull();
    expect(key(' ', { target: 'link' })).toBeNull();
    expect(key('k', { target: 'button' })).toBe('toggle');
  });
});

describe('parts', () => {
  const parts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const chapters = [
    { title: 'A one', start: 0, part: 'a' },
    { title: 'A two', start: 40, part: 'a' },
    { title: 'B one', start: 0, part: 'b' },
    { title: 'C one', start: 0, part: 'c' },
    { title: 'C two', start: 75.5, part: 'c' },
  ];

  it('resolvePart opens the named part, and the first one for an unknown or missing id', () => {
    expect(resolvePart(parts, 'b')).toBe(parts[1]);
    expect(resolvePart(parts, 'nope')).toBe(parts[0]);
    expect(resolvePart(parts, undefined)).toBe(parts[0]);
  });

  it('nextPart is the part after the given one, and null after the last', () => {
    expect(nextPart(parts, 'a')).toBe(parts[1]);
    expect(nextPart(parts, 'c')).toBeNull();
    expect(nextPart(parts, 'nope')).toBeNull();
  });

  it('chapterTarget turns a guide chapter number (global, in part order) into its part and its start within that part', () => {
    expect(chapterTarget(chapters, 4)).toEqual({ part: 'c', start: 75.5 });
    expect(chapterTarget(chapters, 2)).toEqual({ part: 'b', start: 0 });
    expect(chapterTarget(chapters, 5)).toBeNull();
  });
});
