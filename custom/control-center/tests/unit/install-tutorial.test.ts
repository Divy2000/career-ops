import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installTutorial } from '../../scripts/install-tutorial.mjs';
import { parseManifest } from '../../server/domains/tutorials.js';
import { listTutorials } from '../../server/domains/tutorials.js';
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
    expect(listed.tutorials.map((t) => [t.id, t.chapters.length, t.subtitles?.format])).toEqual([['my-tour', 2, 'srt']]);
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
    expect(installTutorial({ source: src(), dataRoot, id: 'my-tour', title: 'T', video: 'other.mp4' }).manifest.video).toBe('other.mp4');
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
