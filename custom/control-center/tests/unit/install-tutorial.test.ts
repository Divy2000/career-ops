import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { imageSize, installTutorial } from '../../scripts/install-tutorial.mjs';
import { listTutorials, parseManifest } from '../../server/domains/tutorials.js';
import { MAX_GUIDE_BYTES } from '../../server/domains/tutorial-manifest.mjs';
import { PACKAGE_ROOT } from '../helpers/app.js';

const GUIDE = {
  sections: [
    { id: 'today', title: 'Today', summary: 'The daily shortlist.', route: '/today', gif: 'today.gif', poster: 'today.jpg', steps: ['Open Today.'], chapter: 1 },
    { id: 'tracker', title: 'Tracker', summary: 'Every application.', gif: 'tracker.webp', steps: ['Open Tracker.'] },
  ],
};

const SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'install-tutorial.mjs');
const TOC = [
  { number: 1, id: 'intro', title: 'Intro and safety model', start: 0, duration: 130.2 },
  { number: 2, id: 'launch', title: 'Launching and login token', start: 130.2, duration: 103.3 },
];
let work: string;
let dataRoot: string;
const dest = (id: string) => path.join(dataRoot, 'data', 'control-center', 'tutorials', id);
const write = (rel: string, content: string | Buffer, base = path.join(work, 'src')) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), content);
};
const src = () => path.join(work, 'src');

/** The folder layout of a recording: chapters/toc.json, one mp4, one srt and tutorial/script.md. */
function recordingFolder() {
  write('chapters/toc.json', JSON.stringify(TOC));
  write('chapters/01-intro.mp4', 'chapter clip that must not be copied');
  write('my-recording.mp4', 'VIDEO-BYTES');
  write('my-recording.srt', '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  write('tutorial/script.md', '# Script\n\nHello.\n');
  write('raw/huge.bin', 'must not be copied');
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-install-tut-'));
  dataRoot = path.join(work, 'data-root');
  fs.mkdirSync(dataRoot, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

describe('installTutorial from a recording folder (toc.json, srt, script.md)', () => {
  it('writes tutorial.json with the chapters and copies only the files it names', () => {
    recordingFolder();
    const r = installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'My tour', description: 'A walk through.' });
    expect(r).toMatchObject({ id: 'my-tour', dest: dest('my-tour'), built: true, dryRun: false });
    const manifest = JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8'));
    expect(manifest).toEqual({
      id: 'my-tour',
      title: 'My tour',
      description: 'A walk through.',
      video: 'my-recording.mp4',
      subtitles: 'my-recording.srt',
      transcript: 'script.md',
      chapters: [
        { title: 'Intro and safety model', start: 0 },
        { title: 'Launching and login token', start: 130.2 },
      ],
    });
    expect(parseManifest(manifest, 'my-tour').ok).toBe(true);
    expect(fs.readdirSync(dest('my-tour')).sort()).toEqual(['my-recording.mp4', 'my-recording.srt', 'script.md', 'tutorial.json']);
    expect(fs.readFileSync(path.join(dest('my-tour'), 'my-recording.mp4'), 'utf8')).toBe('VIDEO-BYTES');
  });

  it('is picked up by the Tutorials listing', () => {
    recordingFolder();
    installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'My tour' });
    const listed = listTutorials(dataRoot);
    expect(listed.warnings).toEqual([]);
    expect(listed.tutorials.map((t) => [t.id, t.chapters.length, t.parts[0]?.subtitles?.format])).toEqual([['my-tour', 2, 'srt']]);
  });

  it('prefers a .vtt over an .srt and picks up a poster', () => {
    recordingFolder();
    write('my-recording.vtt', 'WEBVTT\n');
    write('poster.jpg', 'JPEG');
    installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'My tour' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8'));
    expect(manifest).toMatchObject({ subtitles: 'my-recording.vtt', poster: 'poster.jpg' });
    expect(fs.existsSync(path.join(dest('my-tour'), 'my-recording.srt'))).toBe(false);
  });

  it('derives the id from the video name and the title from the id when none are given', () => {
    recordingFolder();
    const r = installTutorial({ source: src(), dataRoot });
    expect(r.id).toBe('my-recording');
    expect(JSON.parse(fs.readFileSync(path.join(dest('my-recording'), 'tutorial.json'), 'utf8')).title).toBe('My recording');
  });

  it('builds a tutorial without chapters when there is no toc.json', () => {
    write('a.mp4', 'V');
    installTutorial({ source: src(), dataRoot, id: 'plain', title: 'Plain' });
    expect(JSON.parse(fs.readFileSync(path.join(dest('plain'), 'tutorial.json'), 'utf8')).chapters).toEqual([]);
  });

  it.each([
    ['toc.json that is not JSON', '{ nope', /toc\.json.*not valid JSON/],
    ['toc.json that is not a list', '{"a":1}', /toc\.json.*list/],
    ['a chapter without a title', '[{"start":0}]', /toc\.json.*title/],
    ['a negative start', '[{"title":"A","start":-1}]', /toc\.json.*start/],
  ])('refuses %s and writes nothing', (_label, toc, message) => {
    recordingFolder();
    write('chapters/toc.json', toc);
    expect(() => installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'T' })).toThrow(message);
    expect(fs.existsSync(dest('my-tour'))).toBe(false);
  });

  it('asks which video to use when there are several, and fails when there is none', () => {
    recordingFolder();
    write('other.mp4', 'V2');
    expect(() => installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'T' })).toThrow(/more than one \.mp4.*--video/);
    expect(installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'T', video: 'other.mp4' }).manifest.parts[0]!.video).toBe('other.mp4');
    fs.rmSync(path.join(src(), 'other.mp4'));
    fs.rmSync(path.join(src(), 'my-recording.mp4'));
    expect(() => installTutorial({ source: src(), dataRoot, id: 'second', title: 'T' })).toThrow(/no \.mp4/);
  });
});

describe('installTutorial from a folder that already has tutorial.json', () => {
  const manifest = { id: 'v2-tour', title: 'Remade tour', description: 'Version 2.', video: 'tour.mp4', subtitles: 'tour.vtt', poster: 'poster.jpg', transcript: 'script.md', chapters: [{ title: 'B', start: 20 }, { title: 'A', start: 0 }] };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  const files = () => {
    write('tutorial.json', manifestText);
    write('tour.mp4', 'V');
    write('tour.vtt', 'WEBVTT\n');
    write('poster.jpg', 'JPEG');
    write('script.md', '# S\n');
    write('unreferenced.bin', 'x');
  };

  it('validates, then copies tutorial.json byte for byte with the files it references', () => {
    files();
    const r = installTutorial({ source: src(), dataRoot });
    expect(r).toMatchObject({ id: 'v2-tour', built: false });
    expect(fs.readFileSync(path.join(dest('v2-tour'), 'tutorial.json'), 'utf8')).toBe(manifestText);
    expect(fs.readdirSync(dest('v2-tour')).sort()).toEqual(['poster.jpg', 'script.md', 'tour.mp4', 'tour.vtt', 'tutorial.json']);
  });

  it.each([
    ['invalid JSON', '{ nope', /tutorial\.json is not valid JSON/],
    ['a missing title', JSON.stringify({ id: 'v2-tour', video: 'tour.mp4' }), /title/],
    ['a video path that climbs out', JSON.stringify({ ...manifest, video: '../tour.mp4' }), /video/],
    ['a file that is not in the folder', JSON.stringify({ ...manifest, poster: 'gone.jpg' }), /poster file "gone\.jpg" not found/],
    ['an id that is not a safe folder name', JSON.stringify({ ...manifest, id: '../evil' }), /id/],
  ])('refuses %s and writes nothing', (_label, text, message) => {
    files();
    write('tutorial.json', text);
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(message);
    expect(fs.existsSync(path.join(dataRoot, 'data', 'control-center', 'tutorials', 'v2-tour'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'evil'))).toBe(false);
  });

  it('does not let --id rename a manifest that is copied as-is', () => {
    files();
    expect(() => installTutorial({ source: src(), dataRoot, id: 'other' })).toThrow(/already has tutorial\.json.*id/);
  });
});

describe('installTutorial with a quick guide', () => {
  const manifest = { id: 'guided', title: 'Guided', video: 'tour.mp4', guide: 'guide.json', chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 20 }] };
  const guideText = JSON.stringify(GUIDE, null, 2) + '\n';
  /** A folder with its own tutorial.json: the guide and its gifs sit next to it. */
  const folder = (over: { manifest?: unknown; guide?: string | null } = {}) => {
    write('tutorial.json', JSON.stringify(over.manifest ?? manifest));
    write('tour.mp4', 'V');
    if (over.guide !== null) write('guide.json', over.guide ?? guideText);
    write('today.gif', 'GIF-TODAY');
    write('today.jpg', 'JPEG');
    write('tracker.webp', 'WEBP');
    write('unreferenced.gif', 'must not be copied');
  };
  /** A recording folder: the guide and its gifs sit in guide/. */
  const recording = (guide = guideText) => {
    write('chapters/toc.json', JSON.stringify(TOC));
    write('tour.mp4', 'V');
    write('guide/guide.json', guide);
    write('guide/today.gif', 'GIF-TODAY');
    write('guide/today.jpg', 'JPEG');
    write('guide/tracker.webp', 'WEBP');
    write('guide/unreferenced.gif', 'must not be copied');
  };

  it('copies guide.json byte for byte with the gifs and posters it names, and nothing else', () => {
    folder();
    const r = installTutorial({ source: src(), dataRoot });
    expect(r.files.sort()).toEqual(['guide.json', 'today.gif', 'today.jpg', 'tour.mp4', 'tracker.webp', 'tutorial.json']);
    expect(fs.readdirSync(dest('guided')).sort()).toEqual(['guide.json', 'today.gif', 'today.jpg', 'tour.mp4', 'tracker.webp', 'tutorial.json']);
    expect(fs.readFileSync(path.join(dest('guided'), 'guide.json'), 'utf8')).toBe(guideText);
    expect(fs.readFileSync(path.join(dest('guided'), 'today.gif'), 'utf8')).toBe('GIF-TODAY');
  });

  it('is picked up by the Tutorials listing with the guide', () => {
    folder();
    installTutorial({ source: src(), dataRoot });
    const listed = listTutorials(dataRoot);
    expect(listed.warnings).toEqual([]);
    expect(listed.tutorials[0]?.warnings).toEqual([]);
    expect(listed.tutorials[0]?.guide?.sections.map((x) => x.id)).toEqual(['today', 'tracker']);
  });

  it('builds the manifest from a recording folder that has guide/guide.json and copies the gifs from guide/', () => {
    recording();
    const r = installTutorial({ source: src(), dataRoot, id: 'guided', title: 'Guided' });
    expect(r.built).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dest('guided'), 'tutorial.json'), 'utf8'))).toMatchObject({ video: 'tour.mp4', guide: 'guide.json' });
    expect(fs.readdirSync(dest('guided')).sort()).toEqual(['guide.json', 'today.gif', 'today.jpg', 'tour.mp4', 'tracker.webp', 'tutorial.json']);
    expect(fs.readFileSync(path.join(dest('guided'), 'guide.json'), 'utf8')).toBe(guideText);
    const listed = listTutorials(dataRoot);
    expect(listed.tutorials[0]?.warnings).toEqual([]);
    expect(listed.tutorials[0]?.guide?.sections).toHaveLength(2);
  });

  it('does not add a guide to a recording folder whose guide/ has no guide.json', () => {
    recording();
    fs.rmSync(path.join(src(), 'guide', 'guide.json'));
    installTutorial({ source: src(), dataRoot, id: 'guided', title: 'Guided' });
    expect(JSON.parse(fs.readFileSync(path.join(dest('guided'), 'tutorial.json'), 'utf8')).guide).toBeUndefined();
    expect(fs.readdirSync(dest('guided')).sort()).toEqual(['tour.mp4', 'tutorial.json']);
  });

  it('lets two sections share one poster and copies it once', () => {
    folder({ guide: JSON.stringify({ sections: GUIDE.sections.map((x) => ({ ...x, poster: 'today.jpg' })) }) });
    installTutorial({ source: src(), dataRoot });
    expect(fs.readdirSync(dest('guided')).filter((n) => n === 'today.jpg')).toHaveLength(1);
  });

  it('lists the guide files in a dry run and writes nothing', () => {
    folder();
    const r = installTutorial({ source: src(), dataRoot, dryRun: true });
    expect(r.files.sort()).toEqual(['guide.json', 'today.gif', 'today.jpg', 'tour.mp4', 'tracker.webp', 'tutorial.json']);
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });

  it('refuses a guide poster that would overwrite a different file of the tutorial', () => {
    recording();
    write('poster.jpg', 'TUTORIAL-POSTER');
    write('guide/poster.jpg', 'GUIDE-POSTER');
    write('guide/guide.json', JSON.stringify({ sections: [{ ...GUIDE.sections[0], poster: 'poster.jpg' }] }));
    expect(() => installTutorial({ source: src(), dataRoot, id: 'guided', title: 'Guided' })).toThrow(/poster\.jpg.*both/);
    expect(fs.existsSync(dest('guided'))).toBe(false);
  });

  it.each([
    ['a guide file that is not in the folder', null, /guide file "guide\.json" not found/],
    ['a guide that is not JSON', '{ nope', /guide\.json is not valid JSON/],
    ['a guide that is not an object', '[]', /guide\.json is invalid.*object/],
    ['a gif that is not in the folder', JSON.stringify({ sections: [{ ...GUIDE.sections[0], gif: 'gone.gif' }] }), /guide gif file "gone\.gif" not found/],
    ['a poster that is not in the folder', JSON.stringify({ sections: [{ ...GUIDE.sections[0], poster: 'gone.jpg' }] }), /guide poster file "gone\.jpg" not found/],
    ['a gif with a bad extension', JSON.stringify({ sections: [{ ...GUIDE.sections[0], gif: 'today.mp4' }] }), /guide\.json is invalid.*sections\.0\.gif/],
    ['a gif that climbs out', JSON.stringify({ sections: [{ ...GUIDE.sections[0], gif: '../today.gif' }] }), /sections\.0\.gif/],
    ['a route that is not an app path', JSON.stringify({ sections: [{ ...GUIDE.sections[0], route: '//evil.example' }] }), /sections\.0\.route/],
    ['duplicate section ids', JSON.stringify({ sections: [GUIDE.sections[0], GUIDE.sections[0]] }), /duplicate.*"today"/],
    ['a chapter the tutorial does not have', JSON.stringify({ sections: [{ ...GUIDE.sections[0], chapter: 2 }] }), /chapter 2.*2 chapters/],
  ])('refuses %s and writes nothing', (_label, guide, message) => {
    folder({ guide });
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(message);
    expect(fs.existsSync(path.join(dataRoot, 'data', 'control-center', 'tutorials', 'guided'))).toBe(false);
  });

  it('refuses a guide.json over the 1 MB cap that the server would reject, before copying anything', () => {
    folder({ guide: JSON.stringify({ ...GUIDE, ignoredByTheSchema: 'x'.repeat(1024 * 1024) }) });
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(/guide\.json is too large.*1 MB/);
    expect(fs.existsSync(path.join(dataRoot, 'data', 'control-center', 'tutorials', 'guided'))).toBe(false);
  });

  it('accepts a guide.json just under the cap', () => {
    folder({ guide: JSON.stringify({ ...GUIDE, pad: 'x'.repeat(1024 * 1024 - 2000) }) });
    expect(installTutorial({ source: src(), dataRoot }).files).toContain('guide.json');
  });

  it('refuses a bad guide in a recording folder, naming the chapters from toc.json', () => {
    recording(JSON.stringify({ sections: [{ ...GUIDE.sections[0], chapter: 5 }] }));
    expect(() => installTutorial({ source: src(), dataRoot, id: 'guided', title: 'Guided' })).toThrow(/chapter 5.*2 chapters/);
    expect(fs.existsSync(dest('guided'))).toBe(false);
  });

  it('keeps an installed tutorial untouched when --force is given with a bad guide', () => {
    folder();
    installTutorial({ source: src(), dataRoot });
    write('guide.json', '{ nope');
    expect(() => installTutorial({ source: src(), dataRoot, force: true })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(dest('guided'), 'guide.json'), 'utf8')).toBe(guideText);
  });
});

describe('installTutorial with a light version of the recording', () => {
  const read = (id: string, name: string) => fs.readFileSync(path.join(dest(id), name), 'utf8');
  const manifestOf = (id: string) => JSON.parse(read(id, 'tutorial.json'));
  const pairedFolder = () => {
    write('chapters/toc.json', JSON.stringify(TOC));
    write('tour.mp4', 'DARK-BYTES');
    write('tour-light.mp4', 'LIGHT-BYTES');
    write('tour.vtt', 'WEBVTT\n');
  };

  it('pairs <stem>.mp4 with <stem>-light.mp4 instead of calling them two videos, and copies both as-is', () => {
    pairedFolder();
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed' });
    expect(manifestOf('themed')).toMatchObject({ video: 'tour.mp4', videoLight: 'tour-light.mp4' });
    expect(read('themed', 'tour.mp4')).toBe('DARK-BYTES');
    expect(read('themed', 'tour-light.mp4')).toBe('LIGHT-BYTES');
    expect(fs.readdirSync(dest('themed')).sort()).toEqual(['tour-light.mp4', 'tour.mp4', 'tour.vtt', 'tutorial.json']);
  });

  it('is picked up by the Tutorials listing with the light video and no warning', () => {
    pairedFolder();
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed' });
    const listed = listTutorials(dataRoot);
    expect(listed.tutorials[0]?.warnings).toEqual([]);
    expect(listed.tutorials[0]?.parts[0]?.videoLight).toMatchObject({ file: 'tour-light.mp4', bytes: 'LIGHT-BYTES'.length });
  });

  it('pairs poster-light.jpg, .jpeg or .png with poster.jpg as posterLight and copies it as-is', () => {
    pairedFolder();
    write('poster.jpg', 'DARK-POSTER');
    write('poster-light.png', 'LIGHT-POSTER');
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed' });
    expect(manifestOf('themed')).toMatchObject({ poster: 'poster.jpg', posterLight: 'poster-light.png' });
    expect(read('themed', 'poster-light.png')).toBe('LIGHT-POSTER');
  });

  it('adds no videoLight or posterLight when the folder has none', () => {
    recordingFolder();
    installTutorial({ source: src(), dataRoot, id: 'plain', title: 'Plain' });
    expect(manifestOf('plain')).not.toHaveProperty('videoLight');
    expect(manifestOf('plain')).not.toHaveProperty('posterLight');
  });

  it('still refuses an unrelated second .mp4, and does not list the paired light video among the choices', () => {
    pairedFolder();
    write('other.mp4', 'OTHER');
    const attempt = () => installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed' });
    expect(attempt).toThrow(/more than one \.mp4.*other\.mp4, tour\.mp4.*--video/);
    expect(attempt).not.toThrow(/tour-light\.mp4/);
    expect(fs.existsSync(dest('themed'))).toBe(false);
  });

  it('with --video, picks that video and its own -light partner', () => {
    pairedFolder();
    write('other.mp4', 'OTHER');
    write('other-light.mp4', 'OTHER-LIGHT');
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed', video: 'other.mp4' });
    expect(manifestOf('themed')).toMatchObject({ video: 'other.mp4', videoLight: 'other-light.mp4' });
    expect(fs.existsSync(path.join(dest('themed'), 'tour.mp4'))).toBe(false);
  });

  it('treats a lone x-light.mp4 with no x.mp4 as the video, not as a light version', () => {
    write('tour-light.mp4', 'ONLY');
    installTutorial({ source: src(), dataRoot, id: 'lone', title: 'Lone' });
    const m = manifestOf('lone');
    expect(m.video).toBe('tour-light.mp4');
    expect(m).not.toHaveProperty('videoLight');
  });

  it('--video-light names the light video explicitly, whatever it is called', () => {
    write('tour.mp4', 'DARK');
    write('night-mode.mp4', 'LIGHT');
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed', videoLight: 'night-mode.mp4' });
    expect(manifestOf('themed')).toMatchObject({ video: 'tour.mp4', videoLight: 'night-mode.mp4' });
    expect(read('themed', 'night-mode.mp4')).toBe('LIGHT');
  });

  it('--video-light wins over a -light file that would have been paired by name', () => {
    pairedFolder();
    write('better.mp4', 'BETTER');
    installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed', video: 'tour.mp4', videoLight: 'better.mp4' });
    expect(manifestOf('themed').videoLight).toBe('better.mp4');
    expect(fs.existsSync(path.join(dest('themed'), 'tour-light.mp4'))).toBe(false);
  });

  it.each([
    ['a file that is not in the folder', 'gone.mp4', /light video file "gone\.mp4" not found in the source folder/],
    ['a path', 'sub/light.mp4', /videoLight/],
    ['a file that is not an mp4', 'light.webm', /videoLight/],
    ['the same file as the video', 'tour.mp4', /videoLight.*different.*video/],
  ])('refuses --video-light with %s and writes nothing', (_label, videoLight, message) => {
    write('tour.mp4', 'DARK');
    expect(() => installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed', video: 'tour.mp4', videoLight })).toThrow(message);
    expect(fs.existsSync(dest('themed'))).toBe(false);
  });

  it('copies the light files a tutorial.json names, as-is, and refuses one that is missing', () => {
    const manifest = { id: 'asis', title: 'As is', video: 'a.mp4', videoLight: 'a-night.mp4', poster: 'p.jpg', posterLight: 'p-night.jpg' };
    write('tutorial.json', JSON.stringify(manifest));
    write('a.mp4', 'D');
    write('a-night.mp4', 'L');
    write('p.jpg', 'PD');
    write('p-night.jpg', 'PL');
    write('stray-light.mp4', 'must not be copied');
    installTutorial({ source: src(), dataRoot, dryRun: true });
    installTutorial({ source: src(), dataRoot });
    expect(fs.readdirSync(dest('asis')).sort()).toEqual(['a-night.mp4', 'a.mp4', 'p-night.jpg', 'p.jpg', 'tutorial.json']);
    fs.rmSync(path.join(src(), 'a-night.mp4'));
    expect(() => installTutorial({ source: src(), dataRoot, force: true })).toThrow(/light video file "a-night\.mp4" not found in the source folder/);
    write('a-night.mp4', 'L');
    fs.rmSync(path.join(src(), 'p-night.jpg'));
    expect(() => installTutorial({ source: src(), dataRoot, force: true })).toThrow(/light poster file "p-night\.jpg" not found in the source folder/);
  });

  it('refuses a tutorial.json whose videoLight is the video itself', () => {
    write('tutorial.json', JSON.stringify({ id: 'same', title: 'Same', video: 'a.mp4', videoLight: 'a.mp4' }));
    write('a.mp4', 'D');
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(/tutorial\.json is invalid.*videoLight.*different/);
  });

  it('refuses --video-light next to a tutorial.json, which is copied as-is', () => {
    write('tutorial.json', JSON.stringify({ id: 'asis', title: 'As is', video: 'a.mp4' }));
    write('a.mp4', 'D');
    write('b.mp4', 'L');
    expect(() => installTutorial({ source: src(), dataRoot, videoLight: 'b.mp4' })).toThrow(/already has tutorial\.json.*--video-light/);
  });

  it('lists the light files in a dry run and writes nothing', () => {
    pairedFolder();
    const r = installTutorial({ source: src(), dataRoot, id: 'themed', title: 'Themed', dryRun: true });
    expect(r.files).toContain('tour-light.mp4');
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });

  it('takes --video-light on the command line', () => {
    write('tour.mp4', 'DARK');
    write('night-mode.mp4', 'LIGHT');
    const r = spawnSync(process.execPath, [SCRIPT, src(), '--data-root', dataRoot, '--id', 'themed', '--video-light', 'night-mode.mp4'], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: '', CC_DATA_ROOT: '' } });
    expect(r.status, r.stderr).toBe(0);
    expect(manifestOf('themed').videoLight).toBe('night-mode.mp4');
    expect(r.stdout).toContain('night-mode.mp4');
  });

  it('asks for a value when --video-light is last', () => {
    const r = spawnSync(process.execPath, [SCRIPT, src(), '--video-light'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--video-light needs a value');
  });
});

// Header-only images: enough bytes for the size check, never decoded.
const u32be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16le = (n: number) => Buffer.from([n & 255, (n >> 8) & 255]);
const u24le = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
const u32le = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
const png = (w: number, h: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), u32be(13), Buffer.from('IHDR'), u32be(w), u32be(h), Buffer.from([8, 2, 0, 0, 0]), Buffer.alloc(4)]);
const gif = (w: number, h: number, sig = 'GIF89a') => Buffer.concat([Buffer.from(sig), u16le(w), u16le(h), Buffer.from([0x80, 0, 0]), Buffer.alloc(12)]);
const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body]);
};
const chunk = (fourcc: string, data: Buffer) => Buffer.concat([Buffer.from(fourcc), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const webpLossy = (w: number, h: number) => riff(chunk('VP8 ', Buffer.concat([Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h), Buffer.alloc(8)])));
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff(chunk('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.alloc(8)])));
};
const webpExtended = (w: number, h: number, animated: boolean) =>
  riff(
    chunk('VP8X', Buffer.concat([Buffer.from([animated ? 0x12 : 0x10, 0, 0, 0]), u24le(w - 1), u24le(h - 1)])),
    ...(animated ? [chunk('ANIM', Buffer.alloc(6)), chunk('ANMF', Buffer.concat([u24le(0), u24le(0), u24le(7), u24le(3), u24le(40), Buffer.from([0]), Buffer.alloc(8)]))] : [chunk('VP8 ', Buffer.concat([Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h), Buffer.alloc(8)]))]),
  );

const u16be = (n: number) => Buffer.from([(n >> 8) & 255, n & 255]);
const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16be(body.length + 2), body]);
/** A JPEG header: SOI, a JFIF APP0, a large EXIF APP1 and a quantization table before the frame header (progressive SOF2 by default). */
const jpeg = (w: number, h: number, sof = 0xc2, exifBytes = 300) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('4a46494600010100000100010000', 'hex')),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(exifBytes)])),
    segment(0xdb, Buffer.alloc(65)),
    segment(sof, Buffer.concat([Buffer.from([8]), u16be(h), u16be(w), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])])),
    Buffer.from([0xff, 0xd9]),
  ]);

describe('imageSize', () => {
  it.each([
    ['a PNG', png(1440, 900), '.png', { width: 1440, height: 900 }],
    ['a PNG with an upper-case extension', png(7, 9), '.PNG', { width: 7, height: 9 }],
    ['a GIF89a', gif(960, 540), '.gif', { width: 960, height: 540 }],
    ['a GIF87a', gif(33, 17, 'GIF87a'), '.gif', { width: 33, height: 17 }],
    ['a lossy WebP (VP8)', webpLossy(1440, 900), '.webp', { width: 1440, height: 900 }],
    ['a lossy WebP with the scale bits set', riff(chunk('VP8 ', Buffer.concat([Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(640 | 0x4000), u16le(360 | 0xc000), Buffer.alloc(8)]))), '.webp', { width: 640, height: 360 }],
    ['a lossless WebP (VP8L)', webpLossless(1440, 900), '.webp', { width: 1440, height: 900 }],
    ['a lossless WebP of 1 by 1', webpLossless(1, 1), '.webp', { width: 1, height: 1 }],
    ['a lossless WebP of the largest size', webpLossless(4096, 4096), '.webp', { width: 4096, height: 4096 }],
    ['a still extended WebP (VP8X)', webpExtended(1440, 900, false), '.webp', { width: 1440, height: 900 }],
    ['an animated WebP (VP8X with ANIM), whose canvas is larger than its first frame', webpExtended(960, 540, true), '.webp', { width: 960, height: 540 }],
    ['an extended WebP with a 24-bit canvas', webpExtended(70000, 3, false), '.webp', { width: 70000, height: 3 }],
    ['a progressive JPEG with APP segments before SOF2', jpeg(1920, 1080), '.jpg', { width: 1920, height: 1080 }],
    ['a baseline JPEG (SOF0) named .jpeg', jpeg(1280, 720, 0xc0), '.jpeg', { width: 1280, height: 720 }],
    ['a JPEG whose APP1 segment is 40 KB', jpeg(640, 360, 0xc2, 40_000), '.JPG', { width: 640, height: 360 }],
  ])('reads the size of %s', (_label, bytes, ext, expected) => {
    expect(imageSize(bytes, ext)).toEqual(expected);
  });

  it.each([
    ['a PNG with a wrong signature', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30)]), '.png', /not a PNG/],
    ['a PNG whose first chunk is not IHDR', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), u32be(13), Buffer.from('PLTE'), Buffer.alloc(20)]), '.png', /not a PNG|IHDR/],
    ['a truncated PNG', png(1, 1).subarray(0, 20), '.png', /too short/],
    ['a GIF with a wrong signature', png(2, 2), '.gif', /not a GIF/],
    ['a truncated GIF', gif(2, 2).subarray(0, 8), '.gif', /too short/],
    ['a WebP with a wrong signature', png(2, 2), '.webp', /not a WebP/],
    ['a RIFF file that is not WebP', Buffer.concat([Buffer.from('RIFF'), u32le(30), Buffer.from('WAVE'), Buffer.alloc(30)]), '.webp', /not a WebP/],
    ['a truncated WebP', webpLossy(2, 2).subarray(0, 24), '.webp', /too short/],
    ['a WebP whose first chunk is unknown', riff(chunk('ABCD', Buffer.alloc(20))), '.webp', /ABCD/],
    ['a lossy WebP without the VP8 start code', riff(chunk('VP8 ', Buffer.alloc(20))), '.webp', /start code/],
    ['a lossless WebP without the VP8L signature', riff(chunk('VP8L', Buffer.alloc(20))), '.webp', /VP8L/],
    ['a .jpg that is really a PNG', png(2, 2), '.jpg', /is not a JPEG file/],
    ['a JPEG segment with a bad length', Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]), '.jpg', /not a valid JPEG file.*length/],
    ['a JPEG whose image data starts before any frame header', Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.alloc(10))]), '.jpg', /no frame header/],
    ['a JPEG cut off before its frame header', jpeg(10, 10).subarray(0, 40), '.jpg', /ends before its frame header/],
    ['a file type it does not know', Buffer.alloc(40), '.bmp', /cannot check.*\.bmp/],
  ])('refuses %s', (_label, bytes, ext, message) => {
    expect(() => imageSize(bytes, ext)).toThrow(message);
  });
});

describe('installTutorial with a documentation guide (version 2)', () => {
  const clip = { type: 'media', kind: 'gif', file: 'clip.dark.gif', fileLight: 'clip.light.gif', poster: 'clip.dark.png', posterLight: 'clip.light.png', alt: 'A clip.', width: 960, height: 540 };
  const image = { type: 'media', kind: 'image', file: 'shot.dark.webp', fileLight: 'shot.light.webp', alt: 'A shot.', caption: 'Shot.', width: 1440, height: 900 };
  const V2 = {
    version: 2,
    sections: [{ id: 'start', title: 'Start', summary: 'First.', subsections: [{ id: 'launch', title: 'Launch', summary: 'Go.', route: '/today', chapter: 1, blocks: [{ type: 'text', text: 'Hi.' }, image, clip] }] }],
  };
  const manifest = { id: 'docs', title: 'Docs', video: 'tour.mp4', guide: 'guide.json', chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 20 }] };
  const MEDIA: Record<string, Buffer> = {
    'shot.dark.webp': webpLossy(1440, 900),
    'shot.light.webp': webpLossless(1440, 900),
    'clip.dark.gif': gif(960, 540),
    'clip.light.gif': gif(960, 540),
    'clip.dark.png': png(960, 540),
    'clip.light.png': png(960, 540),
  };
  const guideText = JSON.stringify(V2, null, 2) + '\n';
  const put = (media: Record<string, Buffer>, base: string) => {
    for (const [name, bytes] of Object.entries(media)) write(name, bytes, base);
    write('unreferenced.png', 'must not be copied', base);
  };
  const folder = (over: { guide?: string | null; media?: Record<string, Buffer> } = {}) => {
    write('tutorial.json', JSON.stringify(manifest));
    write('tour.mp4', 'V');
    if (over.guide !== null) write('guide.json', over.guide ?? guideText);
    put(over.media ?? MEDIA, src());
  };
  const recording = (over: { guide?: string; media?: Record<string, Buffer> } = {}) => {
    write('chapters/toc.json', JSON.stringify(TOC));
    write('tour.mp4', 'V');
    write('guide/guide.json', over.guide ?? guideText);
    put(over.media ?? MEDIA, path.join(src(), 'guide'));
  };
  const installed = ['clip.dark.gif', 'clip.dark.png', 'clip.light.gif', 'clip.light.png', 'guide.json', 'shot.dark.webp', 'shot.light.webp', 'tour.mp4', 'tutorial.json'];
  const noTutorial = () => expect(fs.existsSync(path.join(dataRoot, 'data', 'control-center', 'tutorials', 'docs'))).toBe(false);
  const withMedia = (name: string, bytes: Buffer) => ({ ...MEDIA, [name]: bytes });
  const withoutMedia = (name: string) => Object.fromEntries(Object.entries(MEDIA).filter(([n]) => n !== name));

  it('copies guide.json byte for byte with the dark and light image, clip and poster files it names, and nothing else', () => {
    folder();
    const r = installTutorial({ source: src(), dataRoot });
    expect(r.files.sort()).toEqual(installed);
    expect(fs.readdirSync(dest('docs')).sort()).toEqual(installed);
    expect(fs.readFileSync(path.join(dest('docs'), 'guide.json'), 'utf8')).toBe(guideText);
    expect(fs.readFileSync(path.join(dest('docs'), 'shot.light.webp')).equals(MEDIA['shot.light.webp']!)).toBe(true);
  });

  it('is picked up by the Tutorials listing with the documentation view and no warning', () => {
    folder();
    installTutorial({ source: src(), dataRoot });
    const { tutorials, warnings } = listTutorials(dataRoot);
    expect(warnings).toEqual([]);
    expect(tutorials[0]?.warnings).toEqual([]);
    expect(tutorials[0]?.guideDocs).toMatchObject({ version: 2, legacy: false });
    expect(tutorials[0]?.guide).toBeNull();
  });

  it('builds the manifest from a recording folder whose guide/ holds a version 2 guide and its media', () => {
    recording();
    installTutorial({ source: src(), dataRoot, id: 'docs', title: 'Docs' });
    expect(fs.readdirSync(dest('docs')).sort()).toEqual(installed);
    expect(listTutorials(dataRoot).tutorials[0]?.guideDocs?.version).toBe(2);
  });

  it('lists the media in a dry run and writes nothing', () => {
    folder();
    expect(installTutorial({ source: src(), dataRoot, dryRun: true }).files.sort()).toEqual(installed);
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });

  it('lets two blocks share one poster and copies it once', () => {
    const shared = { ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [clip, { ...clip, file: 'other.dark.gif', fileLight: 'other.light.gif' }] }] }] };
    folder({ guide: JSON.stringify(shared), media: { ...MEDIA, 'other.dark.gif': gif(960, 540), 'other.light.gif': gif(960, 540) } });
    installTutorial({ source: src(), dataRoot });
    expect(fs.readdirSync(dest('docs')).filter((n) => n === 'clip.dark.png')).toHaveLength(1);
  });

  it.each([
    ['a light image that is not in the folder', () => ({ media: withoutMedia('shot.light.webp') }), /guide light image file "shot\.light\.webp" not found in the source folder/],
    ['a dark image that is not in the folder', () => ({ media: withoutMedia('shot.dark.webp') }), /guide image file "shot\.dark\.webp" not found in the source folder/],
    ['a light clip that is not in the folder', () => ({ media: withoutMedia('clip.light.gif') }), /guide light gif file "clip\.light\.gif" not found in the source folder/],
    ['a light poster that is not in the folder', () => ({ media: withoutMedia('clip.light.png') }), /guide light poster file "clip\.light\.png" not found in the source folder/],
    ['a poster that is not in the folder', () => ({ media: withoutMedia('clip.dark.png') }), /guide poster file "clip\.dark\.png" not found in the source folder/],
    ['an image without fileLight', () => ({ guide: JSON.stringify({ ...V2, sections: [{ ...V2.sections[0], subsections: [{ ...V2.sections[0]!.subsections[0], blocks: [{ ...image, fileLight: undefined }] }] }] }) }), /guide\.json is invalid.*blocks\.0\.fileLight/],
    ['a clip without a poster', () => ({ guide: JSON.stringify({ ...V2, sections: [{ ...V2.sections[0], subsections: [{ ...V2.sections[0]!.subsections[0], blocks: [{ ...clip, poster: undefined }] }] }] }) }), /guide\.json is invalid.*blocks\.0\.poster/],
    ['a duplicate subsection id', () => ({ guide: JSON.stringify({ ...V2, sections: [{ ...V2.sections[0], subsections: [V2.sections[0]!.subsections[0], V2.sections[0]!.subsections[0]] }] }) }), /duplicate subsection id "launch"/],
    ['a chapter the tutorial does not have', () => ({ guide: JSON.stringify({ ...V2, sections: [{ ...V2.sections[0], subsections: [{ ...V2.sections[0]!.subsections[0], chapter: 2 }] }] }) }), /chapter 2.*2 chapters/],
    ['an unknown key', () => ({ guide: JSON.stringify({ ...V2, extra: true }) }), /guide\.json is invalid.*extra/],
    ['an unsupported version', () => ({ guide: JSON.stringify({ ...V2, version: 3 }) }), /guide\.json is invalid.*version/],
  ])('refuses %s and writes nothing', (_label, make, message) => {
    folder(make());
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(message);
    noTutorial();
  });

  it('refuses a version 2 guide.json over the cap, and accepts one of exactly MAX_GUIDE_BYTES', () => {
    const exact = JSON.stringify(V2) + ' '.repeat(MAX_GUIDE_BYTES - JSON.stringify(V2).length);
    expect(Buffer.byteLength(exact)).toBe(MAX_GUIDE_BYTES);
    folder({ guide: exact });
    expect(installTutorial({ source: src(), dataRoot, dryRun: true }).files).toContain('guide.json');
    write('guide.json', exact + ' ');
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(/guide\.json is too large.*1 MB/);
    noTutorial();
  });

  it('refuses a guide light poster that would overwrite a different file of the tutorial', () => {
    recording({ media: { ...MEDIA, 'poster-light.jpg': png(1, 1) } });
    write('poster-light.jpg', 'TUTORIAL-LIGHT-POSTER');
    write('guide/guide.json', JSON.stringify({ ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [{ ...clip, posterLight: 'poster-light.jpg' }] }] }] }));
    expect(() => installTutorial({ source: src(), dataRoot, id: 'docs', title: 'Docs' })).toThrow(/poster-light\.jpg.*both/);
    noTutorial();
  });

  describe('--strict-dims', () => {
    const strict = () => installTutorial({ source: src(), dataRoot, strictDims: true });

    it('passes when every file of every block has the declared size: PNG, GIF, lossy, lossless and animated WebP', () => {
      const animated = { ...image, file: 'anim.dark.webp', fileLight: 'anim.light.webp', width: 960, height: 540 };
      const guide = { ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [image, clip, animated] }] }] };
      folder({ guide: JSON.stringify(guide), media: { ...MEDIA, 'anim.dark.webp': webpExtended(960, 540, true), 'anim.light.webp': webpExtended(960, 540, true) } });
      expect(strict().files).toContain('anim.light.webp');
    });

    it.each([
      ['a dark image', 'shot.dark.webp', webpLossy(1440, 901), /guide image file "shot\.dark\.webp" is 1440x901 but guide\.json declares 1440x900/],
      ['a light image', 'shot.light.webp', webpLossless(1280, 900), /guide light image file "shot\.light\.webp" is 1280x900 but guide\.json declares 1440x900/],
      ['a dark clip', 'clip.dark.gif', gif(480, 270), /guide gif file "clip\.dark\.gif" is 480x270 but guide\.json declares 960x540/],
      ['a light clip', 'clip.light.gif', gif(960, 541), /guide light gif file "clip\.light\.gif" is 960x541 but guide\.json declares 960x540/],
      ['a poster', 'clip.dark.png', png(960, 100), /guide poster file "clip\.dark\.png" is 960x100 but guide\.json declares 960x540/],
      ['a light poster', 'clip.light.png', png(1, 540), /guide light poster file "clip\.light\.png" is 1x540 but guide\.json declares 960x540/],
    ])('refuses %s whose size differs from the declared one and writes nothing', (_label, name, bytes, message) => {
      folder({ media: withMedia(name, bytes) });
      expect(strict).toThrow(message);
      noTutorial();
    });

    it('refuses an animated WebP clip whose canvas differs from the declared size', () => {
      const guide = { ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [{ ...clip, file: 'clip.dark.webp', fileLight: 'clip.light.webp' }] }] }] };
      folder({ guide: JSON.stringify(guide), media: { ...MEDIA, 'clip.dark.webp': webpExtended(960, 500, true), 'clip.light.webp': webpExtended(960, 540, true) } });
      expect(strict).toThrow(/guide gif file "clip\.dark\.webp" is 960x500 but guide\.json declares 960x540/);
      noTutorial();
    });

    it('names the subsection of the block that disagrees', () => {
      folder({ media: withMedia('shot.dark.webp', webpLossy(10, 10)) });
      expect(strict).toThrow(/subsection "launch"/);
    });

    it.each([
      ['a PNG that is really a GIF', 'clip.dark.png', gif(960, 540), /guide poster file "clip\.dark\.png" is not a PNG/],
      ['a WebP that is not a WebP', 'shot.dark.webp', Buffer.from('not an image at all, just text padding'), /guide image file "shot\.dark\.webp" is not a WebP/],
      ['a truncated GIF', 'clip.light.gif', Buffer.from('GIF89a'), /guide light gif file "clip\.light\.gif" is too short/],
    ])('refuses %s', (_label, name, bytes, message) => {
      folder({ media: withMedia(name, bytes) });
      expect(strict).toThrow(message);
      noTutorial();
    });

    it('refuses a .jpg it cannot read a size from rather than skipping it silently', () => {
      const guide = { ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [{ ...image, file: 'shot.dark.jpg' }] }] }] };
      folder({ guide: JSON.stringify(guide), media: { ...MEDIA, 'shot.dark.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
      expect(strict).toThrow(/guide image file "shot\.dark\.jpg" has no frame header/);
      expect(() => installTutorial({ source: src(), dataRoot })).not.toThrow();
    });

    it('checks a .jpg image against the declared size', () => {
      const guide = { ...V2, sections: [{ ...V2.sections[0]!, subsections: [{ ...V2.sections[0]!.subsections[0]!, blocks: [{ ...image, file: 'shot.dark.jpg' }] }] }] };
      folder({ guide: JSON.stringify(guide), media: { ...MEDIA, 'shot.dark.jpg': jpeg(1440, 900) } });
      expect(strict().files).toContain('shot.dark.jpg');
    });

    it('is not applied without the flag: a mismatched and an unreadable image are copied', () => {
      folder({ media: { ...withMedia('shot.dark.webp', webpLossy(1, 1)), 'clip.dark.png': Buffer.from('junk') } });
      expect(() => installTutorial({ source: src(), dataRoot })).not.toThrow();
    });

    it('also checks a recording folder, reading the media from guide/', () => {
      recording({ media: withMedia('clip.light.png', png(1, 1)) });
      expect(() => installTutorial({ source: src(), dataRoot, id: 'docs', title: 'Docs', strictDims: true })).toThrow(/light poster file "clip\.light\.png" is 1x1/);
    });

    it('is a no-op for a legacy guide, which declares no sizes, and for a tutorial with no guide', () => {
      write('tutorial.json', JSON.stringify({ id: 'old', title: 'Old', video: 'tour.mp4', guide: 'guide.json', chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 5 }] }));
      write('tour.mp4', 'V');
      write('guide.json', JSON.stringify(GUIDE));
      write('today.gif', 'not an image');
      write('today.jpg', 'x');
      write('tracker.webp', 'not an image');
      expect(strict().files).toContain('today.gif');
      fs.rmSync(path.join(src(), 'guide.json'));
      write('tutorial.json', JSON.stringify({ id: 'none', title: 'None', video: 'tour.mp4' }));
      expect(strict().id).toBe('none');
    });

    it('is checked before a dry run reports success', () => {
      folder({ media: withMedia('shot.dark.webp', webpLossy(2, 2)) });
      expect(() => installTutorial({ source: src(), dataRoot, strictDims: true, dryRun: true })).toThrow(/is 2x2/);
    });

    it('takes --strict-dims on the command line and exits 1 with the reason on a mismatch', () => {
      folder({ media: withMedia('shot.dark.webp', webpLossy(2, 2)) });
      const run = (...extra: string[]) => spawnSync(process.execPath, [SCRIPT, src(), '--data-root', dataRoot, ...extra], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: '', CC_DATA_ROOT: '' } });
      const bad = run('--strict-dims');
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/shot\.dark\.webp" is 2x2 but guide\.json declares 1440x900/);
      expect(run().status).toBe(0);
    });
  });
});

describe('installTutorial with a tutorial in parts', () => {
  const part = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Part ${id}`,
    video: `${id}.mp4`,
    videoLight: `${id}-light.mp4`,
    subtitles: `${id}.vtt`,
    poster: `${id}-poster.jpg`,
    posterLight: `${id}-poster-light.jpg`,
    duration: 263.2,
    chapters: [{ title: `${id} one`, start: 0 }],
    ...over,
  });
  const manifest = {
    id: 'parts-tour',
    title: 'Parts tour',
    transcript: 'script.md',
    guide: 'guide.json',
    parts: [part('start', { chapters: [{ title: 'Intro', start: 0 }, { title: 'Launch', start: 148.734 }] }), part('intel', { duration: 377 })],
  };
  const partFiles = ['intel-light.mp4', 'intel-poster-light.jpg', 'intel-poster.jpg', 'intel.mp4', 'intel.vtt', 'start-light.mp4', 'start-poster-light.jpg', 'start-poster.jpg', 'start.mp4', 'start.vtt'];
  const folder = (over: { manifest?: unknown; skip?: string[]; posters?: Record<string, Buffer> } = {}) => {
    write('tutorial.json', JSON.stringify(over.manifest ?? manifest));
    for (const name of partFiles) {
      if (over.skip?.includes(name)) continue;
      write(name, name.endsWith('.jpg') ? (over.posters?.[name] ?? jpeg(1920, 1080)) : `BYTES ${name}`);
    }
    write('script.md', '# Script\n');
    write('guide.json', JSON.stringify(GUIDE));
    write('today.gif', 'GIF');
    write('today.jpg', 'JPEG');
    write('tracker.webp', 'WEBP');
    write('full-length.mp4', 'superseded single video, must not be copied');
    write('unreferenced.vtt', 'must not be copied');
  };

  it('given a parts folder, when installed, then exactly the part files, the transcript and the guide set are copied', () => {
    folder();
    const r = installTutorial({ source: src(), dataRoot });
    const expected = [...partFiles, 'guide.json', 'script.md', 'today.gif', 'today.jpg', 'tracker.webp', 'tutorial.json'].sort();
    expect(r.files.sort()).toEqual(expected);
    expect(fs.readdirSync(dest('parts-tour')).sort()).toEqual(expected);
    expect(fs.readFileSync(path.join(dest('parts-tour'), 'intel-light.mp4'), 'utf8')).toBe('BYTES intel-light.mp4');
  });

  it("given a part's light video is missing, when installed, then the error names the part and writes nothing", () => {
    folder({ skip: ['intel-light.mp4'] });
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(/part "intel" light video file "intel-light\.mp4" not found in the source folder/);
    expect(fs.existsSync(dest('parts-tour'))).toBe(false);
  });

  it('given --strict-dims and posters of 1920x1080 (dark) and 1280x720 (light), when installed, then the error names both files', () => {
    folder({ posters: { 'intel-poster-light.jpg': jpeg(1280, 720) } });
    expect(() => installTutorial({ source: src(), dataRoot, strictDims: true })).toThrow(/part "intel".*"intel-poster\.jpg" is 1920x1080.*"intel-poster-light\.jpg" is 1280x720/);
    expect(fs.existsSync(dest('parts-tour'))).toBe(false);
  });

  it('given --strict-dims and posters of equal size, when installed, then it passes', () => {
    folder();
    expect(installTutorial({ source: src(), dataRoot, strictDims: true, dryRun: true }).files).toContain('intel-poster-light.jpg');
  });

  it('given --strict-dims and a poster that is not a JPEG, when installed, then the error names the part and the file', () => {
    folder({ posters: { 'start-poster.jpg': png(1920, 1080) } });
    expect(() => installTutorial({ source: src(), dataRoot, strictDims: true })).toThrow(/part "start" poster file "start-poster\.jpg" is not a JPEG file/);
  });

  it('checks a guide chapter against the chapters of every part', () => {
    folder({ manifest: { ...manifest, parts: [part('start'), part('intel')] } });
    write('guide.json', JSON.stringify({ sections: [{ ...GUIDE.sections[0], chapter: 2 }] }));
    expect(() => installTutorial({ source: src(), dataRoot })).toThrow(/chapter 2.*2 chapters/);
  });

  it('prints the number of parts and the length of each on the command line', () => {
    folder();
    const r = spawnSync(process.execPath, [SCRIPT, src(), '--data-root', dataRoot, '--dry-run'], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: '', CC_DATA_ROOT: '' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/parts: 2\n/);
    expect(r.stdout).toMatch(/1\. start .*4:23/);
    expect(r.stdout).toMatch(/2\. intel .*6:17/);
  });
});

describe('installTutorial safety', () => {
  it('refuses to replace an installed tutorial without force, and replaces it with force', () => {
    recordingFolder();
    installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'First' });
    expect(() => installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'Second' })).toThrow(/already installed.*--force/);
    expect(JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8')).title).toBe('First');
    installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'Second', force: true });
    expect(JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8')).title).toBe('Second');
    expect(fs.readdirSync(path.join(dataRoot, 'data', 'control-center', 'tutorials')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('keeps the installed tutorial intact when promoting the new one fails with force', () => {
    recordingFolder();
    installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'First' });
    const tutorialsDir = path.dirname(dest('my-tour'));
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === dest('my-tour') && path.basename(String(from)).includes('.tmp-')) throw new Error('disk exploded');
      return realRename(from, to);
    });
    expect(() => installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'Second', force: true })).toThrow(/disk exploded/);
    expect(JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8')).title).toBe('First');
    expect(fs.readFileSync(path.join(dest('my-tour'), 'my-recording.mp4'), 'utf8')).toBe('VIDEO-BYTES');
    expect(fs.readdirSync(tutorialsDir)).toEqual(['my-tour']);
  });

  it('a dry run reports the plan and writes nothing', () => {
    recordingFolder();
    const r = installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'T', dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.files.sort()).toEqual(['my-recording.mp4', 'my-recording.srt', 'script.md', 'tutorial.json']);
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });

  it.each(['../evil', 'a/b', '.hidden', '', 'x'.repeat(65)])('refuses the id %j', (id) => {
    recordingFolder();
    expect(() => installTutorial({ source: src(), dataRoot, id, title: 'T' })).toThrow(/id/);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });

  it('refuses a data root or a source folder that does not exist', () => {
    recordingFolder();
    expect(() => installTutorial({ source: src(), dataRoot: path.join(work, 'nope'), id: 'x', title: 'T' })).toThrow(/data root .* does not exist/);
    expect(() => installTutorial({ source: path.join(work, 'nope'), dataRoot, id: 'x', title: 'T' })).toThrow(/source folder .* does not exist/);
  });
});

describe('install-tutorial command line', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: '', CC_DATA_ROOT: '' } });

  it('installs into --data-root, prints what it did and exits 0', () => {
    recordingFolder();
    const r = run([src(), '--data-root', dataRoot, '--id', 'my-tour', '--title', 'My tour', '--description', 'D']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Installed my-tour');
    expect(r.stdout).toContain(dest('my-tour'));
    expect(JSON.parse(fs.readFileSync(path.join(dest('my-tour'), 'tutorial.json'), 'utf8')).description).toBe('D');
  });

  it('--dry-run prints the plan and writes nothing', () => {
    recordingFolder();
    const r = run([src(), '--data-root', dataRoot, '--id', 'my-tour', '--title', 'T', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Dry run');
    expect(fs.existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });

  it('prints usage and exits 2 without a source, and exits 1 with the reason on a failure', () => {
    const usage = run([]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Usage: node custom/control-center/scripts/install-tutorial.mjs');
    const bad = run([path.join(work, 'nope'), '--data-root', dataRoot]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/source folder .* does not exist/);
    expect(run([src(), '--data-root', dataRoot, '--nope']).status).toBe(2);
  });
});
