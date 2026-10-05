import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { installTutorial } from '../../scripts/install-tutorial.mjs';
import { listTutorials } from '../../server/domains/tutorials.js';
import { tinyPng, writeDemoTutorials } from '../e2e/roots.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-roots-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeDemoTutorials', () => {
  it('writes a demo tour with a light video and poster that the listing accepts, and a second tour with none', () => {
    writeDemoTutorials(dir);
    const { tutorials } = listTutorials(dir);
    const demo = tutorials.find((t) => t.id === 'demo-tour')!;
    expect(demo.warnings).toEqual([]);
    expect(demo.parts[0]!.videoLight).toMatchObject({ file: 'demo-tour-light.mp4' });
    expect(demo.parts[0]!.videoLight!.bytes).toBeGreaterThan(1000);
    expect(demo.parts[0]!.posterLight).toMatchObject({ file: 'poster-light.jpg' });
    const second = tutorials.find((t) => t.id === 'second-tour')!;
    expect(second.parts[0]!.videoLight).toBeNull();
  });

  it('writes a tour in three parts, each with its light video, subtitles and posters, that the listing accepts with its guide', () => {
    writeDemoTutorials(dir);
    const tour = listTutorials(dir).tutorials.find((t) => t.id === 'parts-tour')!;
    expect(tour.warnings).toEqual([]);
    expect(tour.parts.map((p) => [p.id, p.duration, p.videoLight?.file, p.subtitles?.format, p.posterLight?.file])).toEqual([
      ['a', 30, 'a-light.mp4', 'srt', 'a-poster-light.jpg'],
      ['b', 2, 'b-light.mp4', 'srt', 'b-poster-light.jpg'],
      ['c', 2, 'c-light.mp4', 'srt', 'c-poster-light.jpg'],
    ]);
    expect(tour.guideDocs?.sections[0]?.subsections.map((u) => tour.chapters[u.chapter!]?.part)).toEqual(['a', 'c']);
    expect(tour.parts.map((p) => p.description)).toEqual([null, 'Where new roles land, and how to sort them.', null]);
  });

  it('makes the light video a different file from the dark one', () => {
    writeDemoTutorials(dir);
    const root = path.join(dir, 'data', 'control-center', 'tutorials', 'demo-tour');
    expect(fs.readFileSync(path.join(root, 'demo-tour-light.mp4')).equals(fs.readFileSync(path.join(root, 'demo-tour.mp4')))).toBe(false);
  });
});

describe('tinyPng', () => {
  it('is a valid PNG of the requested size and colour', () => {
    const png = tinyPng([10, 20, 30], 5, 3);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(5);
    expect(png.readUInt32BE(20)).toBe(3);
    const idat = png.indexOf('IDAT');
    const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
    expect(raw.length).toBe(3 * (1 + 5 * 3));
    expect([...raw.subarray(1, 4)]).toEqual([10, 20, 30]);
    expect(png.readUInt32BE(idat + 4 + png.readUInt32BE(idat - 4))).toBe(zlib.crc32(png.subarray(idat, idat + 4 + png.readUInt32BE(idat - 4))));
  });
});

describe('writeDemoTutorials, the documentation guide fixture', () => {
  const folder = () => path.join(dir, 'data', 'control-center', 'tutorials', 'docs-tour');

  it('lists a tutorial with a version 2 guide that has no warning, with dark and light files that differ', () => {
    writeDemoTutorials(dir);
    const docs = listTutorials(dir).tutorials.find((t) => t.id === 'docs-tour')!;
    expect(docs.warnings).toEqual([]);
    expect(docs.guide).toBeNull();
    expect(docs.guideDocs).toMatchObject({ version: 2, legacy: false });
    const media = docs.guideDocs!.sections.flatMap((s) => s.subsections.flatMap((u) => u.blocks)).filter((b) => b.type === 'media');
    expect(media.map((b) => b.type === 'media' && b.kind).sort()).toEqual(['gif', 'image', 'image']);
    for (const b of media) {
      if (b.type !== 'media') continue;
      const name = (u: string | null) => decodeURIComponent(u!.split('/').pop()!);
      expect(fs.readFileSync(path.join(folder(), name(b.url))).equals(fs.readFileSync(path.join(folder(), name(b.urlLight))))).toBe(false);
      expect(fs.readFileSync(path.join(folder(), name(b.posterUrl ?? b.url))).equals(fs.readFileSync(path.join(folder(), name(b.posterLightUrl ?? b.urlLight))))).toBe(false);
    }
  });

  it('declares sizes that match the files, so install-tutorial --strict-dims accepts the folder', () => {
    writeDemoTutorials(dir);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-roots-target-'));
    try {
      expect(installTutorial({ source: folder(), dataRoot: target, strictDims: true }).id).toBe('docs-tour');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('has subsections that use a route and a chapter, so the page can link to the app and the video', () => {
    writeDemoTutorials(dir);
    const docs = listTutorials(dir).tutorials.find((t) => t.id === 'docs-tour')!;
    const subs = docs.guideDocs!.sections.flatMap((s) => s.subsections);
    expect(subs.some((u) => u.route !== null && u.chapter !== null)).toBe(true);
    expect(docs.guideDocs!.sections.length).toBeGreaterThan(1);
  });
});
