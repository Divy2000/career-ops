import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLibrary, serializeLibrary } from '../lib.mjs';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORT = path.join(HERE, '..', 'import.mjs');

// Holds the run after it has written its replacement library to the temp file, until `release` exists, after
// announcing it on `held`: the run has read the library and built its replacement, and is about to publish it.
const HOLD = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { held, release } = JSON.parse(process.env.IMPORT_HOLD);
const real = fs.promises.writeFile;
fs.promises.writeFile = async (file, ...rest) => {
  const out = await real(file, ...rest);
  if (String(file).includes('article-digest.md.tmp-')) {
    fs.writeFileSync(held, '');
    while (!fs.existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  }
  return out;
};
syncBuiltinESMExports();
`;

// Writes `seen` the first time the run either finds a *.lock directory already taken (pipeline-lock.mjs takes its lock
// with mkdirSync), or looks at article-digest.md: proof the run is waiting on the lock, or has gone ahead without it.
const SEEN = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const seen = process.env.IMPORT_SEEN;
const mark = (why) => { if (!fs.existsSync(seen)) fs.writeFileSync(seen, why); };
const isLibrary = (p) => String(p).endsWith('article-digest.md');
const { mkdirSync, existsSync } = fs;
const readFile = fs.promises.readFile;
fs.mkdirSync = function (p, ...rest) {
  try {
    return mkdirSync.call(this, p, ...rest);
  } catch (err) {
    if (err.code === 'EEXIST' && String(p).endsWith('.lock')) mark('lock');
    throw err;
  }
};
fs.existsSync = (p) => { if (isLibrary(p)) mark('library'); return existsSync(p); };
fs.promises.readFile = async (p, ...rest) => { if (isLibrary(p)) mark('library'); return readFile(p, ...rest); };
syncBuiltinESMExports();
`;

const waitFor = async (file, ms) => {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Resolves once `file` exists or `exit` settles, whichever comes first. */
const waitForEither = (file, exit, ms) => Promise.race([waitFor(file, ms), exit]);

function harness(root) {
  const preload = path.join(root, 'hold.mjs');
  fs.writeFileSync(preload, HOLD);
  const seenPreload = path.join(root, 'seen.mjs');
  fs.writeFileSync(seenPreload, SEEN);
  return { preload, seenPreload, held: path.join(root, 'held'), release: path.join(root, 'release'), seen: path.join(root, 'seen') };
}

/** Replaces article-digest.md the way the Control Center's writeUserFile does: a temp file renamed over it. */
function appWrite(root, entries) {
  const target = path.join(root, 'article-digest.md');
  fs.writeFileSync(`${target}.app-tmp`, serializeLibrary(entries));
  fs.renameSync(`${target}.app-tmp`, target);
}

test('given two --write --merge imports of different projects at once, when both finish, then the library has both (R23-scripts-a-X-03)', async () => {
  const root = tempDir('projects-import-race-');
  fs.writeFileSync(path.join(root, 'article-digest.md'), serializeLibrary([{ title: 'Existing Tool', bullets: ['Already here.'] }]));
  const a = path.join(root, 'a.json');
  const b = path.join(root, 'b.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  fs.writeFileSync(b, JSON.stringify([{ name: 'Beta Service', highlights: ['Built beta.'] }]));
  const { preload, seenPreload, held, release, seen } = harness(root);

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
    const second = spawn(process.execPath, ['--import', seenPreload, IMPORT, b, '--write', '--merge'], {
      cwd: root,
      env: rootEnv(root, { IMPORT_SEEN: seen }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondErr = '';
    second.stderr.on('data', (d) => { secondErr += d; });
    const secondExit = new Promise((resolve) => second.on('exit', resolve));
    // Release the first run only once the second has met the held lock or has read the library without it.
    await waitForEither(seen, secondExit, 20_000);
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
  const { preload, seenPreload, held, release, seen } = harness(root);
  const first = spawn(process.execPath, ['--import', preload, IMPORT, a, '--write'], { cwd: root, env: rootEnv(root, { IMPORT_HOLD: JSON.stringify({ held, release }) }), stdio: 'ignore' });
  const firstExit = new Promise((resolve) => first.on('exit', resolve));
  try {
    await waitFor(held, 20_000);
    const second = spawn(process.execPath, ['--import', seenPreload, IMPORT, b, '--write'], { cwd: root, env: rootEnv(root, { IMPORT_SEEN: seen }), stdio: 'ignore' });
    const secondExit = new Promise((resolve) => second.on('exit', resolve));
    await waitForEither(seen, secondExit, 20_000);
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

/** Starts an import held just before it publishes; resolves its exit code and stderr once released. */
function heldImport(root, args) {
  const { preload, held, release } = harness(root);
  const child = spawn(process.execPath, ['--import', preload, IMPORT, ...args], {
    cwd: root,
    env: rootEnv(root, { IMPORT_HOLD: JSON.stringify({ held, release }) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })));
  return { held, release, exit, kill: () => child.kill() };
}

test('given a --write --merge import that has read the library, when the Control Center saves a project before the import publishes, then the import is refused and the saved project stays (R24-scripts-a-L1-01)', async () => {
  const root = tempDir('projects-import-app-race-');
  fs.writeFileSync(path.join(root, 'article-digest.md'), serializeLibrary([{ title: 'Existing Tool', bullets: ['Already here.'] }]));
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const run = heldImport(root, [a, '--write', '--merge']);
  let result;
  try {
    await waitFor(run.held, 20_000);
    appWrite(root, [{ title: 'Existing Tool', bullets: ['Already here.'] }, { title: 'App Project', bullets: ['Saved in the app.'] }]);
    fs.writeFileSync(run.release, '');
    result = await run.exit;
  } finally {
    fs.writeFileSync(run.release, '');
    run.kill();
  }
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /article-digest\.md changed while importing/);
  const titles = parseLibrary(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8')).entries.map((e) => e.title);
  assert.deepEqual(titles, ['Existing Tool', 'App Project']);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), [], 'the refused import left its temp file behind');
});

test('given a fresh data root, when the Control Center creates the library while a --write import is about to publish, then the import is refused and does not overwrite it (R24-scripts-a-L1-01)', async () => {
  const root = tempDir('projects-import-app-race-');
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const run = heldImport(root, [a, '--write']);
  let result;
  try {
    await waitFor(run.held, 20_000);
    appWrite(root, [{ title: 'App Project', bullets: ['Saved in the app.'] }]);
    fs.writeFileSync(run.release, '');
    result = await run.exit;
  } finally {
    fs.writeFileSync(run.release, '');
    run.kill();
  }
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /article-digest\.md was created while importing/);
  const titles = parseLibrary(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8')).entries.map((e) => e.title);
  assert.deepEqual(titles, ['App Project']);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), [], 'the refused import left its temp file behind');
});

test('given a data root whose filesystem refuses hard links, when a fresh --write import publishes, then it still writes the library (R24-scripts-a-L1-01 review)', () => {
  const root = tempDir('projects-import-nolink-');
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const preload = path.join(root, 'nolink.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.linkSync = () => { const err = new Error('operation not supported'); err.code = 'ENOTSUP'; throw err; };
syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ['--import', preload, IMPORT, a, '--write'], { cwd: root, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const titles = parseLibrary(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8')).entries.map((e) => e.title);
  assert.deepEqual(titles, ['Alpha Service']);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), []);
});

test('given a data root without hard links, when the fresh library cannot be moved into place, then no empty or partial article-digest.md is left (R24-scripts-a-L1-01 review)', () => {
  const root = tempDir('projects-import-nolink-');
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const preload = path.join(root, 'nolink-fail.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.linkSync = () => { const err = new Error('operation not supported'); err.code = 'ENOTSUP'; throw err; };
fs.renameSync = () => { const err = new Error('i/o error'); err.code = 'EIO'; throw err; };
syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ['--import', preload, IMPORT, a, '--write'], { cwd: root, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /i\/o error/);
  assert.equal(fs.existsSync(path.join(root, 'article-digest.md')), false);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), []);
});

test('given a fresh data root, when the library appears during a --write --merge import, then the refusal does not tell the user to add --merge (R24-scripts-a-L1-01 review)', async () => {
  const root = tempDir('projects-import-app-race-');
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const run = heldImport(root, [a, '--write', '--merge']);
  let result;
  try {
    await waitFor(run.held, 20_000);
    appWrite(root, [{ title: 'App Project', bullets: ['Saved in the app.'] }]);
    fs.writeFileSync(run.release, '');
    result = await run.exit;
  } finally {
    fs.writeFileSync(run.release, '');
    run.kill();
  }
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /article-digest\.md was created while importing/);
  assert.doesNotMatch(result.stderr, /rerun with --merge/);
  assert.match(result.stderr, /rerun to merge into the current library/);
});

test('given a --write --merge import whose temp library write fails partway (a full disk), when it fails, then no partial temp library is left in the data root (R27-scripts-a-L1-01)', () => {
  const root = tempDir('projects-import-enospc-');
  const before = serializeLibrary([{ title: 'Existing Tool', bullets: ['Already here.'] }]);
  fs.writeFileSync(path.join(root, 'article-digest.md'), before);
  const a = path.join(root, 'a.json');
  fs.writeFileSync(a, JSON.stringify([{ name: 'Alpha Service', highlights: ['Built alpha.'] }]));
  const preload = path.join(root, 'enospc.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.promises.writeFile;
fs.promises.writeFile = async (file, data, ...rest) => {
  if (!String(file).includes('article-digest.md.tmp-')) return real(file, data, ...rest);
  await real(file, String(data).slice(0, 10), ...rest);
  const err = new Error('no space left on device'); err.code = 'ENOSPC'; throw err;
};
syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ['--import', preload, IMPORT, a, '--write', '--merge'], { cwd: root, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /import failed: no space left on device/);
  assert.equal(fs.readFileSync(path.join(root, 'article-digest.md'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), [], 'the failed import left its partial temp library behind');
});
