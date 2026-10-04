import { describe, expect, it } from 'vitest';
import { MEDIA_TYPES, parseManifest, parseRange, srtToVtt } from '../../server/domains/tutorials.js';
import { guideFileNames, parseGuide } from '../../server/domains/tutorial-manifest.mjs';

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
    expect(m).toEqual({ ok: true, manifest: { ...ok, subtitles: 'demo.srt', poster: 'poster.jpg', transcript: 'script.md', chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 30 }] } });
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
    expect(m).toMatchObject({ ok: true, manifest: { videoLight: 'demo-light.mp4', posterLight: 'poster-light.png' } });
  });

  it('leaves videoLight and posterLight out when the manifest does not name them', () => {
    const m = parseManifest(ok, 'demo');
    expect(m.ok && 'videoLight' in m.manifest).toBe(false);
    expect(m.ok && 'posterLight' in m.manifest).toBe(false);
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
    expect(m).toEqual({ ok: true, manifest: { id: 'demo', title: 'Demo', description: '', video: 'demo.mp4', chapters: [] } });
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
