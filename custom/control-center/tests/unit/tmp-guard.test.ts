import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTmpGuard } from '../helpers/tmp-guard.js';
import { tempDir, removeTempDirs } from '../helpers/tmp.js';

describe('the TMPDIR guard for a vitest run', () => {
  const base = () => tempDir('cc-guard-base-');
  let env: NodeJS.ProcessEnv;
  afterEach(() => removeTempDirs());

  it('points TMPDIR, TEMP and TMP at one fresh dir and puts them back when the run ends', () => {
    env = { TMPDIR: '/old', TEMP: undefined, PATH: '/bin' };
    const guard = startTmpGuard(env, base());
    expect(fs.readdirSync(guard.dir)).toEqual([]);
    expect(env).toMatchObject({ TMPDIR: guard.dir, TEMP: guard.dir, TMP: guard.dir, PATH: '/bin' });
    guard.finish();
    expect(env).toEqual({ TMPDIR: '/old', PATH: '/bin' });
    expect(fs.existsSync(guard.dir)).toBe(false);
  });

  it('fails the run naming whatever was left behind, and still removes the dir', () => {
    env = {};
    const guard = startTmpGuard(env, base());
    fs.mkdirSync(path.join(guard.dir, 'cc-test-root-abc'));
    fs.writeFileSync(path.join(guard.dir, 'stray.txt'), '');
    expect(() => guard.finish()).toThrow(/left 2 entries in TMPDIR: cc-test-root-abc, stray\.txt/);
    expect(fs.existsSync(guard.dir)).toBe(false);
  });
});

describe('tempDir', () => {
  it('makes a fresh dir under the temp dir and removeTempDirs removes every one it made', () => {
    const a = tempDir('cc-tmp-a-');
    const b = tempDir('cc-tmp-b-');
    expect(path.dirname(a)).toBe(os.tmpdir());
    expect(path.basename(b)).toMatch(/^cc-tmp-b-/);
    fs.writeFileSync(path.join(a, 'f'), 'x');
    removeTempDirs();
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });
});
