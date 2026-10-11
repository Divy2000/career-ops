import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLibrary, serializeLibrary } from '../lib.mjs';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT = path.join(HERE, '..', 'import.mjs');

// Holds the run's rename onto article-digest.md until `release` exists, after announcing it on `held`: the run has
// read the library and built its replacement, and is about to publish it.
const HOLD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { held, release } = JSON.parse(process.env.IMPORT_HOLD);
const real = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (String(to).endsWith('article-digest.md')) {
    fs.writeFileSync(held, '');
    while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  }
  return real(from, to);
};
syncBuiltinESMExports();
`;

const waitFor = async (file, ms) => {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('given two --write --merge imports of different projects at once, when both finish, then the library has both (R23-scripts-a-X-03)', async () => {
  const root = tempDir('projects-import-race-');
  fs.writeFileSync(path.join(root, 'article-digest.md'), serializeLibrary([{ title: 'Existing Tool', bullets: ['Already here.'] }]));
  const a = path.join(root, 'a.json');
  const b = path.join(root, 'b.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  fs.writeFileSync(b, JSON.stringify([{ name: 'Beta Service', highlights: ['Built beta.'] }]));
  const preload = path.join(root, 'hold.mjs');
  fs.writeFileSync(preload, HOLD);
  const held = path.join(root, 'held');
  const release = path.join(root, 'release');

  const first = spawn(process.execPath, ['--import', preload, IMPORT, a, '--write', '--merge'], {
    cwd: root,
    env: rootEnv(root, { IMPORT_HOLD: JSON.stringify({ held, release }) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstErr = '';
  first.stderr.on('data', (d) => { firstErr += d; });
  const firstExit = new Promise((resolve) => first.on('exit', resolve));
  try {
    await waitFor(held, 20_000);
    // The second import runs to completion (or to its lock wait) while the first is held before publishing.
    const second = spawn(process.execPath, [IMPORT, b, '--write', '--merge'], { cwd: root, env: rootEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let secondErr = '';
    second.stderr.on('data', (d) => { secondErr += d; });
    const secondExit = new Promise((resolve) => second.on('exit', resolve));
    // Give the second run time to finish if nothing makes it wait.
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(release, '');
    assert.equal(await firstExit, 0, firstErr);
    assert.equal(await secondExit, 0, secondErr);
  } finally {
    fs.writeFileSync(release, '');
    first.kill();
  }
  const titles = parseLibrary(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8')).entries.map((e) => e.title);
  assert.deepEqual(titles.sort(), ['Alpha Service', 'Beta Service', 'Existing Tool']);
});

test('given a fresh data root, when two --write imports race, then one writes the library and the other is refused, not overwriting it (R23-scripts-a-X-03)', async () => {
  const root = tempDir('projects-import-race-');
  const a = path.join(root, 'a.json');
  const b = path.join(root, 'b.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  fs.writeFileSync(b, JSON.stringify([{ name: 'Beta Service', highlights: ['Built beta.'] }]));
  const preload = path.join(root, 'hold.mjs');
  fs.writeFileSync(preload, HOLD);
  const held = path.join(root, 'held');
  const release = path.join(root, 'release');
  const first = spawn(process.execPath, ['--import', preload, IMPORT, a, '--write'], { cwd: root, env: rootEnv(root, { IMPORT_HOLD: JSON.stringify({ held, release }) }), stdio: 'ignore' });
  const firstExit = new Promise((resolve) => first.on('exit', resolve));
  try {
    await waitFor(held, 20_000);
    const second = spawn(process.execPath, [IMPORT, b, '--write'], { cwd: root, env: rootEnv(root), stdio: 'ignore' });
    const secondExit = new Promise((resolve) => second.on('exit', resolve));
    await new Promise((r) => setTimeout(r, 1500));
    fs.writeFileSync(release, '');
    assert.equal(await firstExit, 0);
    assert.equal(await secondExit, 1);
  } finally {
    fs.writeFileSync(release, '');
    first.kill();
  }
  const titles = parseLibrary(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8')).entries.map((e) => e.title);
  assert.deepEqual(titles, ['Alpha Service']);
});
