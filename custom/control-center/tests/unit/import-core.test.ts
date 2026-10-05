import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importCore } from '../../server/core/adapter.js';
import { tempDir } from '../helpers/tmp.js';

// A scratch code root holding stand-ins for contracted modules, so each test controls the files importCore loads.
function codeRoot(): string {
  return fs.realpathSync(tempDir('cc-import-core-'));
}
const put = (root: string, rel: string, text: string, mtime?: Date) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};

describe('importCore', () => {
  it('loads the module again after a failed import, once the file is there (a sync was mid-write)', async () => {
    const root = codeRoot();
    await expect(importCore(root, 'tracker-parse.mjs')).rejects.toThrow();
    put(root, 'tracker-parse.mjs', 'export const normalizeTextKey = () => "ok";\n');
    const mod = await importCore<{ normalizeTextKey: () => string }>(root, 'tracker-parse.mjs');
    expect(mod.normalizeTextKey()).toBe('ok');
  });

  it('loads a module again once a syntax error in it is fixed', async () => {
    const root = codeRoot();
    put(root, 'path-resolver.mjs', 'export const broken = ;\n', new Date(Date.now() - 60_000));
    await expect(importCore(root, 'path-resolver.mjs')).rejects.toThrow(/Unexpected token/);
    put(root, 'path-resolver.mjs', 'export const getCareerOpsRoot = () => "/data";\n');
    expect((await importCore<{ getCareerOpsRoot: () => string }>(root, 'path-resolver.mjs')).getCareerOpsRoot()).toBe('/data');
  });

  it('keeps one copy of a module for the life of the process, even after its file changes (the supervisor restarts the server child for that)', async () => {
    const root = codeRoot();
    put(root, 'custom/projects/lib.mjs', 'export const version = 1;\n', new Date(Date.now() - 60_000));
    const first = await importCore<{ version: number }>(root, 'custom/projects/lib.mjs');
    expect(first.version).toBe(1);
    put(root, 'custom/projects/lib.mjs', 'export const version = 2;\n');
    expect(await importCore(root, 'custom/projects/lib.mjs')).toBe(first);
  });
});
