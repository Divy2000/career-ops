import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCvEntry, findCvBlock, wordDiff, validateLibrary, parseLibrary } from '../lib.mjs';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const IMPORT = path.join(HERE, '..', 'import.mjs');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const dataRoot = ({ library = null, cv = read('cv-sample.md') } = {}) => {
  const d = tempDir('projects-import-');
  if (library !== null) fs.writeFileSync(path.join(d, 'article-digest.md'), library);
  if (cv !== null) fs.writeFileSync(path.join(d, 'cv.md'), cv);
  return d;
};
const run = (root, args) => {
  return spawnSync(process.execPath, [IMPORT, ...args], { cwd: root, env: rootEnv(root), encoding: 'utf8', timeout: 20000 });
};
const target = (root) => path.join(root, 'article-digest.md');
const input = (root, name, data) => {
  const f = path.join(root, name);
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};

test('wordDiff marks changed words with a little context and returns null for equal text', () => {
  assert.equal(wordDiff('a b c', 'a  b\nc'), null);
  assert.equal(
    wordDiff('one two three four five six seven eight', 'one two three four FIVE six seven eight'),
    '... two three four [-five-]{+FIVE+} six seven eight',
  );
  assert.equal(wordDiff('alpha beta', 'alpha beta gamma'), 'alpha beta {+gamma+}');
});

test('given long texts differing in one word, when diffed, then the diff is exact and quick', () => {
  const words = Array.from({ length: 20000 }, (_, i) => `w${i}`);
  const changed = [...words];
  changed[10000] = 'CHANGED';
  const t0 = Date.now();
  assert.equal(wordDiff(words.join(' '), changed.join(' ')), '... w9997 w9998 w9999 [-w10000-]{+CHANGED+} w10001 w10002 w10003 ...');
  assert.ok(Date.now() - t0 < 1000);
});

test('given long texts with no words in common, when diffed, then the work is capped and the output says it was truncated', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join(' ');
  const t0 = Date.now();
  const out = wordDiff(a, b);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.match(out, /^\[-a0 a1 /);
  assert.match(out, /\(diff truncated: compared the first \d+ differing words of each text\)$/);
});

test('findCvBlock returns the raw lines of a cv.md entry: heading through body, or a bold item and its continuation lines', () => {
  const headed = '## Projects\n\n### Graph Tool\nRepo: https://x.example/g\n- Built it.\n### Next\n- n\n';
  assert.deepEqual(findCvBlock(headed, 'graph tool'), { line: 3, endLine: 5, raw: '### Graph Tool\nRepo: https://x.example/g\n- Built it.' });
  const bold = '- **Graph Tool** -- Built it.\n  Repo: x.example/g\n- **Next** -- n\n';
  assert.deepEqual(findCvBlock(bold, 'Graph Tool'), { line: 1, endLine: 2, raw: '- **Graph Tool** -- Built it.\n  Repo: x.example/g' });
  assert.equal(findCvBlock(bold, 'Missing'), null);
});

test('findCvEntry finds a bold list item or a heading and returns its text without the title', () => {
  const cv = read('cv-sample.md');
  assert.equal(findCvEntry(cv, 'Graph Search Library').text, 'Implemented Dijkstra and A* search.');
  const headed = '## Projects\n\n### Weather Dashboard -- https://example.org/weather\n- Built a dashboard.\n- Wrote a client.\n\n## Skills\n';
  assert.deepEqual(findCvEntry(headed, 'weather dashboard'), { line: 3, text: 'Built a dashboard. Wrote a client.' });
  assert.equal(findCvEntry(cv, 'Weather Dashboard'), null);
});

test('given a projects.json, when run without flags, then it is a dry run printing "## Name -- url" blocks and writing nothing', () => {
  const root = dataRoot();
  const res = run(root, [path.join(FIX, 'projects.json')]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^## Ticket Triage Bot -- https:\/\/github\.com\/example-dev\/ticket-triage\nTags: python, fastapi, rag\n- Built a FastAPI service/m);
  assert.match(res.stdout, /^## Weather Dashboard\nTags: react\n/m);
  assert.equal(validateLibrary(res.stdout).ok, true);
  assert.match(res.stderr, /dry run/i);
  assert.equal(fs.existsSync(target(root)), false);
});

test('given a JSON Resume file, when converted, then the result is the same shape', () => {
  const root = dataRoot();
  const res = run(root, [path.join(FIX, 'resume.json'), '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^## Ticket Triage Bot -- https:\/\/github\.com\/example-dev\/ticket-triage\nTags: python, fastapi, rag\nDates: 2024-02 - 2024-06\n- Built/m);
});

test('given text that differs from cv.md, when run with --dry-run, then the difference is listed', () => {
  const res = run(dataRoot(), [path.join(FIX, 'projects.json'), '--dry-run']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Ticket Triage Bot differs from cv\.md line 9: .*\[-classifier\.-\]\{\+clasifier\.\+\}/);
  assert.match(res.stderr, /Weather Dashboard is not in cv\.md/);
});

test('given no article-digest.md, when run with --write, then it creates a valid library', () => {
  const root = dataRoot();
  const res = run(root, [path.join(FIX, 'projects.json'), '--write']);
  assert.equal(res.status, 0, res.stderr);
  const written = fs.readFileSync(target(root), 'utf8');
  assert.equal(validateLibrary(written).ok, true);
  assert.deepEqual(parseLibrary(written).entries.map((e) => e.id), ['ticket-triage-bot', 'weather-dashboard']);
  assert.match(res.stdout, /wrote 2 projects/);
});

test('given an existing article-digest.md and --write without --merge, when run, then it refuses and writes nothing', () => {
  const library = read('library.md');
  const root = dataRoot({ library });
  const res = run(root, [path.join(FIX, 'projects.json'), '--write']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--merge/);
  assert.equal(fs.readFileSync(target(root), 'utf8'), library);
});

test('given --merge with a duplicate title, when run with --write, then the duplicate is skipped and reported and the rest is appended', () => {
  const library = read('library.md');
  const root = dataRoot({ library });
  const file = input(root, 'more.json', [
    { name: 'ticket triage bot', description: 'Different text.' },
    { name: 'Chess Engine', url: 'https://example.org/chess', description: 'Wrote a chess engine in Rust.' },
  ]);
  const res = run(root, [file, '--merge', '--write']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /skipped.*ticket triage bot/i);
  const written = fs.readFileSync(target(root), 'utf8');
  assert.equal(written, `${library.replace(/\s+$/, '')}\n\n---\n\n## Chess Engine -- https://example.org/chess\n- Wrote a chess engine in Rust.\n`);
  assert.match(res.stdout, /wrote 1 project/);
});

test('given --merge without --write, when run, then it prints only the blocks to append and writes nothing', () => {
  const library = read('library.md');
  const root = dataRoot({ library });
  const file = input(root, 'more.json', [{ name: 'Chess Engine', description: 'Wrote a chess engine.' }]);
  const res = run(root, [file, '--merge']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '## Chess Engine\n- Wrote a chess engine.\n');
  assert.equal(fs.readFileSync(target(root), 'utf8'), library);
});

test('given a markdown library, when imported into an empty data root, then it is copied byte for byte', () => {
  const root = dataRoot();
  const res = run(root, [path.join(FIX, 'library.md'), '--write']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(target(root), 'utf8'), read('library.md'));
});

test('given a markdown library and --merge, when imported, then new blocks keep their full text', () => {
  const root = dataRoot({ library: '# Projects library\n\n## Chess Engine\n- Wrote it.\n' });
  const res = run(root, [path.join(FIX, 'library.md'), '--merge', '--write']);
  assert.equal(res.status, 0, res.stderr);
  const written = fs.readFileSync(target(root), 'utf8');
  assert.match(written, /\*\*Hero metrics:\*\* 3x faster/);
  assert.equal(parseLibrary(written).entries.length, 6);
});

test('given input that would make an invalid library, when run with --write, then it exits 1 and writes nothing', () => {
  const root = dataRoot();
  const file = input(root, 'bad.json', [{ name: 'No Points' }]);
  const res = run(root, [file, '--write']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"No Points".*no copy-paste points/);
  assert.equal(fs.existsSync(target(root)), false);
});

test('given malformed JSON or a non-projects shape, when run, then it exits 1 naming the problem', () => {
  const root = dataRoot();
  const broken = run(root, [input(root, 'broken.json', '{ not json')]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /broken\.json/);
  const shape = run(root, [input(root, 'shape.json', { basics: {} })]);
  assert.equal(shape.status, 1);
  assert.match(shape.stderr, /projects/);
});

test('given --dry-run with --write, a missing file or no file, when run, then it exits 1', () => {
  const root = dataRoot();
  assert.equal(run(root, [path.join(FIX, 'projects.json'), '--dry-run', '--write']).status, 1);
  assert.equal(run(root, [path.join(root, 'missing.json')]).status, 1);
  const none = run(root, []);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage/);
});
