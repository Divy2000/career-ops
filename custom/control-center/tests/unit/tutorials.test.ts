import { describe, expect, it } from 'vitest';
import { parseManifest, parseRange, srtToVtt } from '../../server/domains/tutorials.js';

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
