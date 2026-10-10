// Two CV uploads with the same name in the same millisecond each keep their own file (R16-merge-05).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { makeTestApp, type TestApp } from '../helpers/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeTestApp();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CV uploads with the same name at the same time', () => {
  it('stores each upload under its own path, so neither overwrites the other', async () => {
    const upload = (body: string) => t.app.inject({ method: 'POST', url: '/api/cv/upload?name=cv.pdf', headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: Buffer.from(body) });
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    const [a, b] = await Promise.all([upload('%PDF-1.4 first'), upload('%PDF-1.4 second')]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const pa = a.json().path as string;
    const pb = b.json().path as string;
    expect(pa).not.toBe(pb);
    expect(pa.endsWith('-cv.pdf')).toBe(true);
    expect(fs.readFileSync(pa, 'utf8')).toBe('%PDF-1.4 first');
    expect(fs.readFileSync(pb, 'utf8')).toBe('%PDF-1.4 second');
  });

  it('retries a name that already exists instead of failing the upload', async () => {
    // Force the first candidate to collide (a same-millisecond collision or a leftover file): the handler must
    // pick another name, not answer 500.
    const real = fs.writeFileSync.bind(fs);
    let first = true;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      if (first) {
        first = false;
        const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      return (real as (f: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => void)(file, data, opts);
    }) as typeof fs.writeFileSync);
    const res = await t.app.inject({ method: 'POST', url: '/api/cv/upload?name=cv.pdf', headers: { ...t.authedWrite, 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4 retried') });
    expect(res.statusCode).toBe(200);
    const p = res.json().path as string;
    expect(fs.readFileSync(p, 'utf8')).toBe('%PDF-1.4 retried');
  });
});
