import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
let outside: string;
const SECRET = 'TOP-SECRET-OUTSIDE-THE-TUTORIAL-FOLDER';
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const SRT = '1\n00:00:04,962 --> 00:00:09,880\nHello, world.\n\n2\n00:00:10,000 --> 00:00:12,000\nSecond cue.\n';
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlready vtt\n';
const tutorialsDir = () => path.join(t.cfg.dataRoot, 'data', 'control-center', 'tutorials');

function writeTutorial(folder: string, manifest: unknown, files: Record<string, Buffer | string> = {}) {
  const dir = path.join(tutorialsDir(), folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  fs.writeFileSync(path.join(dir, 'tutorial.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}

beforeAll(async () => {
  t = await makeTestApp();
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tut-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.mp4'), SECRET);
  fs.mkdirSync(path.join(outside, 'linked-tutorial'));
  fs.writeFileSync(path.join(outside, 'linked-tutorial', 'a.mp4'), SECRET);
  fs.writeFileSync(path.join(outside, 'linked-tutorial', 'tutorial.json'), JSON.stringify({ id: 'linked', title: 'Linked', video: 'a.mp4' }));

  const demo = writeTutorial(
    'demo',
    { id: 'demo', title: 'Demo tutorial', description: 'Walks through the app.', video: 'demo.mp4', subtitles: 'demo.srt', poster: 'poster.jpg', transcript: 'script.md', chapters: [{ title: 'Second', start: 30 }, { title: 'First', start: 0 }] },
    { 'demo.mp4': VIDEO, 'demo.srt': SRT, 'poster.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'script.md': '# Script\n\nHello.\n' },
  );
  fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(demo, 'escape.mp4'));
  fs.symlinkSync(outside, path.join(demo, 'escape-dir'));
  writeTutorial('vtt-only', { id: 'vtt-only', title: 'VTT tutorial', video: 'v.mp4', subtitles: 'v.vtt' }, { 'v.mp4': VIDEO.subarray(0, 10), 'v.vtt': VTT });
  writeTutorial('bad-json', '{ not json', {});
  writeTutorial('bad-schema', { id: 'bad-schema', video: 'a.mp4' }, { 'a.mp4': 'x' });
  writeTutorial('no-video', { id: 'no-video', title: 'No video', video: 'missing.mp4' }, {});
  writeTutorial('evil-ref', { id: 'evil-ref', title: 'Evil', video: '../demo/demo.mp4' }, {});
  writeTutorial('symlink-video', { id: 'symlink-video', title: 'Symlinked video', video: 'escape.mp4' }, {});
  fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(tutorialsDir(), 'symlink-video', 'escape.mp4'));
  writeTutorial('missing-extras', { id: 'missing-extras', title: 'Missing extras', video: 'm.mp4', poster: 'nope.jpg', transcript: 'nope.md', subtitles: 'nope.vtt' }, { 'm.mp4': 'x' });
  fs.mkdirSync(path.join(tutorialsDir(), 'empty-folder'));
  fs.writeFileSync(path.join(tutorialsDir(), '.DS_Store'), 'x');
  fs.symlinkSync(path.join(outside, 'linked-tutorial'), path.join(tutorialsDir(), 'linked'));
});
afterAll(async () => {
  await t.close();
  fs.rmSync(outside, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers: { ...t.authed, ...headers } });
const media = (id: string, file: string, headers: Record<string, string> = {}) => get(`/api/tutorials/${id}/media/${file}`, headers);

describe('GET /api/tutorials', () => {
  it('lists valid tutorials with media urls, sorted chapters and the data directory', async () => {
    const body = (await get('/api/tutorials')).json();
    expect(body.directory).toBe(tutorialsDir());
    const ids = body.tutorials.map((x: { id: string }) => x.id);
    expect(ids).toEqual(['demo', 'missing-extras', 'vtt-only']);
    const demo = body.tutorials[0];
    expect(demo).toMatchObject({
      id: 'demo',
      title: 'Demo tutorial',
      description: 'Walks through the app.',
      video: { url: '/api/tutorials/demo/media/demo.mp4', bytes: 1000 },
      subtitles: { url: '/api/tutorials/demo/media/demo.srt' },
      poster: { url: '/api/tutorials/demo/media/poster.jpg' },
      transcript: { url: '/api/tutorials/demo/media/script.md' },
      chapters: [{ title: 'First', start: 0 }, { title: 'Second', start: 30 }],
      warnings: [],
    });
  });

  it('skips invalid tutorials with a visible warning that names the folder and the reason', async () => {
    const { warnings } = (await get('/api/tutorials')).json() as { warnings: Array<{ folder: string; message: string }> };
    const byFolder = Object.fromEntries(warnings.map((w) => [w.folder, w.message]));
    expect(byFolder['bad-json']).toMatch(/not valid JSON/);
    expect(byFolder['bad-schema']).toMatch(/title/);
    expect(byFolder['no-video']).toMatch(/video file .*missing\.mp4.* not found/);
    expect(byFolder['evil-ref']).toMatch(/video/);
    expect(byFolder['symlink-video']).toMatch(/outside the tutorial folder/);
    expect(byFolder['empty-folder']).toMatch(/no tutorial\.json/);
    expect(byFolder['linked']).toMatch(/outside the tutorials folder/);
    expect(Object.keys(byFolder)).not.toContain('.DS_Store');
  });

  it('keeps a tutorial whose optional files are missing and says which were dropped', async () => {
    const entry = (await get('/api/tutorials')).json().tutorials.find((x: { id: string }) => x.id === 'missing-extras');
    expect(entry.poster).toBeNull();
    expect(entry.transcript).toBeNull();
    expect(entry.subtitles).toBeNull();
    expect(entry.warnings).toHaveLength(3);
    expect(entry.warnings.join(' ')).toMatch(/poster.*nope\.jpg/);
  });

  it('returns an empty list, with no warning, when the folder does not exist', async () => {
    const t2 = await makeTestApp();
    const body = (await t2.app.inject({ method: 'GET', url: '/api/tutorials', headers: t2.authed })).json();
    expect(body).toEqual({ directory: path.join(t2.cfg.dataRoot, 'data', 'control-center', 'tutorials'), tutorials: [], warnings: [] });
    await t2.close();
  });

  it('requires the session cookie', async () => {
    expect([401, 403]).toContain((await t.app.inject({ method: 'GET', url: '/api/tutorials', headers: { host: t.authed.host } })).statusCode);
    expect([401, 403]).toContain((await t.app.inject({ method: 'GET', url: '/api/tutorials/demo/media/demo.mp4', headers: { host: t.authed.host } })).statusCode);
  });
});

describe('GET /api/tutorials/:id/media/:file', () => {
  it('serves the whole file with range support advertised and the right type', async () => {
    const res = await media('demo', 'demo.mp4');
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('1000');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload.equals(VIDEO)).toBe(true);
  });

  it.each([
    ['a start range', 'bytes=0-99', 0, 99],
    ['a middle range', 'bytes=500-599', 500, 599],
    ['an open-ended range', 'bytes=900-', 900, 999],
    ['a suffix range', 'bytes=-100', 900, 999],
    ['a range whose end is past the file', 'bytes=990-5000', 990, 999],
  ])('answers %s with 206 and the matching bytes', async (_label, header, start, end) => {
    const res = await media('demo', 'demo.mp4', { range: header });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/1000`);
    expect(res.headers['content-length']).toBe(String(end - start + 1));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.rawPayload.equals(VIDEO.subarray(start, end + 1))).toBe(true);
  });

  it.each(['bytes=1000-', 'bytes=2000-3000', 'bytes=5-2', 'bytes=abc', 'bytes=0-1,5-6'])('answers the invalid range %s with 416 and the file size', async (header) => {
    const res = await media('demo', 'demo.mp4', { range: header });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1000');
  });

  it('ignores a range in another unit and serves the whole file', async () => {
    const res = await media('demo', 'demo.mp4', { range: 'items=0-1' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(1000);
  });

  it('serves a HEAD request with headers and no body', async () => {
    const res = await t.app.inject({ method: 'HEAD', url: '/api/tutorials/demo/media/demo.mp4', headers: t.authed });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe('1000');
    expect(res.rawPayload.length).toBe(0);
  });

  it('serves vtt as-is, markdown and the jpeg poster with their types', async () => {
    const vtt = await media('vtt-only', 'v.vtt');
    expect(vtt.headers['content-type']).toMatch(/^text\/vtt/);
    expect(vtt.body).toBe(VTT);
    expect((await media('demo', 'script.md')).headers['content-type']).toMatch(/^text\/markdown/);
    const poster = await media('demo', 'poster.jpg');
    expect(poster.headers['content-type']).toBe('image/jpeg');
    expect(poster.rawPayload.length).toBe(4);
  });

  it('converts an srt to WebVTT on the fly', async () => {
    const res = await media('demo', 'demo.srt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/vtt/);
    expect(res.body).toBe('WEBVTT\n\n00:00:04.962 --> 00:00:09.880\nHello, world.\n\n00:00:10.000 --> 00:00:12.000\nSecond cue.\n');
    expect(fs.readFileSync(path.join(tutorialsDir(), 'demo', 'demo.srt'), 'utf8')).toBe(SRT);
  });

  it('answers 404 for a missing file and for an unknown tutorial', async () => {
    expect((await media('demo', 'nope.mp4')).statusCode).toBe(404);
    expect((await media('nope', 'demo.mp4')).statusCode).toBe(404);
  });

  it('refuses file types the player never asks for, including the manifest itself', async () => {
    fs.writeFileSync(path.join(tutorialsDir(), 'demo', 'notes.txt'), 'x');
    for (const file of ['tutorial.json', 'notes.txt']) expect([403, 404, 415]).toContain((await media('demo', file)).statusCode);
  });

  describe('containment', () => {
    const bad = (res: { statusCode: number; body: string }) => {
      expect([400, 403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain(SECRET);
    };

    it.each([
      ['a parent segment', '..%2Fsecret.mp4'],
      ['an encoded dot-dot', '%2e%2e%2fsecret.mp4'],
      ['a nested climb', 'sub%2F..%2F..%2Fsecret.mp4'],
      ['a double-encoded climb', '..%252Fsecret.mp4'],
      ['a backslash climb', '..%5Csecret.mp4'],
      ['an absolute path', `${encodeURIComponent(path.join(os.tmpdir(), 'x.mp4'))}`],
      ['an absolute path to a known file', encodeURIComponent('/etc/hosts')],
      ['a NUL byte', 'demo.mp4%00.md'],
      ['a bare dot-dot', '..'],
    ])('refuses %s in the file name', async (_label, file) => {
      bad(await get(`/api/tutorials/demo/media/${file}`));
    });

    it.each([['a parent segment', '..%2Fdemo'], ['an absolute path', encodeURIComponent('/etc')], ['a NUL byte', 'demo%00'], ['a dot-dot', '..']])('refuses %s in the tutorial id', async (_label, id) => {
      bad(await get(`/api/tutorials/${id}/media/demo.mp4`));
    });

    it('refuses a symlinked file that points outside the tutorial folder', async () => {
      bad(await media('demo', 'escape.mp4'));
    });

    it('refuses a file reached through a symlinked directory', async () => {
      bad(await get('/api/tutorials/demo/media/escape-dir%2Fsecret.mp4'));
    });

    it('refuses a tutorial folder that is itself a symlink out of the tutorials folder', async () => {
      bad(await media('linked', 'a.mp4'));
    });
  });
});
