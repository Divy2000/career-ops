import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_TYPES, listTutorials, parseManifest, parseRange, srtToVtt } from '../../server/domains/tutorials.js';
import { guideFileNames, parseGuide } from '../../server/domains/tutorial-manifest.mjs';
import { tempDir } from '../helpers/tmp.js';

describe('srtToVtt', () => {
  it('prefixes the WEBVTT header, drops cue numbers and turns timing commas into dots', () => {
    const srt = '1\n00:00:04,962 --> 00:00:09,880\nWelcome to the app.\n\n2\n00:00:09,930 --> 00:00:14,728\nSecond cue.\n';
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n00:00:04.962 --> 00:00:09.880\nWelcome to the app.\n\n00:00:09.930 --> 00:00:14.728\nSecond cue.\n');
  });

  it('leaves commas in the cue text alone and keeps multi-line cues together', () => {
    const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,500\nHello, world, again\nline two, with 1,5 inside\n');
    expect(out).toContain('00:00:01.000 --> 00:00:02.500\nHello, world, again\nline two, with 1,5 inside\n');
  });

  it('handles a BOM and CRLF line endings', () => {
    const out = srtToVtt('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n');
    expect(out).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n\n00:00:03.000 --> 00:00:04.000\nBye\n');
  });

  it('keeps a cue whose text is a bare number', () => {
    const out = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n42\n');
    expect(out).toContain('\n42\n');
  });

  it('turns an empty file into a header-only track', () => {
    expect(srtToVtt('')).toBe('WEBVTT\n');
  });
});

describe('parseRange', () => {
  const SIZE = 1000;
  it.each([
    ['bytes=0-99', { kind: 'range', start: 0, end: 99 }],
    ['bytes=500-599', { kind: 'range', start: 500, end: 599 }],
    ['bytes=900-', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-100', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'range', start: 0, end: 999 }],
    ['bytes=990-5000', { kind: 'range', start: 990, end: 999 }],
    ['bytes=999-999', { kind: 'range', start: 999, end: 999 }],
  ])('%s is satisfiable', (header, expected) => {
    expect(parseRange(header, SIZE)).toEqual(expected);
  });

  it.each(['bytes=1000-', 'bytes=2000-3000', 'bytes=5-2', 'bytes=-0', 'bytes=', 'bytes=abc', 'bytes=0-1,5-6', 'bytes=-', 'bytes=1.5-3'])('%s is unsatisfiable', (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a missing header or another unit', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-1', SIZE)).toEqual({ kind: 'none' });
  });

  it('cannot satisfy any range of an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('parseManifest', () => {
  const ok = { id: 'demo', title: 'Demo', description: 'A demo.', video: 'demo.mp4' };

  it('accepts a full manifest and sorts chapters by start', () => {
    const m = parseManifest({ ...ok, subtitles: 'demo.srt', poster: 'poster.jpg', transcript: 'script.md', chapters: [{ title: 'B', start: 30 }, { title: 'A', start: 0 }] }, 'demo');
    expect(m).toEqual({
      ok: true,
      manifest: {
        id: 'demo',
        title: 'Demo',
        description: 'A demo.',
        transcript: 'script.md',
        parts: [{ id: 'main', title: 'Demo', short: 'Demo', description: 'A demo.', video: 'demo.mp4', subtitles: 'demo.srt', poster: 'poster.jpg', duration: null, chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 30 }] }],
        chapters: [{ title: 'A', start: 0, part: 'main' }, { title: 'B', start: 30, part: 'main' }],
      },
    });
  });

  it('accepts a guide file name and keeps it', () => {
    const m = parseManifest({ ...ok, guide: 'guide.json' }, 'demo');
    expect(m).toMatchObject({ ok: true, manifest: { guide: 'guide.json' } });
  });

  it.each([
    ['a guide that is not json', 'guide.txt'],
    ['a guide in a subfolder', 'sub/guide.json'],
    ['a guide that climbs out', '../guide.json'],
    ['a hidden guide', '.guide.json'],
  ])('rejects %s', (_label, guide) => {
    const m = parseManifest({ ...ok, guide }, 'demo');
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(/guide/);
  });

  it('accepts videoLight and posterLight and keeps them', () => {
    const m = parseManifest({ ...ok, poster: 'poster.jpg', videoLight: 'demo-light.mp4', posterLight: 'poster-light.png' }, 'demo');
    expect(m).toMatchObject({ ok: true, manifest: { parts: [{ videoLight: 'demo-light.mp4', posterLight: 'poster-light.png' }] } });
  });

  it('leaves videoLight and posterLight out when the manifest does not name them', () => {
    const m = parseManifest(ok, 'demo');
    expect(m.ok && 'videoLight' in m.manifest.parts[0]!).toBe(false);
    expect(m.ok && 'posterLight' in m.manifest.parts[0]!).toBe(false);
  });

  it.each([
    ['a videoLight that is not an mp4', { videoLight: 'demo-light.webm' }, /videoLight/],
    ['a videoLight in a subfolder', { videoLight: 'sub/demo-light.mp4' }, /videoLight/],
    ['a videoLight that climbs out', { videoLight: '../demo-light.mp4' }, /videoLight/],
    ['a posterLight that is a gif', { posterLight: 'poster-light.gif' }, /posterLight/],
    ['a posterLight that climbs out', { posterLight: '../poster-light.jpg' }, /posterLight/],
    ['a videoLight that is the same file as video', { videoLight: 'demo.mp4' }, /videoLight.*different.*video/],
    ['a videoLight that differs from video only by case', { videoLight: 'DEMO.mp4' }, /videoLight.*different.*video/],
  ])('rejects %s', (_label, extra, message) => {
    const m = parseManifest({ ...ok, ...extra }, 'demo');
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(message);
  });

  it('defaults the description and chapters', () => {
    const m = parseManifest({ id: 'demo', title: 'Demo', video: 'demo.mp4' }, 'demo');
    expect(m).toEqual({ ok: true, manifest: { id: 'demo', title: 'Demo', description: '', parts: [{ id: 'main', title: 'Demo', short: 'Demo', video: 'demo.mp4', duration: null, chapters: [] }], chapters: [] } });
  });

  it.each([
    ['not an object', 'text', /object/],
    ['no title', { id: 'demo', video: 'demo.mp4' }, /title/],
    ['empty title', { ...ok, title: '' }, /title/],
    ['no video', { id: 'demo', title: 'x' }, /video/],
    ['id differs from the folder', { ...ok, id: 'other' }, /folder/],
    ['id with a slash', { ...ok, id: 'a/b' }, /id/],
    ['video in a subfolder', { ...ok, video: 'sub/demo.mp4' }, /video/],
    ['video that climbs out', { ...ok, video: '../demo.mp4' }, /video/],
    ['absolute video', { ...ok, video: '/etc/demo.mp4' }, /video/],
    ['video that is not an mp4', { ...ok, video: 'demo.exe' }, /video/],
    ['subtitles of the wrong type', { ...ok, subtitles: 'demo.txt' }, /subtitles/],
    ['transcript of the wrong type', { ...ok, transcript: 'script.html' }, /transcript/],
    ['poster of the wrong type', { ...ok, poster: 'poster.gif' }, /poster/],
    ['negative chapter start', { ...ok, chapters: [{ title: 'A', start: -1 }] }, /chapters/],
    ['chapter without a title', { ...ok, chapters: [{ start: 1 }] }, /chapters/],
    ['chapter start that is not a number', { ...ok, chapters: [{ title: 'A', start: '1' }] }, /chapters/],
  ])('rejects %s', (_label, value, message) => {
    const m = parseManifest(value, 'demo');
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(message);
  });
});

describe('parseManifest with parts', () => {
  const part = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Part ${id}`,
    video: `${id}.mp4`,
    duration: 100,
    chapters: [{ title: `${id} one`, start: 0 }],
    ...over,
  });
  const base = { id: 'tour', title: 'Tour', description: 'In parts.' };
  const parse = (over: Record<string, unknown>) => parseManifest({ ...base, ...over }, 'tour');
  const error = (over: Record<string, unknown>) => {
    const m = parse(over);
    return m.ok ? null : m.error;
  };

  it('given a manifest with 2 parts, when parsed, then parts are normalized with the short-label fallback and chapters are flattened with part ids in order', () => {
    const m = parse({
      transcript: 'script.md',
      parts: [
        part('start', { short: 'Start here', videoLight: 'start-light.mp4', subtitles: 'start.vtt', poster: 'start.jpg', posterLight: 'start-light.jpg', chapters: [{ title: 'Launch', start: 40 }, { title: 'Intro', start: 0 }] }),
        part('intel', { duration: 286.5 }),
      ],
    });
    expect(m).toEqual({
      ok: true,
      manifest: {
        id: 'tour',
        title: 'Tour',
        description: 'In parts.',
        transcript: 'script.md',
        parts: [
          {
            id: 'start',
            title: 'Part start',
            short: 'Start here',
            video: 'start.mp4',
            videoLight: 'start-light.mp4',
            subtitles: 'start.vtt',
            poster: 'start.jpg',
            posterLight: 'start-light.jpg',
            duration: 100,
            chapters: [{ title: 'Intro', start: 0 }, { title: 'Launch', start: 40 }],
          },
          { id: 'intel', title: 'Part intel', short: 'Part intel', video: 'intel.mp4', duration: 286.5, chapters: [{ title: 'intel one', start: 0 }] },
        ],
        chapters: [
          { title: 'Intro', start: 0, part: 'start' },
          { title: 'Launch', start: 40, part: 'start' },
          { title: 'intel one', start: 0, part: 'intel' },
        ],
      },
    });
  });

  it('given both video and parts, when parsed, then it is an error', () => {
    expect(error({ video: 'tour.mp4', parts: [part('a')] })).toMatch(/video.*either video or parts/);
  });

  it.each(['videoLight', 'subtitles', 'poster', 'posterLight', 'chapters'])('given parts plus a top-level %s, when parsed, then the error says to move it into a part', (field) => {
    const value = { videoLight: 'x-light.mp4', subtitles: 'x.vtt', poster: 'x.jpg', posterLight: 'x-light.jpg', chapters: [] }[field];
    expect(error({ [field]: value, parts: [part('a')] })).toMatch(new RegExp(`${field}: .*move it into a part`));
  });

  it('given a repeated part id, when parsed, then it is an error naming the id', () => {
    expect(error({ parts: [part('a'), part('a', { video: 'other.mp4' })] })).toMatch(/parts\.1\.id: duplicate part id "a"/);
  });

  it('given a file name used twice with different case, when parsed, then it is an error naming both places', () => {
    expect(error({ parts: [part('a', { poster: 'Shared.jpg' }), part('b', { posterLight: 'shared.JPG' })] })).toMatch(/parts\.1\.posterLight: "shared\.JPG" is already used by parts\.0\.poster/);
  });

  it.each([
    ['at', 100],
    ['past', 130],
  ])('given a chapter start %s the part duration, when parsed, then it is an error', (_label, start) => {
    expect(error({ parts: [part('a', { chapters: [{ title: 'One', start: 0 }, { title: 'Late', start }] })] })).toMatch(/parts\.0\.chapters\.1\.start: .*before the part's duration \(100\)/);
  });

  it.each([
    ['an empty part list', { parts: [] }, /parts/],
    ['a part without chapters', { parts: [part('a', { chapters: [] })] }, /parts\.0\.chapters/],
    ['a part without a video', { parts: [part('a', { video: undefined })] }, /parts\.0\.video/],
    ['a part without a duration', { parts: [part('a', { duration: undefined })] }, /parts\.0\.duration/],
    ['a zero duration', { parts: [part('a', { duration: 0 })] }, /parts\.0\.duration/],
    ['an unknown part key', { parts: [part('a', { extra: 1 })] }, /extra/],
    ['a part id that is not slug-safe', { parts: [part('a b')] }, /parts\.0\.id/],
    ['a part title of 121 characters', { parts: [part('a', { title: 'x'.repeat(121) })] }, /parts\.0\.title/],
    ['a blank short label', { parts: [part('a', { short: '  ' })] }, /parts\.0\.short/],
    ['a short label of 25 characters', { parts: [part('a', { short: 'x'.repeat(25) })] }, /parts\.0\.short/],
    ['an empty part description', { parts: [part('a', { description: '' })] }, /parts\.0\.description/],
    ['a blank part description', { parts: [part('a', { description: '   ' })] }, /parts\.0\.description/],
    ['a part description of 301 characters', { parts: [part('a', { description: 'x'.repeat(301) })] }, /parts\.0\.description/],
    ['a part description that is not a string', { parts: [part('a', { description: 42 })] }, /parts\.0\.description/],
    ['a part video that climbs out', { parts: [part('a', { video: '../a.mp4' })] }, /parts\.0\.video/],
    ['a part poster that is a gif', { parts: [part('a', { poster: 'a.gif' })] }, /parts\.0\.poster/],
  ])('rejects %s', (_label, over, message) => {
    expect(error(over)).toMatch(message);
  });

  it('given a part with a description, when parsed, then it is kept trimmed, and a part without one has none', () => {
    const m = parse({ parts: [part('a', { description: '  Where new roles land.  ' }), part('b')] });
    if (!m.ok) throw new Error(m.error);
    expect(m.manifest.parts[0]!.description).toBe('Where new roles land.');
    expect('description' in m.manifest.parts[1]!).toBe(false);
  });

  it('accepts a part description of exactly 300 characters (after trimming)', () => {
    const m = parse({ parts: [part('a', { description: ` ${'x'.repeat(300)} ` })] });
    expect(m.ok && m.manifest.parts[0]!.description).toBe('x'.repeat(300));
  });

  it('given a single-video manifest, when parsed, then its one part takes the tutorial description, and none when the tutorial has none', () => {
    const withText = parseManifest({ id: 'demo', title: 'Demo', description: 'A demo.', video: 'demo.mp4' }, 'demo');
    expect(withText.ok && withText.manifest.parts[0]!.description).toBe('A demo.');
    const without = parseManifest({ id: 'demo', title: 'Demo', video: 'demo.mp4' }, 'demo');
    expect(without.ok && 'description' in without.manifest.parts[0]!).toBe(false);
  });

  it('given today\'s single-video manifest, when parsed, then it becomes one part "main" that keeps every media field', () => {
    const m = parseManifest(
      { id: 'demo', title: 'Demo', description: 'A demo.', video: 'demo.mp4', videoLight: 'demo-light.mp4', subtitles: 'demo.srt', poster: 'p.jpg', posterLight: 'p-light.jpg', transcript: 'script.md', guide: 'guide.json', chapters: [{ title: 'B', start: 30 }, { title: 'A', start: 0 }] },
      'demo',
    );
    expect(m).toEqual({
      ok: true,
      manifest: {
        id: 'demo',
        title: 'Demo',
        description: 'A demo.',
        transcript: 'script.md',
        guide: 'guide.json',
        parts: [
          {
            id: 'main',
            title: 'Demo',
            short: 'Demo',
            description: 'A demo.',
            video: 'demo.mp4',
            videoLight: 'demo-light.mp4',
            subtitles: 'demo.srt',
            poster: 'p.jpg',
            posterLight: 'p-light.jpg',
            duration: null,
            chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 30 }],
          },
        ],
        chapters: [
          { title: 'A', start: 0, part: 'main' },
          { title: 'B', start: 30, part: 'main' },
        ],
      },
    });
  });

  it('given a guide chapter index equal to the total chapter count, when parsed, then it is rejected; total - 1 is accepted', () => {
    const m = parse({ parts: [part('a', { chapters: [{ title: 'One', start: 0 }, { title: 'Two', start: 10 }] }), part('b')] });
    if (!m.ok) throw new Error(m.error);
    const total = m.manifest.chapters.length;
    expect(total).toBe(3);
    const guide = (chapter: number) => ({ sections: [{ id: 's', title: 'S', summary: 's', gif: 's.gif', steps: ['x'], chapter }] });
    expect(parseGuide(guide(total), { chapterCount: total }).ok).toBe(false);
    expect(parseGuide(guide(total - 1), { chapterCount: total }).ok).toBe(true);
  });
});

describe('media types', () => {
  it('serves animated images', () => {
    expect(MEDIA_TYPES['.gif']).toBe('image/gif');
    expect(MEDIA_TYPES['.webp']).toBe('image/webp');
  });
});

describe('parseGuide', () => {
  const section = { id: 'today', title: 'Today', summary: 'The daily shortlist.', route: '/today', gif: 'today.gif', steps: ['Open Today.'] };
  const guide = (...sections: unknown[]) => ({ sections });

  it('accepts a full section and keeps every field', () => {
    const full = { ...section, poster: 'today.jpg', tips: ['Press j.'], chapter: 2 };
    expect(parseGuide(guide(full), { chapterCount: 3 })).toEqual({ ok: true, guide: { sections: [full] } });
  });

  it('accepts a section with only the required fields', () => {
    const minimal = { id: 'a', title: 'A', summary: 's', gif: 'a.webp', steps: ['one'] };
    expect(parseGuide(guide(minimal), { chapterCount: 0 })).toEqual({ ok: true, guide: { sections: [minimal] } });
  });

  it('allows ordinary percent-encoding in a route, and dots that are not whole segments', () => {
    expect(parseGuide(guide({ ...section, route: '/application/a%20b/v1.2/..x' }), { chapterCount: 0 }).ok).toBe(true);
  });

  it('does not read an encoded dot segment in the query as a path segment', () => {
    expect(parseGuide(guide({ ...section, route: '/tracker?back=%2e%2e' }), { chapterCount: 0 }).ok).toBe(true);
  });

  it('allows a query string and a hash on the route', () => {
    expect(parseGuide(guide({ ...section, route: '/tracker?status=Applied#top' }), { chapterCount: 0 }).ok).toBe(true);
  });

  it.each([
    ['not an object', 'text', /object/],
    ['no sections', {}, /sections/],
    ['an empty section list', guide(), /sections/],
    ['a section without a title', guide({ ...section, title: '' }), /title/],
    ['a section without a summary', guide({ ...section, summary: undefined }), /summary/],
    ['a section without a gif', guide({ ...section, gif: undefined }), /gif/],
    ['a gif that is not a gif or webp', guide({ ...section, gif: 'today.mp4' }), /gif/],
    ['a gif in a subfolder', guide({ ...section, gif: 'sub/today.gif' }), /gif/],
    ['a gif that climbs out', guide({ ...section, gif: '../today.gif' }), /gif/],
    ['a poster that is a gif', guide({ ...section, poster: 'today.gif' }), /poster/],
    ['no steps', guide({ ...section, steps: [] }), /steps/],
    ['too many steps', guide({ ...section, steps: Array.from({ length: 13 }, () => 'x') }), /steps/],
    ['an empty step', guide({ ...section, steps: [''] }), /steps/],
    ['a step that is too long', guide({ ...section, steps: ['x'.repeat(501)] }), /steps/],
    ['too many tips', guide({ ...section, tips: Array.from({ length: 7 }, () => 'x') }), /tips/],
    ['an id that is not slug-safe', guide({ ...section, id: 'a b' }), /id/],
    ['an id with a slash', guide({ ...section, id: 'a/b' }), /id/],
    ['a negative chapter', guide({ ...section, chapter: -1 }), /chapter/],
    ['a fractional chapter', guide({ ...section, chapter: 1.5 }), /chapter/],
    ['a chapter that does not exist', guide({ ...section, chapter: 3 }), /chapter 3.*3 chapters/],
    ['a route without a leading slash', guide({ ...section, route: 'today' }), /route/],
    ['a protocol-relative route', guide({ ...section, route: '//evil.example/x' }), /route/],
    ['a route with a scheme', guide({ ...section, route: 'https://evil.example/' }), /route/],
    ['a javascript route', guide({ ...section, route: 'javascript:alert(1)' }), /route/],
    ['a route with a backslash', guide({ ...section, route: '/\\evil.example' }), /route/],
    ['a route with a double slash inside', guide({ ...section, route: '/a//b' }), /route/],
    ['a route with a parent segment', guide({ ...section, route: '/a/../b' }), /route/],
    ['a route with an encoded parent segment', guide({ ...section, route: '/today/%2e%2e/settings' }), /route/],
    ['a route with an upper-case encoded parent segment', guide({ ...section, route: '/today/%2E%2E/settings' }), /route/],
    ['a route with a mixed-case encoded parent segment', guide({ ...section, route: '/today/%2e./settings' }), /route/],
    ['a route with an encoded current-directory segment', guide({ ...section, route: '/today/%2e/settings' }), /route/],
    ['a route with a plain current-directory segment', guide({ ...section, route: '/today/./settings' }), /route/],
    ['a route with an encoded slash', guide({ ...section, route: '/a%2f%2fb' }), /route/],
    ['a route with an encoded backslash', guide({ ...section, route: '/a%5Cb' }), /route/],
    ['a route with a bad percent escape', guide({ ...section, route: '/a%zz' }), /route/],
    ['a route with a truncated percent escape', guide({ ...section, route: '/a%2' }), /route/],
    ['a route that decodes to invalid UTF-8', guide({ ...section, route: '/a%ff' }), /route/],
    ['a route with whitespace', guide({ ...section, route: '/a b' }), /route/],
    ['a route with a control character', guide({ ...section, route: '/a\u0000b' }), /route/],
    ['a route that is too long', guide({ ...section, route: `/${'a'.repeat(250)}` }), /route/],
  ])('rejects %s', (_label, value, message) => {
    const r = parseGuide(value, { chapterCount: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('rejects duplicate section ids and names the id', () => {
    const r = parseGuide(guide(section, { ...section, title: 'Again' }), { chapterCount: 0 });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/duplicate.*"today"/i) });
  });

  it('rejects more than 60 sections and accepts exactly 60', () => {
    const many = (n: number) => guide(...Array.from({ length: n }, (_, i) => ({ ...section, id: `s${i}` })));
    expect(parseGuide(many(60), { chapterCount: 0 }).ok).toBe(true);
    const r = parseGuide(many(61), { chapterCount: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sections/);
  });

  it('names the section a problem is in', () => {
    const r = parseGuide(guide(section, { ...section, id: 'tracker', gif: 'x.exe' }), { chapterCount: 0 });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/sections\.1\.gif/) });
  });
});

describe('guideFileNames', () => {
  it('lists each gif and poster once, in section order', () => {
    const names = guideFileNames({
      sections: [
        { id: 'a', title: 'A', summary: 's', gif: 'a.gif', poster: 'p.jpg', steps: ['x'] },
        { id: 'b', title: 'B', summary: 's', gif: 'b.gif', poster: 'p.jpg', steps: ['x'] },
        { id: 'c', title: 'C', summary: 's', gif: 'a.gif', steps: ['x'] },
      ],
    });
    expect(names).toEqual(['a.gif', 'p.jpg', 'b.gif']);
  });
});

describe('listTutorials with parts', () => {
  let root: string;
  const folder = () => path.join(root, 'data', 'control-center', 'tutorials', 'tour');
  const part = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Part ${id}`,
    video: `${id}.mp4`,
    videoLight: `${id}-light.mp4`,
    subtitles: `${id}.srt`,
    poster: `${id}.jpg`,
    posterLight: `${id}-light.jpg`,
    duration: 120,
    chapters: [{ title: `${id} one`, start: 0 }, { title: `${id} two`, start: 60 }],
    ...over,
  });
  const write = (manifest: unknown, skip: string[] = []) => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'tutorial.json'), JSON.stringify(manifest));
    for (const id of ['a', 'b']) {
      for (const name of [`${id}.mp4`, `${id}-light.mp4`, `${id}.srt`, `${id}.jpg`, `${id}-light.jpg`]) if (!skip.includes(name)) fs.writeFileSync(path.join(folder(), name), `bytes of ${name}`);
    }
  };
  const manifest = { id: 'tour', title: 'Tour', parts: [part('a', { short: 'First' }), part('b')] };
  const url = (name: string) => `/api/tutorials/tour/media/${name}`;

  beforeEach(() => {
    root = tempDir('cc-tut-parts-');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('given a parts folder, when listed, then each part has its urls, label and length, and the chapters carry part ids', () => {
    write(manifest);
    const { tutorials, warnings } = listTutorials(root);
    expect(warnings).toEqual([]);
    const [tour] = tutorials;
    expect(tour!.warnings).toEqual([]);
    expect(tour!.parts).toEqual([
      {
        id: 'a',
        title: 'Part a',
        short: 'First',
        description: null,
        duration: 120,
        video: { file: 'a.mp4', url: url('a.mp4'), bytes: 'bytes of a.mp4'.length },
        videoLight: { file: 'a-light.mp4', url: url('a-light.mp4'), bytes: 'bytes of a-light.mp4'.length },
        subtitles: { file: 'a.srt', url: url('a.srt'), format: 'srt' },
        poster: { file: 'a.jpg', url: url('a.jpg') },
        posterLight: { file: 'a-light.jpg', url: url('a-light.jpg') },
        chapters: [{ title: 'a one', start: 0 }, { title: 'a two', start: 60 }],
      },
      expect.objectContaining({ id: 'b', short: 'Part b', video: expect.objectContaining({ url: url('b.mp4') }) }),
    ]);
    expect(tour!.chapters).toEqual([
      { title: 'a one', start: 0, part: 'a' },
      { title: 'a two', start: 60, part: 'a' },
      { title: 'b one', start: 0, part: 'b' },
      { title: 'b two', start: 60, part: 'b' },
    ]);
  });

  it('given one part with a description, when listed, then that part carries it and the other has null', () => {
    write({ ...manifest, parts: [part('a', { description: 'Where new roles land.' }), part('b')] });
    const [tour] = listTutorials(root).tutorials;
    expect(tour!.parts.map((p) => p.description)).toEqual(['Where new roles land.', null]);
  });

  it('given a single-video manifest with a description, when listed, then its one part carries the tutorial description', () => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'tutorial.json'), JSON.stringify({ id: 'tour', title: 'Tour', description: 'The whole tour.', video: 'a.mp4' }));
    fs.writeFileSync(path.join(folder(), 'a.mp4'), 'x');
    expect(listTutorials(root).tutorials[0]!.parts[0]!.description).toBe('The whole tour.');
  });

  it('given a part video is missing, when listed, then the folder is skipped with a warning naming the part', () => {
    write(manifest, ['b.mp4']);
    const { tutorials, warnings } = listTutorials(root);
    expect(tutorials).toEqual([]);
    expect(warnings).toEqual([{ folder: 'tour', message: 'part "b" video file "b.mp4" not found' }]);
  });

  it("given a part's light video is missing, when listed, then that part has videoLight null and a warning naming the part", () => {
    write(manifest, ['b-light.mp4']);
    const [tour] = listTutorials(root).tutorials;
    expect(tour!.parts[0]!.videoLight).not.toBeNull();
    expect(tour!.parts[1]!.videoLight).toBeNull();
    expect(tour!.warnings).toEqual(['part "b" light video file "b-light.mp4" not found, so it is ignored']);
  });

  it('given a single-video manifest, when listed, then it is one part "main" with no declared length', () => {
    fs.mkdirSync(folder(), { recursive: true });
    fs.writeFileSync(path.join(folder(), 'tutorial.json'), JSON.stringify({ id: 'tour', title: 'Tour', video: 'a.mp4', chapters: [{ title: 'Intro', start: 0 }] }));
    fs.writeFileSync(path.join(folder(), 'a.mp4'), 'x');
    const [tour] = listTutorials(root).tutorials;
    expect(tour!.parts).toEqual([{ id: 'main', title: 'Tour', short: 'Tour', description: null, duration: null, video: { file: 'a.mp4', url: url('a.mp4'), bytes: 1 }, videoLight: null, subtitles: null, poster: null, posterLight: null, chapters: [{ title: 'Intro', start: 0 }] }]);
    expect(tour!.chapters).toEqual([{ title: 'Intro', start: 0, part: 'main' }]);
  });
});
