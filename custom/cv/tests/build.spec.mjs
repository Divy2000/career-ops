import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizePayload, checkPayload, recentAchievements } from '../lib.mjs';
import { HERE, REPO, loadFixture, cvMarkdownFor, dataRoot, envFor } from './helpers.mjs';

const BUILD = path.join(HERE, '..', 'build-html.mjs');
const PAPER_CV = [
  '## Projects', '',
  '- **Material Search Engine** -- Built a search engine for materials data.', '',
  '## Recent Achievements', '',
  '- **Artificial Intelligence Powered Material Search Engine** -- Materials Letters, 2022 (https://doi.org/10.1000/example.1)',
  '- **First Place, Campus Hackathon** -- Example University, 2023', '',
].join('\n');
const LIBRARY = [
  '# Projects library', '',
  '## Ticket Triage Bot -- https://github.com/example-dev/ticket-triage', '- Built a triage bot.', '',
  '## Old Research Work', 'Kind: publication', '- Wrote a paper.', '',
].join('\n');

const build = (root, payload) => {
  const input = path.join(root, 'payload.json');
  const output = path.join(root, 'output', 'cv.html');
  fs.writeFileSync(input, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [BUILD, input, output], { cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 30000 });
  return { ...r, output, html: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null };
};

test('given a project with a description and bullets, when normalized, then the description becomes the first bullet', () => {
  const out = normalizePayload({ projects: [{ name: 'A', description: 'First.', bullets: ['Second.'] }, { name: 'B', description: 'Only.' }] });
  assert.deepEqual(out.projects, [{ name: 'A', bullets: ['First.', 'Second.'] }, { name: 'B', bullets: ['Only.'] }]);
});

test('given no sections.awards, when normalized, then the awards title is "Recent Achievements"; a given title is kept', () => {
  assert.equal(normalizePayload({}).sections.awards, 'Recent Achievements');
  assert.equal(normalizePayload({ sections: { awards: 'Honors', skills: 'Tools' } }).sections.awards, 'Honors');
  assert.equal(normalizePayload({ sections: { skills: 'Tools' } }).sections.skills, 'Tools');
});

test('given a payload, when normalized, then the input object is not mutated', () => {
  const input = { projects: [{ name: 'A', description: 'x', bullets: ['y'] }] };
  normalizePayload(input);
  assert.deepEqual(input, { projects: [{ name: 'A', description: 'x', bullets: ['y'] }] });
});

test('given cv.md, when reading Recent Achievements, then each entry carries its title and links', () => {
  const entries = recentAchievements(PAPER_CV);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'Artificial Intelligence Powered Material Search Engine');
  assert.deepEqual(entries[0].urls, ['https://doi.org/10.1000/example.1']);
});

test('given a project whose title is listed in Recent Achievements, when checked, then it is an error', () => {
  const r = checkPayload({ projects: [{ name: 'Material Search Engine', bullets: ['x'] }] }, { cvText: PAPER_CV, libraryText: null });
  assert.match(r.errors.join('\n'), /"Material Search Engine".*Recent Achievements/);
});

test('given a project whose URL matches a Recent Achievements link, when checked, then it is an error', () => {
  const cv = `${PAPER_CV}\n## Projects\n\n- **Search Tool** -- x\n`;
  const r = checkPayload({ projects: [{ name: 'Search Tool', url: 'https://doi.org/10.1000/example.1/', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
  assert.match(r.errors.join('\n'), /"Search Tool".*Recent Achievements/);
});

test('given a library entry whose kind is not project, when used as a project, then it is an error', () => {
  const r = checkPayload({ projects: [{ name: 'Old Research Work', bullets: ['x'] }] }, { cvText: '', libraryText: LIBRARY });
  assert.match(r.errors.join('\n'), /"Old Research Work".*publication/);
});

test('given a project in neither the library nor cv.md, when checked, then it is an error', () => {
  const r = checkPayload({ projects: [{ name: 'Invented Thing', bullets: ['x'] }] }, { cvText: PAPER_CV, libraryText: LIBRARY });
  assert.match(r.errors.join('\n'), /"Invented Thing".*neither article-digest\.md nor cv\.md/);
});

test('given projects found in the library or in cv.md, when checked, then there is no error', () => {
  const r = checkPayload({ projects: [{ name: 'ticket triage bot', bullets: ['x'] }] }, { cvText: PAPER_CV, libraryText: LIBRARY });
  assert.deepEqual(r.errors, []);
  const cvOnly = checkPayload({ projects: [{ name: 'Graph Tool', bullets: ['x'] }] }, { cvText: '## Projects\n\n- **Graph Tool** -- x\n', libraryText: null });
  assert.deepEqual(cvOnly.errors, []);
});

test('given a project linking to a publisher host, when checked, then it is a warning, not an error', () => {
  const cv = '## Projects\n\n- **Graph Tool** -- x\n';
  for (const url of ['https://doi.org/10.1/x', 'https://www.sciencedirect.com/science/article/x', 'https://onlinelibrary.wiley.com/doi/x', 'https://arxiv.org/abs/2401.00001']) {
    const r = checkPayload({ projects: [{ name: 'Graph Tool', url, bullets: ['x'] }] }, { cvText: cv, libraryText: null });
    assert.deepEqual(r.errors, [], url);
    assert.match(r.warnings.join('\n'), /"Graph Tool".*publisher/, url);
  }
});

test('given a project whose title is listed in Recent Achievements, when built, then the command fails and no HTML is written', () => {
  const root = dataRoot({ cv: PAPER_CV });
  const payload = { ...loadFixture(), projects: [{ name: 'Material Search Engine', bullets: ['Built a search engine for materials data.'] }] };
  const r = build(root, payload);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Recent Achievements/);
  assert.equal(r.html, null);
});

test('given a project in neither the library nor cv.md, when built, then it fails and no HTML is written', () => {
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const r = build(root, { ...fixture, projects: [{ name: 'Invented Thing', bullets: ['x'] }] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invented Thing/);
  assert.equal(r.html, null);
});

test('given no sections.awards, when built, then the awards section is titled "Recent Achievements" and uses the fork template', () => {
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const r = build(root, fixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.html, /class="section-title">Recent Achievements</);
  assert.match(r.html, /html\[data-density="3"\]/);
});

test('given a project with a description and two bullets, when built, then it renders as three list items', () => {
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const r = build(root, { ...fixture, projects: [fixture.projects[0]] });
  assert.equal(r.status, 0, r.stderr);
  const project = r.html.match(/<div class="project">[\s\S]*?<\/ul>/)[0];
  assert.equal((project.match(/<li>/g) ?? []).length, 3);
  assert.match(project, /<li>Built a RAG question-answering service/);
});

test('given an invalid payload for the upstream builder, when built, then its error and exit code pass through', () => {
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const r = build(root, { ...fixture, publications: [{ title: 'x' }], experience: 'not a list' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /experience/);
  assert.equal(r.html, null);
});

test('given missing arguments or an unknown flag, when run, then it exits non-zero with usage', () => {
  const r = spawnSync(process.execPath, [BUILD], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
  const flag = spawnSync(process.execPath, [BUILD, 'a.json', 'b.html', '--template=x'], { cwd: REPO, encoding: 'utf8' });
  assert.notEqual(flag.status, 0);
});
