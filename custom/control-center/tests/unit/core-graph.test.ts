import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { coreImportGraph, serverLoads, watchCoreGraph } from '../../supervisor/core-graph.js';
import { CONTRACT } from '../../server/core/adapter.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { tempDir } from '../helpers/tmp.js';

const put = (root: string, rel: string, text: string) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// fs.watch reports writes reliably only a moment after a watch starts; the supervisor's reload debounce is longer than this.
const SETTLE = 400;

/** A scratch code root shaped like this checkout: a custom module importing an upstream root module, which imports a lib/ helper. */
function scratchRoot(): string {
  const root = fs.realpathSync(tempDir('cc-core-graph-'));
  put(root, 'custom/projects/lib.mjs', "import { normalize } from '../../tracker-parse.mjs';\nimport fs from 'node:fs';\nexport const key = (s) => normalize(s);\n");
  put(root, 'tracker-parse.mjs', "import { trim } from './lib/text.mjs';\n// not an import: from './lib/missing.mjs'\nexport const normalize = (s) => trim(s).toLowerCase();\n");
  put(root, 'lib/text.mjs', 'export const trim = (s) => s.trim();\n');
  put(root, 'unrelated.mjs', 'export const x = 1;\n');
  return root;
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

describe('the import graph of the core modules the server loads', () => {
  it('follows relative imports transitively from custom/ into the upstream root, and nothing else', () => {
    const root = scratchRoot();
    expect(coreImportGraph(root, ['custom/projects/lib.mjs'])).toEqual(['custom/projects/lib.mjs', 'lib/text.mjs', 'tracker-parse.mjs']);
  });

  it('covers every contracted module of this checkout, with what they import (custom/projects/lib.mjs reaches tracker-parse.mjs)', () => {
    const graph = coreImportGraph(DEFAULT_CODE_ROOT, CONTRACT.exports.map((e) => e.module));
    for (const m of CONTRACT.exports.map((e) => e.module)) expect(graph).toContain(m);
    expect(graph).toContain('tracker-parse.mjs');
    expect(graph).toContain('skill-extract.mjs');
    expect(graph.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('what a server child loads: the package\'s server/ and shared/ trees and the core graph, nothing else (SW2-claude-05 review)', () => {
    const root = scratchRoot();
    const serverDir = path.dirname(put(root, 'custom/control-center/server/index.ts', 'export {};\n'));
    const loads = serverLoads(root, path.dirname(serverDir), ['custom/projects/lib.mjs']);
    for (const rel of ['custom/control-center/server/app.ts', 'custom/control-center/server/claude/manager.ts', 'custom/control-center/shared/page-theme.ts', 'custom/projects/lib.mjs', 'tracker-parse.mjs', 'lib/text.mjs']) expect(loads(rel), rel).toBe(true);
    for (const rel of ['cv.md', 'data/notes/x.md', 'custom/control-center/web/src/main.tsx', 'custom/control-center/serverless/x.ts', 'custom/immigration/watch.mjs', 'unrelated.mjs']) expect(loads(rel), rel).toBe(false);
  });
});

describe('a change anywhere in that graph restarts the server child, whose fresh module cache loads the whole graph anew', () => {
  it('signals a change to a dependency, and a fresh process then sees the dependent module\'s new behavior', async () => {
    const root = scratchRoot();
    const changes: string[] = [];
    const watcher = await watchCoreGraph(root, ['custom/projects/lib.mjs'], (file) => changes.push(file));
    stops.push(watcher.close);
    await wait(SETTLE);
    const fresh = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(path.join(root, 'custom/projects/lib.mjs'))}).then((m) => process.stdout.write(m.key('  Acme ')))`], { encoding: 'utf8' }).stdout;
    expect(fresh()).toBe('acme');
    put(root, 'lib/text.mjs', "export const trim = (s) => `${s.trim()}!`;\n");
    for (let i = 0; i < 100 && !changes.length; i++) await wait(50);
    expect(changes).toEqual([path.join(root, 'lib/text.mjs')]);
    expect(fresh()).toBe('acme!');
    put(root, 'tracker-parse.mjs', "import { trim } from './lib/text.mjs';\nexport const normalize = (s) => trim(s).toUpperCase();\n");
    for (let i = 0; i < 100 && changes.length < 2; i++) await wait(50);
    expect(changes.at(-1)).toBe(path.join(root, 'tracker-parse.mjs'));
    expect(fresh()).toBe('ACME!');
  });

  it('ignores a change to a file outside the graph', async () => {
    const root = scratchRoot();
    const changes: string[] = [];
    const watcher = await watchCoreGraph(root, ['custom/projects/lib.mjs'], (file) => changes.push(file));
    stops.push(watcher.close);
    await wait(SETTLE);
    put(root, 'unrelated.mjs', 'export const x = 2;\n');
    await wait(800);
    expect(changes).toEqual([]);
  });

  it('watches a file a module imports before it exists, so creating it and editing it later restart the child (SW5-claude-01)', async () => {
    const root = scratchRoot();
    // lib.mjs now imports slug.mjs, which is written a moment later (Dev Chat edits the importer first).
    put(root, 'custom/projects/lib.mjs', "import { normalize } from '../../tracker-parse.mjs';\nimport { slug } from './slug.mjs';\nexport const key = (s) => slug(normalize(s));\n");
    const changes: string[] = [];
    const watcher = await watchCoreGraph(root, ['custom/projects/lib.mjs'], (file) => changes.push(file));
    stops.push(watcher.close);
    await wait(SETTLE);
    put(root, 'custom/projects/slug.mjs', "import { trim } from '../../lib/text.mjs';\nexport const slug = (s) => trim(s).replace(/ /g, '-');\n");
    for (let i = 0; i < 100 && !changes.length; i++) await wait(50);
    expect(changes).toEqual([path.join(root, 'custom/projects/slug.mjs')]);
    // No reload settled in between: the new file is watched for its own later edits all the same.
    await wait(SETTLE);
    changes.length = 0;
    put(root, 'custom/projects/slug.mjs', "import { trim } from '../../lib/text.mjs';\nexport const slug = (s) => trim(s).replace(/ /g, '_');\n");
    for (let i = 0; i < 100 && !changes.length; i++) await wait(50);
    expect(changes).toEqual([path.join(root, 'custom/projects/slug.mjs')]);
  });

  it('an import added to a watched module and its file written right after, with no reload in between, still signals the new file (SW5-claude-01 review)', async () => {
    const root = scratchRoot();
    const changes: string[] = [];
    const watcher = await watchCoreGraph(root, ['custom/projects/lib.mjs'], (file) => changes.push(file));
    stops.push(watcher.close);
    await wait(SETTLE);
    // Back to back, before anything reacts to the first write: the importer gains the import, then the file appears.
    put(root, 'custom/projects/lib.mjs', "import { normalize } from '../../tracker-parse.mjs';\nimport { slug } from './slug.mjs';\nexport const key = (s) => slug(normalize(s));\n");
    put(root, 'custom/projects/slug.mjs', 'export const slug = (s) => s.replace(/ /g, "-");\n');
    const slug = path.join(root, 'custom/projects/slug.mjs');
    for (let i = 0; i < 100 && !changes.includes(slug); i++) await wait(50);
    expect(changes).toContain(path.join(root, 'custom/projects/lib.mjs'));
    expect(changes).toContain(slug);
  });

  it('watches a file the graph gains after a reload (an upstream module started importing a new one)', async () => {
    const root = scratchRoot();
    const changes: string[] = [];
    const watcher = await watchCoreGraph(root, ['custom/projects/lib.mjs'], (file) => changes.push(file));
    stops.push(watcher.close);
    await wait(SETTLE);
    put(root, 'lib/case.mjs', 'export const lower = (s) => s.toLowerCase();\n');
    put(root, 'tracker-parse.mjs', "import { trim } from './lib/text.mjs';\nimport { lower } from './lib/case.mjs';\nexport const normalize = (s) => lower(trim(s));\n");
    for (let i = 0; i < 100 && !changes.length; i++) await wait(50);
    await watcher.refresh();
    await wait(SETTLE);
    changes.length = 0;
    put(root, 'lib/case.mjs', 'export const lower = (s) => s.toLocaleLowerCase();\n');
    for (let i = 0; i < 100 && !changes.length; i++) await wait(50);
    expect(changes).toEqual([path.join(root, 'lib/case.mjs')]);
  });
});
