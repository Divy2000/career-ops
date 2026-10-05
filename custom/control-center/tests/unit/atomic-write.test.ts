import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OutsideRootsError, dataRootOnly, writeFileAtomic } from '../../server/lib/atomic-write.js';
import { tempDir } from '../helpers/tmp.js';

describe('writeFileAtomic', () => {
  it('writes a new file, creating nothing else next to it', () => {
    const dir = tempDir('cc-atomic-');
    writeFileAtomic(path.join(dir, 'cv.md'), '# CV\n', dataRootOnly(dir));
    expect(fs.readFileSync(path.join(dir, 'cv.md'), 'utf8')).toBe('# CV\n');
    expect(fs.readdirSync(dir)).toEqual(['cv.md']);
  });

  it('keeps the mode of the file it replaces', () => {
    const dir = tempDir('cc-atomic-mode-');
    const file = path.join(dir, 'cv.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o600);
    writeFileAtomic(file, 'new', dataRootOnly(dir));
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('follows a symlink whose target is inside the root: the target gets the new text and the link stays a link', () => {
    const root = tempDir('cc-atomic-root-');
    const target = path.join(root, 'synced', 'cv.md');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'old');
    const link = path.join(root, 'cv.md');
    fs.symlinkSync(target, link);
    writeFileAtomic(link, 'new', dataRootOnly(root));
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['cv.md']);
  });

  const outsideCases: Array<[string, (root: string, outside: string) => string]> = [
    ['a link to a file outside the root', (root, outside) => {
      fs.writeFileSync(path.join(outside, 'shared.md'), 'theirs');
      fs.symlinkSync(path.join(outside, 'shared.md'), path.join(root, 'cv.md'));
      return path.join(root, 'cv.md');
    }],
    ['a dangling link that would create a file outside the root', (root, outside) => {
      fs.symlinkSync(path.join(outside, 'not-yet.md'), path.join(root, 'cv.md'));
      return path.join(root, 'cv.md');
    }],
    ['a folder linked outside the root', (root, outside) => {
      fs.symlinkSync(outside, path.join(root, 'modes'));
      return path.join(root, 'modes', '_profile.md');
    }],
  ];
  for (const [what, make] of outsideCases) {
    it(`refuses ${what}, and changes nothing`, () => {
      const root = tempDir('cc-atomic-in-');
      const outside = fs.realpathSync(tempDir('cc-atomic-out-'));
      const target = make(root, outside);
      const before = fs.readdirSync(outside).map((n) => [n, fs.readFileSync(path.join(outside, n), 'utf8')]);
      const lstatBefore = fs.lstatSync(path.join(root, path.relative(root, target).split(path.sep)[0]!));
      expect(() => writeFileAtomic(target, 'new', dataRootOnly(root))).toThrow(OutsideRootsError);
      expect(() => writeFileAtomic(target, 'new', dataRootOnly(root))).toThrow(/outside the data root; nothing was written/);
      expect(fs.readdirSync(outside).map((n) => [n, fs.readFileSync(path.join(outside, n), 'utf8')])).toEqual(before);
      expect(fs.lstatSync(path.join(root, path.relative(root, target).split(path.sep)[0]!)).isSymbolicLink()).toBe(lstatBefore.isSymbolicLink());
    });
  }

  it('resolves a relative link against the real folder it sits in, not the linked path it was reached by', () => {
    // dataRoot/modes -> <out>, and <out>/_profile.md -> ../secret.md, which is <out>/../secret.md (outside), not dataRoot/secret.md.
    const root = fs.realpathSync(tempDir('cc-atomic-rel-'));
    const base = fs.realpathSync(tempDir('cc-atomic-rel-out-'));
    const out = path.join(base, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(base, 'secret.md'), 'secret');
    fs.symlinkSync('../secret.md', path.join(out, '_profile.md'));
    fs.symlinkSync(out, path.join(root, 'modes'));
    expect(() => writeFileAtomic(path.join(root, 'modes', '_profile.md'), 'new', dataRootOnly(root))).toThrow(new RegExp(`leads to ${path.join(base, 'secret.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, outside the data root`));
    expect(fs.existsSync(path.join(root, 'secret.md'))).toBe(false);
    expect(fs.readFileSync(path.join(base, 'secret.md'), 'utf8')).toBe('secret');
  });

  it('follows a relative link under a linked folder inside the root to its real target', () => {
    const root = fs.realpathSync(tempDir('cc-atomic-rel-in-'));
    fs.mkdirSync(path.join(root, 'real', 'modes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'real', 'profile.md'), 'old');
    fs.symlinkSync('../profile.md', path.join(root, 'real', 'modes', '_profile.md'));
    fs.symlinkSync(path.join(root, 'real', 'modes'), path.join(root, 'modes'));
    writeFileAtomic(path.join(root, 'modes', '_profile.md'), 'new', dataRootOnly(root));
    expect(fs.readFileSync(path.join(root, 'real', 'profile.md'), 'utf8')).toBe('new');
    expect(fs.existsSync(path.join(root, 'profile.md'))).toBe(false);
  });

  const unresolvable: Array<[string, (root: string) => string, RegExp]> = [
    ['a final link that loops back on itself', (root) => {
      fs.symlinkSync('cv2.md', path.join(root, 'cv.md'));
      fs.symlinkSync('cv.md', path.join(root, 'cv2.md'));
      return path.join(root, 'cv.md');
    }, /cannot tell where cv\.md leads \(ELOOP/],
    ['a folder link that loops', (root) => {
      fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a'));
      fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
      return path.join(root, 'a', '_profile.md');
    }, /cannot tell where a\/_profile\.md leads \(ELOOP/],
    ['a name too long for the file system', (root) => path.join(root, `${'x'.repeat(300)}.md`), /cannot tell where .* leads \(ENAMETOOLONG/],
  ];
  for (const [what, make, reason] of unresolvable) {
    it(`refuses ${what} with a 403 that says why, writing nothing`, () => {
      const root = fs.realpathSync(tempDir('cc-atomic-loop-'));
      const target = make(root);
      const before = fs.readdirSync(root).sort();
      let err: unknown;
      try {
        writeFileAtomic(target, 'new', dataRootOnly(root));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OutsideRootsError);
      expect((err as OutsideRootsError).statusCode).toBe(403);
      expect((err as Error).message).toMatch(reason);
      expect((err as Error).message).toMatch(/nothing was read or written/);
      expect(fs.readdirSync(root).sort()).toEqual(before);
    });
  }

  it('gives the refusal a 403 status for the HTTP layer', () => {
    expect(new OutsideRootsError('x').statusCode).toBe(403);
  });
});
