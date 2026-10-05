import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

let t: TestApp;
let outside: string;
const SECRET = 'TOP-SECRET-OUTSIDE-THE-TUTORIAL-FOLDER';
// GIF89a header plus trailer: enough bytes to serve and to range over, never decoded by the server.
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from(Array.from({ length: 394 }, (_, i) => i % 251)), Buffer.from([0x3b])]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const tutorialsDir = () => path.join(t.cfg.dataRoot, 'data', 'control-center', 'tutorials');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const v2Image = { type: 'media', kind: 'image', file: 'shot.dark.webp', fileLight: 'shot.light.webp', alt: 'The Today page.', caption: 'Today.', width: 1440, height: 900 };
const v2Clip = { type: 'media', kind: 'gif', file: 'clip.dark.webp', fileLight: 'clip.light.webp', poster: 'clip.dark.png', posterLight: 'clip.light.png', alt: 'A status change.', width: 960, height: 540 };
const v2Sub = (over: Record<string, unknown> = {}) => ({ id: 'launch', title: 'Launch', summary: 'Open the app.', route: '/today', chapter: 1, blocks: [{ type: 'text', text: 'Run it.' }, { type: 'steps', items: ['One.', 'Two.'] }, { type: 'tips', items: ['Tip.'] }, v2Image, v2Clip], ...over });
const v2Guide = (over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) => ({ version: 2, sections: [{ id: 'start', title: 'Getting started', summary: 'First steps.', subsections: [v2Sub(sub)], ...over }] });
const V2_FILES = Object.fromEntries(['shot.dark.webp', 'shot.light.webp', 'clip.dark.webp', 'clip.light.webp', 'clip.dark.png', 'clip.light.png'].map((n) => [n, n.endsWith('.png') ? PNG : GIF]));

const without = (name: string) => Object.fromEntries(Object.entries(V2_FILES).filter(([n]) => n !== name));

const section = (over: Record<string, unknown> = {}) => ({ id: 'today', title: 'Today', summary: 'The daily shortlist.', route: '/today', gif: 'today.gif', poster: 'today.jpg', steps: ['Open Today.', 'Pick a row.'], tips: ['Press j.'], chapter: 1, ...over });

/** A tutorial folder whose tutorial.json names guide.json (when `guide` is not null) and has the gif and poster on disk. */
function writeGuided(id: string, guide: unknown | null, opts: { files?: Record<string, Buffer | string>; manifest?: Record<string, unknown> } = {}) {
  const dir = path.join(tutorialsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  const files = { [`${id}.mp4`]: 'x', 'today.gif': GIF, 'today.jpg': JPG, ...opts.files };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  if (guide !== null) fs.writeFileSync(path.join(dir, 'guide.json'), typeof guide === 'string' ? guide : JSON.stringify(guide));
  const manifest = { id, title: id, video: `${id}.mp4`, chapters: [{ title: 'A', start: 0 }, { title: 'B', start: 10 }], ...(guide === null ? {} : { guide: 'guide.json' }), ...opts.manifest };
  fs.writeFileSync(path.join(dir, 'tutorial.json'), JSON.stringify(manifest));
  return dir;
}

beforeAll(async () => {
  t = await makeTestApp();
  outside = tempDir('cc-guide-outside-');
  fs.writeFileSync(path.join(outside, 'secret.gif'), SECRET);
  fs.writeFileSync(path.join(outside, 'secret-guide.json'), JSON.stringify({ sections: [section()] }));

  writeGuided('good', { sections: [section(), section({ id: 'tracker', title: 'Tracker', route: undefined, poster: undefined, tips: undefined, chapter: undefined, gif: 'tracker.webp' })] }, { files: { 'tracker.webp': GIF } });
  writeGuided('plain', null);
  writeGuided('v2-good', v2Guide(), { files: V2_FILES });
  writeGuided('v2-missing-light', v2Guide(), { files: without('shot.light.webp') });
  writeGuided('v2-missing-poster-light', v2Guide(), { files: without('clip.light.png') });
  writeGuided('v2-missing-dark', v2Guide(), { files: without('clip.dark.webp') });
  writeGuided('v2-light-no-file-key', v2Guide({}, { blocks: [{ ...v2Image, fileLight: undefined }] }), { files: V2_FILES });
  writeGuided('v2-dup-subsection', v2Guide({ subsections: [v2Sub(), v2Sub({ title: 'Again' })] }), { files: V2_FILES });
  writeGuided('v2-unknown-key', v2Guide({ colour: 'red' }), { files: V2_FILES });
  writeGuided('v2-bad-version', { ...v2Guide(), version: 3 }, { files: V2_FILES });
  writeGuided('v2-bad-chapter', v2Guide({}, { chapter: 2 }), { files: V2_FILES });
  const v2Huge = writeGuided('v2-huge', null, { manifest: { guide: 'guide.json' }, files: V2_FILES });
  fs.writeFileSync(path.join(v2Huge, 'guide.json'), JSON.stringify({ ...v2Guide(), pad: 'x'.repeat(2 * 1024 * 1024) }));
  const v2Escape = writeGuided('v2-escape-light', v2Guide(), { files: V2_FILES });
  fs.rmSync(path.join(v2Escape, 'clip.light.webp'));
  fs.symlinkSync(path.join(outside, 'secret.gif'), path.join(v2Escape, 'clip.light.webp'));
  writeGuided('missing-gif', { sections: [section({ gif: 'gone.gif' })] });
  writeGuided('missing-poster', { sections: [section({ poster: 'gone.jpg' })] });
  writeGuided('missing-guide', null, { manifest: { guide: 'guide.json' } });
  writeGuided('bad-ext', { sections: [section({ gif: 'today.mp4' })] });
  writeGuided('bad-route', { sections: [section({ route: '//evil.example' })] });
  writeGuided('dup-ids', { sections: [section(), section({ title: 'Again' })] });
  writeGuided('too-many', { sections: Array.from({ length: 61 }, (_, i) => section({ id: `s${i}` })) });
  writeGuided('bad-chapter', { sections: [section({ chapter: 2 })] });
  writeGuided('bad-json', '{ not json');
  writeGuided('not-an-object', '[]');
  const huge = writeGuided('huge', null, { manifest: { guide: 'guide.json' } });
  fs.writeFileSync(path.join(huge, 'guide.json'), JSON.stringify({ sections: [section()], pad: 'x'.repeat(2 * 1024 * 1024) }));
  const linked = writeGuided('linked-guide', null, { manifest: { guide: 'guide.json' } });
  fs.symlinkSync(path.join(outside, 'secret-guide.json'), path.join(linked, 'guide.json'));
  const escape = writeGuided('escape-gif', { sections: [section({ gif: 'escape.gif' })] });
  fs.symlinkSync(path.join(outside, 'secret.gif'), path.join(escape, 'escape.gif'));
});
afterAll(async () => {
  await t.close();
  fs.rmSync(outside, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers: { ...t.authed, ...headers } });
type Listed = { id: string; guide: unknown; guideDocs: unknown; warnings: string[] };
const listed = async () => ((await get('/api/tutorials')).json().tutorials as Listed[]).reduce<Record<string, Listed>>((acc, x) => ({ ...acc, [x.id]: x }), {});

describe('GET /api/tutorials with a quick guide', () => {
  it('includes the parsed guide with media urls for the gif and the poster', async () => {
    const good = (await listed()).good!;
    expect(good.warnings).toEqual([]);
    expect(good.guide).toEqual({
      sections: [
        {
          id: 'today',
          title: 'Today',
          summary: 'The daily shortlist.',
          route: '/today',
          gif: { file: 'today.gif', url: '/api/tutorials/good/media/today.gif' },
          poster: { file: 'today.jpg', url: '/api/tutorials/good/media/today.jpg' },
          steps: ['Open Today.', 'Pick a row.'],
          tips: ['Press j.'],
          chapter: 1,
        },
        {
          id: 'tracker',
          title: 'Tracker',
          summary: 'The daily shortlist.',
          route: null,
          gif: { file: 'tracker.webp', url: '/api/tutorials/good/media/tracker.webp' },
          poster: null,
          steps: ['Open Today.', 'Pick a row.'],
          tips: [],
          chapter: null,
        },
      ],
    });
  });

  it('has no guide, and no warning, for a tutorial that does not name one', async () => {
    const plain = (await listed()).plain!;
    expect(plain.guide).toBeNull();
    expect(plain.warnings).toEqual([]);
  });

  it.each([
    ['a guide file that is missing', 'missing-guide', /guide.*guide\.json.*not found/],
    ['a gif that is missing', 'missing-gif', /guide.*gif.*gone\.gif.*not found/],
    ['a poster that is missing', 'missing-poster', /guide.*poster.*gone\.jpg.*not found/],
    ['a gif with a bad extension', 'bad-ext', /guide.*sections\.0\.gif/],
    ['a route that is not an app path', 'bad-route', /guide.*sections\.0\.route/],
    ['duplicate section ids', 'dup-ids', /guide.*duplicate.*"today"/],
    ['more than 60 sections', 'too-many', /guide.*sections/],
    ['a chapter the tutorial does not have', 'bad-chapter', /guide.*chapter 2.*2 chapters/],
    ['guide.json that is not valid JSON', 'bad-json', /guide.*not valid JSON/],
    ['guide.json that is not an object', 'not-an-object', /guide.*object/],
    ['a guide.json that is too large', 'huge', /guide.*too large/],
    ['a guide.json that is a symlink out of the folder', 'linked-guide', /guide.*outside the tutorial folder/],
    ['a gif that is a symlink out of the folder', 'escape-gif', /guide.*gif.*escape\.gif.*outside the tutorial folder/],
  ])('keeps the tutorial listed, with no guide and a warning, for %s', async (_label, id, message) => {
    const entry = (await listed())[id!]!;
    expect(entry, `${id} must still be listed`).toBeDefined();
    expect(entry.guide).toBeNull();
    expect(entry.warnings.join('\n')).toMatch(message as RegExp);
  });

  it('does not skip the folder: no invalid guide shows up in the skipped-folders warnings', async () => {
    const { warnings } = (await get('/api/tutorials')).json() as { warnings: Array<{ folder: string }> };
    expect(warnings).toEqual([]);
  });
});

describe('GET /api/tutorials with a version 2 guide', () => {
  it('includes the guide view with dark and light media urls, and hides the legacy quick guide view', async () => {
    const good = (await listed())['v2-good']!;
    expect(good.warnings).toEqual([]);
    expect(good.guide).toBeNull();
    const media = (name: string) => `/api/tutorials/v2-good/media/${name}`;
    expect(good.guideDocs).toEqual({
      version: 2,
      legacy: false,
      sections: [
        {
          id: 'start',
          title: 'Getting started',
          short: 'Getting started',
          summary: 'First steps.',
          subsections: [
            {
              id: 'launch',
              title: 'Launch',
              short: 'Launch',
              summary: 'Open the app.',
              route: '/today',
              chapter: 1,
              blocks: [
                { type: 'text', text: 'Run it.' },
                { type: 'steps', items: ['One.', 'Two.'] },
                { type: 'tips', items: ['Tip.'] },
                { type: 'media', kind: 'image', alt: 'The Today page.', caption: 'Today.', width: 1440, height: 900, url: media('shot.dark.webp'), urlLight: media('shot.light.webp'), posterUrl: null, posterLightUrl: null },
                { type: 'media', kind: 'gif', alt: 'A status change.', caption: null, width: 960, height: 540, url: media('clip.dark.webp'), urlLight: media('clip.light.webp'), posterUrl: media('clip.dark.png'), posterLightUrl: media('clip.light.png') },
              ],
            },
          ],
        },
      ],
    });
  });

  it('serves the light files like any other media', async () => {
    const res = await get('/api/tutorials/v2-good/media/clip.light.webp');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect((await get('/api/tutorials/v2-good/media/clip.light.png')).headers['content-type']).toBe('image/png');
  });

  it('gives a version 1 guide the same view, adapted: one subsection per section, no light variant, legacy flag set', async () => {
    const good = (await listed()).good! as unknown as { guideDocs: { version: number; legacy: boolean; sections: Array<{ id: string; subsections: Array<{ route: string | null; chapter: number | null; blocks: Array<Record<string, unknown>> }> }> } };
    expect(good.guideDocs.version).toBe(1);
    expect(good.guideDocs.legacy).toBe(true);
    expect(good.guideDocs.sections.map((x) => [x.id, x.subsections.length])).toEqual([['today', 1], ['tracker', 1]]);
    const today = good.guideDocs.sections[0]!.subsections[0]!;
    expect(today).toMatchObject({ route: '/today', chapter: 1 });
    expect(today.blocks.map((b) => b.type)).toEqual(['text', 'media', 'steps', 'tips']);
    expect(today.blocks[1]).toEqual({ type: 'media', kind: 'gif', alt: 'Today', caption: null, width: null, height: null, url: '/api/tutorials/good/media/today.gif', urlLight: null, posterUrl: '/api/tutorials/good/media/today.jpg', posterLightUrl: null });
    const tracker = good.guideDocs.sections[1]!.subsections[0]!;
    expect(tracker.blocks[1]).toMatchObject({ url: '/api/tutorials/good/media/tracker.webp', posterUrl: null });
    expect(tracker.blocks.map((b) => b.type)).toEqual(['text', 'media', 'steps']);
  });

  it('has no guide view at all for a tutorial that does not name one', async () => {
    expect((await listed()).plain!.guideDocs).toBeNull();
  });

  it.each([
    ['a light image that is missing', 'v2-missing-light', /guide.*light image file "shot\.light\.webp" not found/],
    ['a light poster that is missing', 'v2-missing-poster-light', /guide.*light poster file "clip\.light\.png" not found/],
    ['a dark clip that is missing', 'v2-missing-dark', /guide.*gif file "clip\.dark\.webp" not found/],
    ['a light clip that is a symlink out of the folder', 'v2-escape-light', /guide.*light gif file "clip\.light\.webp" is outside the tutorial folder/],
    ['an image with no fileLight', 'v2-light-no-file-key', /guide.*blocks\.0\.fileLight/],
    ['a duplicate subsection id', 'v2-dup-subsection', /guide.*duplicate subsection id "launch"/],
    ['an unknown key', 'v2-unknown-key', /guide.*colour/],
    ['an unsupported version', 'v2-bad-version', /guide.*version.*3/],
    ['a chapter the tutorial does not have', 'v2-bad-chapter', /guide.*chapter 2.*2 chapters/],
    ['a guide.json that is too large', 'v2-huge', /guide.*too large/],
  ])('keeps the tutorial listed, with no guide of either kind and a warning, for %s', async (_label, id, message) => {
    const entry = (await listed())[id!]!;
    expect(entry, `${id} must still be listed`).toBeDefined();
    expect(entry.guide).toBeNull();
    expect(entry.guideDocs).toBeNull();
    expect(entry.warnings.join('\n')).toMatch(message as RegExp);
    expect(entry.warnings.join('\n')).toMatch(/quick guide is hidden/);
  });

  it('gives a version 1 guide that is invalid no view either', async () => {
    const entry = (await listed())['missing-gif']!;
    expect(entry.guideDocs).toBeNull();
  });
});

describe('guide media', () => {
  it('serves a gif with its type, size and range support', async () => {
    const res = await get('/api/tutorials/good/media/today.gif');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(GIF.length));
    expect(res.rawPayload.equals(GIF)).toBe(true);
  });

  it('answers a range request on a gif with 206 and the matching bytes', async () => {
    const res = await get('/api/tutorials/good/media/today.gif', { range: 'bytes=0-5' });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-5/${GIF.length}`);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.body).toBe('GIF89a');
  });

  it('serves a webp with its type', async () => {
    const res = await get('/api/tutorials/good/media/tracker.webp');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
  });

  it('refuses a gif that is a symlink out of the tutorial folder', async () => {
    const res = await get('/api/tutorials/escape-gif/media/escape.gif');
    expect([400, 403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(SECRET);
  });

  it('still refuses to serve guide.json itself', async () => {
    expect([403, 404, 415]).toContain((await get('/api/tutorials/good/media/guide.json')).statusCode);
  });
});
