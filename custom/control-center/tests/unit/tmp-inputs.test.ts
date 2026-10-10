import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { removeTmpInputs, sweepStaleInputs, tmpInputDir, uploadsDir, uploadsNamedBySessions, writeTmpInput } from '../../server/actions/tmp-inputs.js';
import { tempDir } from '../helpers/tmp.js';

const HOUR = 3_600_000;

describe('action input files', () => {
  it('writes each input under the data root tmp dir and removes exactly the ones a command names', () => {
    const root = tempDir('cc-tmp-inputs-');
    const a = writeTmpInput(root, 'txt', 'pasted job description');
    const b = writeTmpInput(root, 'md', 'another run');
    expect(path.dirname(a)).toBe(tmpInputDir(root));
    expect(fs.readFileSync(a, 'utf8')).toBe('pasted job description');
    const outside = path.join(root, 'cv.md');
    fs.writeFileSync(outside, '# CV');
    // A real file one level up, named by a path that starts with the tmp dir and climbs out of it (written raw, so the
    // `..` is not normalized away before the call): a prefix check would delete it (SW2-tests-25).
    const settings = path.join(tmpInputDir(root), '..', 'settings.json');
    fs.writeFileSync(settings, '{}');
    const climbing = `${tmpInputDir(root)}/../settings.json`;
    expect(climbing.startsWith(tmpInputDir(root))).toBe(true);
    removeTmpInputs(root, ['--file', a, '--json', outside, climbing]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{}');
  });

  it('sweeps input files and CV uploads older than the cutoff and keeps newer ones', () => {
    const root = tempDir('cc-tmp-sweep-');
    const oldInput = writeTmpInput(root, 'txt', 'old');
    const newInput = writeTmpInput(root, 'txt', 'new');
    fs.mkdirSync(uploadsDir(root), { recursive: true });
    const oldUpload = path.join(uploadsDir(root), '1-cv.pdf');
    const newUpload = path.join(uploadsDir(root), '2-cv.pdf');
    for (const f of [oldUpload, newUpload]) fs.writeFileSync(f, '%PDF');
    const past = new Date(Date.now() - 25 * HOUR);
    for (const f of [oldInput, oldUpload]) fs.utimesSync(f, past, past);
    sweepStaleInputs(root, 24 * HOUR);
    expect([oldInput, oldUpload].map((f) => fs.existsSync(f))).toEqual([false, false]);
    expect([newInput, newUpload].map((f) => fs.existsSync(f))).toEqual([true, true]);
  });

  it('keeps every old upload when it cannot tell which ones a session names, and still sweeps old input files (R12-srv-core-L1-01)', () => {
    const root = tempDir('cc-tmp-sweep-unknown-');
    const oldInput = writeTmpInput(root, 'txt', 'old');
    fs.mkdirSync(uploadsDir(root), { recursive: true });
    const oldUpload = path.join(uploadsDir(root), '1-cv.pdf');
    fs.writeFileSync(oldUpload, '%PDF');
    const past = new Date(Date.now() - 25 * HOUR);
    for (const f of [oldInput, oldUpload]) fs.utimesSync(f, past, past);
    sweepStaleInputs(root, 24 * HOUR, () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    expect([fs.existsSync(oldInput), fs.existsSync(oldUpload)]).toEqual([false, true]);
  });

  it('a session folder created moments ago whose meta.json is not written yet makes the names unknown; an old empty one does not (R12-srv-core-L1-01 review)', () => {
    const root = tempDir('cc-tmp-sweep-creating-');
    const sessions = path.join(root, 'data', 'control-center', 'sessions');
    fs.mkdirSync(path.join(sessions, 's-creating'), { recursive: true });
    expect(() => uploadsNamedBySessions(root)).toThrow(/s-creating/);
    const past = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(path.join(sessions, 's-creating'), past, past);
    expect([...uploadsNamedBySessions(root)]).toEqual([]);
  });

  it('sweeps nothing and does not fail when the dirs do not exist yet', () => {
    expect(() => sweepStaleInputs(tempDir('cc-tmp-empty-'), HOUR)).not.toThrow();
  });
});
