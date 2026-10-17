import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readProgress, writeProgress } from '../../server/claude/manager.js';
import { tempDir } from '../helpers/tmp.js';

describe("a turn's saved transcript progress", () => {
  it('given another server process holding the fixed temp name, when progress is saved, then it lands through a temp file of its own', () => {
    const dir = tempDir('cc-progress-');
    const file = path.join(dir, 'progress.json');
    // A blue/green peer mid-write holds `${file}.tmp`; a shared temp name would write into (or rename away) its file.
    fs.mkdirSync(`${file}.tmp`);

    writeProgress(file, { rawSeq: 3, rawOffset: 120 });

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ rawSeq: 3, rawOffset: 120 });
    expect(fs.readdirSync(dir).sort()).toEqual(['progress.json', 'progress.json.tmp']);
  });

  it('given a save whose rename fails, when it throws, then no temp file is left behind', () => {
    const dir = tempDir('cc-progress-');
    const file = path.join(dir, 'progress.json');
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'x'), '');

    expect(() => writeProgress(file, { rawSeq: 1, rawOffset: 0 })).toThrow();
    expect(fs.readdirSync(dir)).toEqual(['progress.json']);
  });
  it('given temp files left by a save that crashed before its rename, when progress is read, then those of a process that is gone or that are old are swept, and a live peer\'s save in flight is kept', () => {
    const dir = tempDir('cc-progress-');
    const file = path.join(dir, 'progress.json');
    writeProgress(file, { rawSeq: 2, rawOffset: 40 });
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    fs.writeFileSync(`${file}.tmp-${gone}-aaaaaa`, '{');
    const old = `${file}.tmp-${process.pid}-bbbbbb`;
    fs.writeFileSync(old, '{');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(old, hourAgo, hourAgo);
    fs.writeFileSync(`${file}.tmp-${process.ppid}-cccccc`, '{');

    expect(readProgress(file)).toEqual({ rawSeq: 2, rawOffset: 40 });

    expect(fs.readdirSync(dir).sort()).toEqual(['progress.json', `progress.json.tmp-${process.ppid}-cccccc`]);
  });
  it('given a left-behind temp name that cannot be removed, when progress is read, then the saved progress is still returned and the failure is only warned of', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = tempDir('cc-progress-');
      const file = path.join(dir, 'progress.json');
      writeProgress(file, { rawSeq: 5, rawOffset: 90 });
      const gone = spawnSync(process.execPath, ['-e', '']).pid!;
      fs.mkdirSync(`${file}.tmp-${gone}-dddddd`);
      fs.writeFileSync(path.join(`${file}.tmp-${gone}-dddddd`, 'x'), '');

      expect(readProgress(file)).toEqual({ rawSeq: 5, rawOffset: 90 });
      expect(warn.mock.calls.flat().join('\n')).toContain(`progress.json.tmp-${gone}-dddddd`);
    } finally {
      warn.mockRestore();
    }
  });
});
