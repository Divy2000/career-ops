import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REVIEWED_PREFIX,
  excerptAround,
  flattenSubsections,
  guideKeyAction,
  highlight,
  isSearching,
  pruneReviewed,
  readReviewed,
  resolveLocation,
  searchGuide,
  searchTerms,
  sectionProgress,
  spyInitial,
  spyReduce,
  stepSubsection,
  subKey,
  totalProgress,
  writeReviewed,
} from '../../web/lib/guide';
import type { GuideBlockView, GuideDocs, GuideSubsectionView } from '../../shared/api';

const sub = (id: string, title: string, blocks: GuideBlockView[], over: Partial<GuideSubsectionView> = {}): GuideSubsectionView => ({ id, title, summary: '', route: null, chapter: null, blocks, ...over });
const text = (t: string): GuideBlockView => ({ type: 'text', text: t });
const image = (caption: string | null): GuideBlockView => ({ type: 'media', kind: 'image', alt: 'A screenshot nobody searches', caption, width: 10, height: 10, url: '/a.png', urlLight: '/a.light.png', posterUrl: null, posterLightUrl: null });

const docs: GuideDocs = {
  version: 2,
  legacy: false,
  sections: [
    {
      id: 'start',
      title: 'Getting started',
      summary: 'Launch the app and find your way around.',
      subsections: [
        sub('launch', 'Launch and sign in', [text('Run the launcher, then open the printed link.'), { type: 'steps', items: ['Open a terminal.', 'Run npm start.'] }, image('Today right after sign in.')], { summary: 'Open the app with the token.' }),
        sub('safety', 'Safety model', [text('Everything that writes asks first.'), { type: 'tips', items: ['Read the confirmation dialog.'] }]),
      ],
    },
    {
      id: 'tracking',
      title: 'Tracking',
      summary: 'Keep the tracker current.',
      subsections: [sub('status', 'Change a status', [text('Pick a row, then the new status.')], { route: '/tracker', chapter: 1 }), sub('safety', 'Safety of the data', [text('Nothing leaves the machine.')])],
    },
  ],
};

describe('flattenSubsections and subKey', () => {
  it('lists every subsection in reading order with its section', () => {
    expect(flattenSubsections(docs).map((f) => [f.sectionId, f.subId, f.key])).toEqual([
      ['start', 'launch', 'start/launch'],
      ['start', 'safety', 'start/safety'],
      ['tracking', 'status', 'tracking/status'],
      ['tracking', 'safety', 'tracking/safety'],
    ]);
  });

  it('keeps a subsection id that repeats in two sections apart', () => {
    expect(subKey('start', 'safety')).not.toBe(subKey('tracking', 'safety'));
  });
});

describe('resolveLocation (deep links)', () => {
  it.each([
    ['both known', 'tracking', 'status', { sectionId: 'tracking', subId: 'status' }],
    ['a section only, as a legacy link has', 'tracking', undefined, { sectionId: 'tracking', subId: null }],
    ['an unknown subsection of a known section', 'tracking', 'launch', { sectionId: 'tracking', subId: null }],
    ['an unknown section', 'gone', undefined, { sectionId: 'start', subId: null }],
    ['an unknown section with an unknown subsection', 'gone', 'nope', { sectionId: 'start', subId: null }],
    ['nothing at all', undefined, undefined, { sectionId: 'start', subId: null }],
    ['a subsection without its section (found by its id)', undefined, 'status', { sectionId: 'tracking', subId: 'status' }],
    ['a repeated subsection id with the section that disambiguates it', 'tracking', 'safety', { sectionId: 'tracking', subId: 'safety' }],
    ['a repeated subsection id without a section: the first one', undefined, 'safety', { sectionId: 'start', subId: 'safety' }],
    ['a subsection that belongs to a different section than named', 'gone', 'status', { sectionId: 'tracking', subId: 'status' }],
  ])('resolves %s', (_label, section, subId, expected) => {
    expect(resolveLocation(docs, section, subId)).toEqual(expected);
  });

  it('lands a version 1 link, whose section and subsection share an id', () => {
    const legacy: GuideDocs = { version: 1, legacy: true, sections: [{ id: 'today', title: 'Today', summary: 's', subsections: [sub('today', 'Today', [text('s')])] }] };
    expect(resolveLocation(legacy, 'today', undefined)).toEqual({ sectionId: 'today', subId: null });
    expect(resolveLocation(legacy, 'today', 'today')).toEqual({ sectionId: 'today', subId: 'today' });
  });
});

describe('stepSubsection (j and k)', () => {
  const at = (sectionId: string, subId: string | null) => ({ sectionId, subId });
  it.each([
    [at('start', 'launch'), 1, { sectionId: 'start', subId: 'safety' }],
    [at('start', 'safety'), 1, { sectionId: 'tracking', subId: 'status' }],
    [at('tracking', 'safety'), 1, null],
    [at('tracking', 'status'), -1, { sectionId: 'start', subId: 'safety' }],
    [at('start', 'launch'), -1, null],
    [at('tracking', 'safety'), -1, { sectionId: 'tracking', subId: 'status' }],
  ])('from %j by %i', (current, delta, expected) => {
    expect(stepSubsection(docs, current, delta as 1 | -1)).toEqual(expected);
  });

  it('from the top of a section, next is its first subsection and previous is the end of the section before', () => {
    expect(stepSubsection(docs, at('tracking', null), 1)).toEqual({ sectionId: 'tracking', subId: 'status' });
    expect(stepSubsection(docs, at('tracking', null), -1)).toEqual({ sectionId: 'start', subId: 'safety' });
    expect(stepSubsection(docs, at('start', null), -1)).toBeNull();
  });

  it('has nowhere to go from an unknown place or in an empty guide', () => {
    expect(stepSubsection(docs, at('start', 'gone'), 1)).toEqual({ sectionId: 'start', subId: 'launch' });
    expect(stepSubsection({ ...docs, sections: [] }, at('start', null), 1)).toBeNull();
  });
});

describe('reviewed progress', () => {
  it('counts per section and in total, ignoring keys of subsections that no longer exist', () => {
    const reviewed = new Set(['start/launch', 'tracking/status', 'tracking/safety', 'removed/long-ago']);
    expect(sectionProgress(docs.sections[0]!, reviewed)).toEqual({ done: 1, total: 2 });
    expect(sectionProgress(docs.sections[1]!, reviewed)).toEqual({ done: 2, total: 2 });
    expect(totalProgress(docs, reviewed)).toEqual({ done: 3, total: 4 });
    expect(totalProgress(docs, new Set())).toEqual({ done: 0, total: 4 });
  });

  it('prunes a stored list to the subsections that exist', () => {
    expect([...pruneReviewed(docs, ['start/launch', 'gone/x', 'start/gone'])]).toEqual(['start/launch']);
  });
});

describe('reviewed subsections in localStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('stores under cc.guide.v2.<tutorialId> and reads back per tutorial', () => {
    writeReviewed('tour', ['start/launch', 'tracking/status']);
    writeReviewed('other', ['x/y']);
    expect(window.localStorage.getItem('cc.guide.v2.tour')).toBe('["start/launch","tracking/status"]');
    expect(REVIEWED_PREFIX).toBe('cc.guide.v2.');
    expect(readReviewed('tour')).toEqual(['start/launch', 'tracking/status']);
    expect(readReviewed('other')).toEqual(['x/y']);
    expect(readReviewed('never-written')).toEqual([]);
  });

  it('does not read the key of the old per-section guide', () => {
    window.localStorage.setItem('cc.tutorials.guide.reviewed.tour', '["today"]');
    expect(readReviewed('tour')).toEqual([]);
  });

  it.each([
    ['not JSON', '{ nope', []],
    ['not a list', '{"a":1}', []],
    ['a list with other things in it', '["start/launch", 3, null]', ['start/launch']],
  ])('reads %s as what can be trusted', (_label, stored, expected) => {
    window.localStorage.setItem('cc.guide.v2.tour', stored);
    expect(readReviewed('tour')).toEqual(expected);
  });

  it('works when storage throws on read and on write', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readReviewed('tour')).toEqual([]);
    expect(() => writeReviewed('tour', ['start/launch'])).not.toThrow();
  });
});

describe('searchTerms and isSearching', () => {
  it('splits on whitespace, lowercases and drops blanks', () => {
    expect(searchTerms('  Open   The  Link ')).toEqual(['open', 'the', 'link']);
    expect(searchTerms('   ')).toEqual([]);
  });

  it('needs two characters before it searches', () => {
    expect(isSearching('')).toBe(false);
    expect(isSearching(' j ')).toBe(false);
    expect(isSearching('ab')).toBe(true);
  });
});

describe('searchGuide', () => {
  const hits = (term: string) => searchGuide(docs, term).groups.flatMap((g) => g.hits.map((h) => `${g.sectionId}/${h.subId ?? '*'}:${h.field}`));

  it('finds a word in each kind of text, with the field it came from', () => {
    expect(hits('launcher')).toEqual(['start/launch:text']);
    expect(hits('terminal')).toEqual(['start/launch:steps']);
    expect(hits('confirmation')).toEqual(['start/safety:tips']);
    expect(hits('right after')).toEqual(['start/launch:caption']);
    expect(hits('token')).toEqual(['start/launch:summary']);
    expect(hits('data')).toEqual(['tracking/safety:title']);
  });

  it('matches a section by its title or summary and points at the section itself', () => {
    expect(hits('keep the tracker')).toEqual(['tracking/*:summary']);
    expect(hits('getting started')).toEqual(['start/*:title']);
  });

  it('is case-insensitive and ignores padding', () => {
    expect(hits('  LAUNCHER ')).toEqual(['start/launch:text']);
  });

  it('needs every word, anywhere in the same subsection', () => {
    expect(hits('launcher terminal')).toEqual(['start/launch:text']);
    expect(hits('launcher zebra')).toEqual([]);
  });

  it('groups hits by section in reading order and counts them', () => {
    const found = searchGuide(docs, 'safety');
    expect(found.groups.map((g) => [g.sectionId, g.title, g.hits.map((h) => h.subId)])).toEqual([
      ['start', 'Getting started', ['safety']],
      ['tracking', 'Tracking', ['safety']],
    ]);
    expect(found.total).toBe(2);
  });

  it('does not search alt text, ids, routes or file names', () => {
    expect(hits('nobody')).toEqual([]);
    expect(hits('tracker.light')).toEqual([]);
    expect(hits('/tracker')).toEqual([]);
  });

  it('finds nothing for a blank or too short term', () => {
    expect(searchGuide(docs, '')).toEqual({ groups: [], total: 0 });
    expect(searchGuide(docs, 'a')).toEqual({ groups: [], total: 0 });
  });

  it('gives each hit an excerpt that contains the match', () => {
    const [group] = searchGuide(docs, 'launcher').groups;
    expect(group!.hits[0]!.excerpt).toContain('launcher');
    expect(group!.hits[0]!.subTitle).toBe('Launch and sign in');
  });

  it('shows the summary under a title match, since the title is already the headline of the result', () => {
    const [group] = searchGuide(docs, 'data').groups;
    expect(group!.hits[0]).toMatchObject({ field: 'title', excerpt: 'Nothing leaves the machine.' });
    expect(searchGuide(docs, 'getting started').groups[0]!.hits[0]).toMatchObject({ field: 'title', excerpt: 'Launch the app and find your way around.' });
  });

  it('falls back to the first text block, then to the title itself, when a title match has no summary', () => {
    const bare: GuideDocs = { version: 2, legacy: false, sections: [{ id: 's', title: 'Section', summary: '', subsections: [sub('a', 'Needle one', [text('First text.')]), sub('b', 'Needle two', [{ type: 'steps', items: ['Only steps.'] }])] }] };
    const hits = searchGuide(bare, 'needle').groups[0]!.hits;
    expect(hits.map((h) => h.excerpt)).toEqual(['First text.', 'Needle two']);
  });

  it('treats regular expression characters in the term literally', () => {
    expect(() => searchGuide(docs, '(.*')).not.toThrow();
    expect(searchGuide(docs, '(.*').total).toBe(0);
  });
});

describe('excerptAround', () => {
  const long = `${'word '.repeat(60)}needle ${'tail '.repeat(60)}`;
  it('returns short text whole', () => {
    expect(excerptAround('Short text here.', ['text'], 100)).toBe('Short text here.');
  });
  it('centres long text on the first match and marks what it cut', () => {
    const out = excerptAround(long, ['needle'], 80);
    expect(out).toContain('needle');
    expect(out.length).toBeLessThanOrEqual(86);
    expect(out.startsWith('...')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });
  it('starts at the beginning when the match is near it, with no leading cut', () => {
    const out = excerptAround(`needle ${'tail '.repeat(60)}`, ['needle'], 80);
    expect(out.startsWith('needle')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });
  it('cuts between words, never inside one', () => {
    const words = new Set(['word', 'needle', 'tail']);
    for (const max of [37, 80, 101]) {
      const body = excerptAround(long, ['needle'], max).replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
      for (const w of body.split(' ')) expect(words.has(w), `"${w}" in "${body}"`).toBe(true);
    }
  });
  it('shows the start of the text when nothing matches', () => {
    expect(excerptAround(long, ['zebra'], 40).startsWith('word word')).toBe(true);
  });
});

describe('highlight', () => {
  it('splits text into plain and marked pieces, case-insensitively, keeping the original case', () => {
    expect(highlight('Open the Link', ['link', 'open'])).toEqual([
      { text: 'Open', mark: true },
      { text: ' the ', mark: false },
      { text: 'Link', mark: true },
    ]);
  });
  it('returns the whole text unmarked without terms or matches', () => {
    expect(highlight('plain', [])).toEqual([{ text: 'plain', mark: false }]);
    expect(highlight('plain', ['zebra'])).toEqual([{ text: 'plain', mark: false }]);
    expect(highlight('', ['a'])).toEqual([]);
  });
  it('prefers the longer term where two overlap', () => {
    expect(highlight('tracker', ['track', 'tracker'])).toEqual([{ text: 'tracker', mark: true }]);
  });
  it('escapes regular expression characters', () => {
    expect(highlight('a (b) c', ['(b)'])).toEqual([
      { text: 'a ', mark: false },
      { text: '(b)', mark: true },
      { text: ' c', mark: false },
    ]);
  });
});

describe('scroll-spy reducer', () => {
  const order = ['a', 'b', 'c', 'd'];
  const enter = (id: string) => ({ id, intersecting: true, above: false });
  const leaveAbove = (id: string) => ({ id, intersecting: false, above: true });
  const leaveBelow = (id: string) => ({ id, intersecting: false, above: false });

  it('starts with nothing active', () => {
    expect(spyInitial(order).active).toBeNull();
  });

  it('activates the first heading in reading order among those in the band', () => {
    expect(spyReduce(spyInitial(order), [enter('c'), enter('b')]).active).toBe('b');
  });

  it('moves on as the next heading enters the band and the one before leaves above it', () => {
    let s = spyReduce(spyInitial(order), [enter('a')]);
    expect(s.active).toBe('a');
    s = spyReduce(s, [leaveAbove('a'), enter('b')]);
    expect(s.active).toBe('b');
  });

  it('keeps the heading that scrolled up out of the band active until the next one arrives', () => {
    let s = spyReduce(spyInitial(order), [enter('b')]);
    s = spyReduce(s, [leaveAbove('b')]);
    expect(s.active).toBe('b');
    s = spyReduce(s, [enter('c')]);
    expect(s.active).toBe('c');
  });

  it('goes back to the heading before when the active one is scrolled back below the band', () => {
    let s = spyReduce(spyInitial(order), [enter('c')]);
    s = spyReduce(s, [leaveBelow('c')]);
    expect(s.active).toBe('b');
  });

  it('stays on the first heading when it is scrolled back below the band', () => {
    let s = spyReduce(spyInitial(order), [enter('a')]);
    s = spyReduce(s, [leaveBelow('a')]);
    expect(s.active).toBe('a');
  });

  it('reads the first batch an observer reports (above, above, below) as being inside the second heading', () => {
    const s = spyReduce(spyInitial(order), [leaveAbove('a'), leaveAbove('b'), leaveBelow('c'), leaveBelow('d')]);
    expect(s.active).toBe('b');
  });

  it('keeps the active heading when nothing happened', () => {
    const s = spyReduce(spyReduce(spyInitial(order), [enter('b')]), []);
    expect(s.active).toBe('b');
  });

  it('ignores a heading it does not know and does not mutate the state it was given', () => {
    const before = spyInitial(order);
    const frozen = JSON.stringify(before);
    expect(spyReduce(before, [enter('zzz')]).active).toBeNull();
    spyReduce(before, [enter('a')]);
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('guideKeyAction', () => {
  const key = (k: string, over: Partial<Parameters<typeof guideKeyAction>[0]> = {}) => guideKeyAction({ key: k, target: 'body', ctrlKey: false, metaKey: false, altKey: false, ...over });

  it.each([
    ['j', 'next'],
    ['J', 'next'],
    ['k', 'prev'],
    ['K', 'prev'],
    ['/', 'search'],
  ])('%s is %s', (k, action) => {
    expect(key(k)).toBe(action);
  });

  it.each(['x', ' ', 'Enter', 'ArrowDown', 'ArrowUp', 'l', 'c'])('ignores %j (the arrows scroll the page)', (k) => {
    expect(key(k)).toBeNull();
  });

  it('works from a button or a link, but not while typing or with a modifier', () => {
    expect(key('j', { target: 'button' })).toBe('next');
    expect(key('/', { target: 'link' })).toBe('search');
    for (const target of ['input', 'textarea', 'select', 'editable']) {
      expect(key('j', { target })).toBeNull();
      expect(key('/', { target })).toBeNull();
    }
    expect(key('j', { ctrlKey: true })).toBeNull();
    expect(key('j', { metaKey: true })).toBeNull();
    expect(key('/', { altKey: true })).toBeNull();
  });
});
