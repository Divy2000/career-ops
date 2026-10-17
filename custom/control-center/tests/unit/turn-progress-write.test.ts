import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeProgress } from '../../server/claude/manager.js';
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
});
