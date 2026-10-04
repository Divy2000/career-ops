import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
let outside: string;
const SECRET = 'TOP-SECRET-OUTSIDE-THE-TUTORIAL-FOLDER';
// GIF89a header plus trailer: enough bytes to serve and to range over, never decoded by the server.
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from(Array.from({ length: 394 }, (_, i) => i % 251)), Buffer.from([0x3b])]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const tutorialsDir = () => path.join(t.cfg.dataRoot, 'data', 'control-center', 'tutorials');

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
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-guide-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.gif'), SECRET);
  fs.writeFileSync(path.join(outside, 'secret-guide.json'), JSON.stringify({ sections: [section()] }));

  writeGuided('good', { sections: [section(), section({ id: 'tracker', title: 'Tracker', route: undefined, poster: undefined, tips: undefined, chapter: undefined, gif: 'tracker.webp' })] }, { files: { 'tracker.webp': GIF } });
  writeGuided('plain', null);
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
type Listed = { id: string; guide: unknown; warnings: string[] };
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
