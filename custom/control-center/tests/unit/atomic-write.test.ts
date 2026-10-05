import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../../server/lib/atomic-write.js';
import { tempDir } from '../helpers/tmp.js';

describe('writeFileAtomic', () => {
  it('writes a new file, creating nothing else next to it', () => {
    const dir = tempDir('cc-atomic-');
    writeFileAtomic(path.join(dir, 'cv.md'), '# CV\n');
    expect(fs.readFileSync(path.join(dir, 'cv.md'), 'utf8')).toBe('# CV\n');
    expect(fs.readdirSync(dir)).toEqual(['cv.md']);
  });

  it('keeps the mode of the file it replaces', () => {
    const file = path.join(tempDir('cc-atomic-mode-'), 'cv.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o600);
    writeFileAtomic(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('follows a symlink: the target gets the new text and the link stays a link', () => {
    const synced = tempDir('cc-atomic-synced-');
    const root = tempDir('cc-atomic-root-');
    const target = path.join(synced, 'cv.md');
    fs.writeFileSync(target, 'old');
    const link = path.join(root, 'cv.md');
    fs.symlinkSync(target, link);
    writeFileAtomic(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['cv.md']);
    expect(fs.readdirSync(synced)).toEqual(['cv.md']);
  });
});
