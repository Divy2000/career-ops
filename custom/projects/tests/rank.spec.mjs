import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLibrary, rankProjects } from '../lib.mjs';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const RANK = path.join(HERE, '..', 'rank.mjs');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const LIBRARY = read('library.md');
const CV = read('cv-sample.md');
const JD = read('jd-rag.md');
const entries = parseLibrary(LIBRARY).entries;
const rank = (jdText, cvText = CV, list = entries) => rankProjects(list, { jdText, cvText });

const dataRoot = ({ library = LIBRARY, cv = CV } = {}) => {
  const d = tempDir('projects-rank-');
  if (library !== null) fs.writeFileSync(path.join(d, 'article-digest.md'), library);
  if (cv !== null) fs.writeFileSync(path.join(d, 'cv.md'), cv);
  fs.mkdirSync(path.join(d, 'jds'));
  fs.writeFileSync(path.join(d, 'jds', 'role.md'), JD);
  return d;
};
const run = (root, args, cwd = root) => {
  const env = { ...process.env, CAREER_OPS_ROOT: root };
  delete env.CAREER_OPS_DATA_DIR;
  return spawnSync(process.execPath, [RANK, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
};

test('given a JD asking for RAG and LangChain, when ranked, then the RAG project is first with both skills matched', () => {
  const r = rank(JD);
  assert.equal(r.candidates[0].id, 'ticket-triage-bot');
  assert.ok(r.candidates[0].matchedSkills.includes('RAG'));
  assert.ok(r.candidates[0].matchedSkills.includes('LangChain'));
  assert.equal(r.recommended[0], 'ticket-triage-bot');
});

test('given a candidate, when ranked, then it carries id, title, url, kind, inCv, score, matchedSkills and bullets', () => {
  const c = rank(JD).candidates.find((x) => x.id === 'weather-dashboard');
  assert.deepEqual(Object.keys(c).sort(), ['bullets', 'id', 'inCv', 'kind', 'matchedSkills', 'score', 'title', 'url']);
  assert.equal(c.url, 'https://example.org/weather');
  assert.equal(c.kind, 'project');
  assert.deepEqual(c.matchedSkills, ['React']);
  assert.equal(c.bullets.length, 2);
});

test('given title, tag and bullet matches, when scored, then title counts 3, tags 2 and bullets 1', () => {
  const md = [
    '## React Widget\n- Plain words.',
    '## Second\nTags: react\n- Plain words.',
    '## Third\n- Built with React.',
  ].join('\n\n');
  const r = rank('We use React.', '', parseLibrary(md).entries);
  assert.deepEqual(r.candidates.map((c) => [c.id, c.score]), [['react-widget', 3], ['second', 2], ['third', 1]]);
});

test('given a tag outside the skill vocabulary that the JD names, when scored, then it counts as a keyword match', () => {
  const md = '## Forecast Tool\nTags: forecasting\n- Plain words.';
  const r = rank('Experience with demand forecasting is a plus.', '', parseLibrary(md).entries);
  assert.equal(r.candidates[0].score, 2);
  assert.deepEqual(r.candidates[0].matchedSkills, ['forecasting']);
});

test('given case variants of the same keyword tag, when scored, then the keyword counts once', () => {
  const md = '## Tool\nTags: Foo, foo, FOO\n- Plain words.';
  const r = rank('We like foo.', '', parseLibrary(md).entries);
  assert.equal(r.candidates[0].score, 2);
  assert.deepEqual(r.candidates[0].matchedSkills, ['Foo']);
});

test('given a publication entry that matches perfectly, when ranked, then it is excluded and never recommended', () => {
  const r = rank(JD);
  assert.ok(!r.candidates.some((c) => c.id === 'retrieval-benchmark-study'));
  assert.ok(!r.recommended.includes('retrieval-benchmark-study'));
  assert.deepEqual(r.excluded, [{ id: 'retrieval-benchmark-study', title: 'Retrieval Benchmark Study', kind: 'publication' }]);
});

test('given a third project scoring under 60% of the top, when ranked, then exactly 2 are recommended', () => {
  const r = rank(JD);
  const third = r.candidates[2];
  assert.ok(third.score > 0 && third.score < 0.6 * r.candidates[0].score, JSON.stringify(r.candidates));
  assert.deepEqual(r.recommended, ['ticket-triage-bot', 'weather-dashboard']);
});

test('given third and fourth projects at 60% of the top or more, when ranked, then up to 4 are recommended', () => {
  const md = ['## A\nTags: python, rag\n- x.', '## B\nTags: python, rag\n- x.', '## C\nTags: python, rag\n- x.', '## D\nTags: python\n- x.', '## E\nTags: python, rag\n- x.'].join('\n\n');
  const r = rank('Python and RAG.', '', parseLibrary(md).entries);
  assert.deepEqual(r.recommended, ['a', 'b', 'c', 'e']);
});

test('given a project with no overlap, when ranked, then it is never recommended', () => {
  const r = rank('We need Java engineers.');
  assert.deepEqual(r.recommended, ['graph-search-library']);
  const none = rank('We need Elixir engineers.');
  assert.deepEqual(none.recommended, []);
  assert.ok(none.candidates.every((c) => c.score === 0));
});

test('given a skill missing from cv.md but present in a library project, when ranked, then libraryCoverage maps it to that project', () => {
  const r = rank(JD);
  assert.deepEqual(r.libraryCoverage, { LangChain: ['ticket-triage-bot'] });
});

test('given a project title that is in cv.md, when ranked, then inCv is true', () => {
  const r = rank(JD);
  const inCv = Object.fromEntries(r.candidates.map((c) => [c.id, c.inCv]));
  assert.equal(inCv['ticket-triage-bot'], true);
  assert.equal(inCv['graph-search-library'], true);
  assert.equal(inCv['weather-dashboard'], false);
});

test('given the same input twice, when ranked by the CLI, then the output is identical', () => {
  const root = dataRoot();
  const a = run(root, ['jds/role.md', '--json']);
  const b = run(root, ['jds/role.md', '--json']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  const out = JSON.parse(a.stdout);
  assert.deepEqual(Object.keys(out), ['recommended', 'candidates', 'excluded', 'libraryCoverage']);
  assert.deepEqual(out.recommended, ['ticket-triage-bot', 'weather-dashboard']);
});

test('given a JD path relative to the data root, when run from another directory, then it is found there', () => {
  const root = dataRoot();
  const res = run(root, ['jds/role.md', '--json'], os.tmpdir());
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).recommended[0], 'ticket-triage-bot');
});

test('given --summary, when run, then it prints a readable ranking naming the recommended projects', () => {
  const res = run(dataRoot(), ['jds/role.md', '--summary']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Recommended: Ticket Triage Bot, Weather Dashboard/);
  assert.match(res.stdout, /Retrieval Benchmark Study \(publication\)/);
  assert.match(res.stdout, /LangChain: Ticket Triage Bot/);
});

test('given a valid library, when run with --check, then it exits 0 and reports the entry count', () => {
  const res = run(dataRoot(), ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /5 entries \(4 projects\)/);
});

test('given an invalid library, when run with --check, then it exits 1 and names the error', () => {
  const res = run(dataRoot({ library: '## Empty\nTags: go\n' }), ['--check']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"Empty".*no copy-paste points/);
});

test('given an invalid library, when ranking, then it exits 1 and points at --check', () => {
  const res = run(dataRoot({ library: '## Empty\nTags: go\n' }), ['jds/role.md', '--json']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--check/);
  assert.equal(res.stdout, '');
});

test('given no article-digest.md, when run, then it exits 1 naming the data-root path', () => {
  const root = dataRoot({ library: null });
  for (const args of [['jds/role.md', '--json'], ['--check']]) {
    const res = run(root, args);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(path.join(root, 'article-digest.md')), res.stderr);
  }
});

test('given a missing JD file or no JD argument, when run, then it exits 1 with usage', () => {
  const root = dataRoot();
  assert.equal(run(root, ['jds/missing.md']).status, 1);
  const res = run(root, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage/);
});

test('given an unknown flag or a flag with a value, when run, then it exits non-zero', () => {
  const root = dataRoot();
  assert.notEqual(run(root, ['jds/role.md', '--top=3']).status, 0);
  assert.notEqual(run(root, ['jds/role.md', '--json', '--summary']).status, 0);
});
