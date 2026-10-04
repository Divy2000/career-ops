import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EM_DASH, findEmDashes } from '../../scripts/no-em-dash.mjs';
import { PACKAGE_ROOT } from '../helpers/app.js';

describe('no em dash in text we write', () => {
  it('the package tree is clean (fixtures that imitate parsed data are excluded)', () => {
    expect(findEmDashes(PACKAGE_ROOT)).toEqual([]);
  });

  it('the checker reports file and line when one slips in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-emdash-'));
    fs.writeFileSync(path.join(dir, 'bad.ts'), `const a = 1;\nconst b = "x ${EM_DASH} y";\n`);
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(path.join(dir, 'fixtures', 'data.md'), `score ${EM_DASH} pending\n`);
    const hits = findEmDashes(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/bad\.ts:2$/);
  });

  it('skips symlinked directories and files instead of crashing, and does not follow them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-emdash-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-emdash-outside-'));
    fs.writeFileSync(path.join(outside, 'elsewhere.ts'), `const a = "x ${EM_DASH} y";\n`);
    fs.writeFileSync(path.join(dir, 'ok.ts'), 'const a = 1;\n');
    fs.symlinkSync(outside, path.join(dir, 'node_modules'));
    fs.symlinkSync(outside, path.join(dir, 'linked-dir'));
    fs.symlinkSync(path.join(outside, 'elsewhere.ts'), path.join(dir, 'linked-file.ts'));
    expect(findEmDashes(dir)).toEqual([]);
  });
});
