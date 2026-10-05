import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROGRESS_PREFIX, advance, createProgressTracker, readProgress, resumePoint, savePartProgress, watchedFraction } from '../../web/lib/tutorial-progress';

const stored = (at: number, over: Partial<{ max: number; done: boolean }> = {}) => ({ at, max: at, done: false, ...over });

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('resumePoint', () => {
  it('given stored progress at 120 s of 300, when the resume point is read, then it is 120', () => {
    expect(resumePoint(stored(120), 300)).toBe(120);
  });

  it('given the part is done, when the resume point is read, then there is none', () => {
    expect(resumePoint(stored(120, { done: true }), 300)).toBeNull();
  });

  it.each([
    ['at 3 s', 3],
    ['at exactly 5 s', 5],
    ['within the last 10 s', 291],
  ])('given progress %s, when the resume point is read, then there is none', (_label, at) => {
    expect(resumePoint(stored(at), 300)).toBeNull();
  });

  it('given no progress or no known length, when the resume point is read, then there is none', () => {
    expect(resumePoint(undefined, 300)).toBeNull();
    expect(resumePoint(stored(120), null)).toBeNull();
    expect(resumePoint(stored(120), Number.NaN)).toBeNull();
  });
});

describe('advance', () => {
  it('moves the position, keeps the furthest point and is not done mid-way', () => {
    expect(advance(stored(200), 150, 300)).toEqual({ at: 150, max: 200, done: false });
  });

  it('counts a part as done past its length minus 3 s, and it stays done after seeking back', () => {
    const done = advance(stored(200), 297, 300);
    expect(done.done).toBe(true);
    expect(advance(done, 10, 300)).toEqual({ at: 10, max: 297, done: true });
  });

  it('is not done 3.5 s before the end', () => {
    expect(advance(undefined, 296.5, 300).done).toBe(false);
  });
});

describe('watchedFraction', () => {
  it('is the furthest point over the length, 1 when done and 0 without a length', () => {
    expect(watchedFraction(stored(150), 300)).toBe(0.5);
    expect(watchedFraction(stored(10, { done: true }), 300)).toBe(1);
    expect(watchedFraction(undefined, 300)).toBe(0);
    expect(watchedFraction(stored(150), null)).toBe(0);
    expect(watchedFraction(stored(400), 300)).toBe(1);
  });
});

describe('progress in localStorage', () => {
  it('stores {at, max, done} per part under cc.tutorials.progress.v1.<tutorialId> and reads it back', () => {
    savePartProgress('tour', 'a', stored(42));
    savePartProgress('tour', 'b', stored(7, { done: true }));
    expect(PROGRESS_PREFIX).toBe('cc.tutorials.progress.v1.');
    expect(JSON.parse(window.localStorage.getItem('cc.tutorials.progress.v1.tour')!)).toEqual({ a: stored(42), b: stored(7, { done: true }) });
    expect(readProgress('tour')).toEqual({ a: stored(42), b: stored(7, { done: true }) });
    expect(readProgress('other')).toEqual({});
  });

  it.each([
    ['not JSON', '{ nope', {}],
    ['a list', '[1, 2]', {}],
    ['entries of the wrong shape', '{"a":{"at":"x","max":1,"done":false},"b":{"at":4,"max":5,"done":true},"c":null}', { b: { at: 4, max: 5, done: true } }],
    ['negative or endless numbers', '{"a":{"at":-1,"max":5,"done":false},"b":{"at":1,"max":1e999,"done":false}}', {}],
  ])('given corrupt storage (%s), when read, then only the entries that can be trusted come back', (_label, raw, expected) => {
    window.localStorage.setItem('cc.tutorials.progress.v1.tour', raw);
    expect(readProgress('tour')).toEqual(expected);
  });

  it('given storage that throws, when read and written, then progress is empty and nothing throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readProgress('tour')).toEqual({});
    expect(() => savePartProgress('tour', 'a', stored(1))).not.toThrow();
  });
});

describe('createProgressTracker', () => {
  const read = () => readProgress('tour').a;

  it('writes at once, then at most every 5 s while playing', () => {
    let now = 1_000;
    const tracker = createProgressTracker('tour', 'a', { now: () => now });
    tracker.tick(10, 300);
    expect(read()).toEqual(stored(10));
    now += 4_000;
    tracker.tick(14, 300);
    expect(read()).toEqual(stored(10));
    now += 1_000;
    tracker.tick(15, 300);
    expect(read()).toEqual(stored(15));
  });

  it('writes straight away on save (pause, end and unmount)', () => {
    let now = 1_000;
    const tracker = createProgressTracker('tour', 'a', { now: () => now });
    tracker.tick(10, 300);
    now += 1_000;
    tracker.save(11, 300);
    expect(read()).toEqual(stored(11));
  });

  it('starts from what is stored, so a part watched before stays done', () => {
    savePartProgress('tour', 'a', stored(299, { done: true }));
    const tracker = createProgressTracker('tour', 'a');
    tracker.save(12, 300);
    expect(read()).toEqual({ at: 12, max: 299, done: true });
  });

  it('hands every write to onSave, for the playlist to redraw', () => {
    const onSave = vi.fn();
    const tracker = createProgressTracker('tour', 'a', { onSave });
    tracker.save(30, 300);
    expect(onSave).toHaveBeenCalledWith(stored(30));
  });
});
