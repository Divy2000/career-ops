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
  const r = checkPayload({ projects: [{ name: 'artificial intelligence powered material-search engine', bullets: ['x'] }] }, { cvText: PAPER_CV, libraryText: null });
  assert.match(r.errors.join('\n'), /"artificial intelligence powered material-search engine".*Recent Achievements/);
});

test('given a distinct project whose title is only part of a paper title, when checked, then it is not rejected', () => {
  const cv = [
    '## Projects', '', '- **Material Search Engine** -- Built a search engine for materials data.', '',
    '## Recent Achievements', '', '- **High-Performance Search Engine for Medical Literature** -- Example Journal, 2024', '',
  ].join('\n');
  const library = '## Search Engine -- https://github.com/example-dev/search\n- Built a search engine.\n';
  for (const name of ['Search Engine', 'Material Search Engine']) {
    const r = checkPayload({ projects: [{ name, bullets: ['x'] }] }, { cvText: cv, libraryText: library });
    assert.deepEqual(r.errors, [], name);
  }
});

test('given a project whose URL matches a Recent Achievements link, when checked, then it is an error', () => {
  const cv = `${PAPER_CV}\n## Projects\n\n- **Search Tool** -- x\n`;
  const r = checkPayload({ projects: [{ name: 'Search Tool', url: 'https://doi.org/10.1000/example.1/', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
  assert.match(r.errors.join('\n'), /"Search Tool".*Recent Achievements/);
});

test('given a project whose URL matches a bare (scheme-less) Recent Achievements link, when checked, then it is an error (R11-scripts-a-X-01)', () => {
  const cv = [
    '## Projects', '', '- **Search Tool** (doi.org/10.1000/example.2) -- x', '',
    '## Recent Achievements', '', '- **A Differently Titled Paper** -- Materials Letters, 2022 (doi.org/10.1000/example.2)', '',
  ].join('\n');
  assert.deepEqual(recentAchievements(cv)[0].urls, ['doi.org/10.1000/example.2']);
  const r = checkPayload({ projects: [{ name: 'Search Tool', url: 'https://doi.org/10.1000/example.2', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
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
  for (const url of ['https://doi.org/10.1/x', 'https://www.sciencedirect.com/science/article/x', 'https://onlinelibrary.wiley.com/doi/x', 'https://arxiv.org/abs/2401.00001']) {
    const cv = `## Projects\n\n- **Graph Tool** (${url}) -- x\n`;
    const r = checkPayload({ projects: [{ name: 'Graph Tool', url, bullets: ['x'] }] }, { cvText: cv, libraryText: null });
    assert.deepEqual(r.errors, [], url);
    assert.match(r.warnings.join('\n'), /"Graph Tool".*publisher/, url);
  }
});

test('given a payload URL that differs from the library entry, when checked, then it is an error naming both', () => {
  const r = checkPayload({ projects: [{ name: 'Ticket Triage Bot', url: 'https://github.com/someone-else/triage', bullets: ['x'] }] }, { cvText: '', libraryText: LIBRARY });
  assert.match(r.errors.join('\n'), /"Ticket Triage Bot".*someone-else\/triage.*github\.com\/example-dev\/ticket-triage/);
});

test('given a payload URL for a source that has no link, when checked, then it is an error (a link cannot be invented)', () => {
  const library = '## Quiet Project\n- Did it.\n';
  const fromLibrary = checkPayload({ projects: [{ name: 'Quiet Project', url: 'https://example.org/q', bullets: ['x'] }] }, { cvText: '', libraryText: library });
  assert.match(fromLibrary.errors.join('\n'), /"Quiet Project".*no link/);
  const fromCv = checkPayload({ projects: [{ name: 'Graph Tool', url: 'https://example.org/g', bullets: ['x'] }] }, { cvText: '## Projects\n\n- **Graph Tool** -- x\n', libraryText: null });
  assert.match(fromCv.errors.join('\n'), /"Graph Tool".*no link/);
});

test('given the same link spelled differently, or no payload link, when checked, then there is no error', () => {
  for (const url of ['https://github.com/example-dev/ticket-triage', 'http://www.github.com/example-dev/ticket-triage/', undefined]) {
    const r = checkPayload({ projects: [{ name: 'Ticket Triage Bot', url, bullets: ['x'] }] }, { cvText: '', libraryText: LIBRARY });
    assert.deepEqual(r.errors, [], String(url));
  }
});

test('given a cv.md project whose link is written without a scheme, when the payload uses the full URL, then it matches', () => {
  const cv = '## Projects\n\n- **Graph Tool** (github.com/example-dev/graph-tool) -- x\n';
  const ok = checkPayload({ projects: [{ name: 'Graph Tool', url: 'https://github.com/example-dev/graph-tool', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
  assert.deepEqual(ok.errors, []);
  const bad = checkPayload({ projects: [{ name: 'Graph Tool', url: 'https://github.com/example-dev/other', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
  assert.match(bad.errors.join('\n'), /"Graph Tool".*does not match/);
});

test('given a cv.md project whose link is on a body or continuation line, when the payload uses it, then it matches', () => {
  const url = 'https://github.com/me/graph-tool';
  const headed = '## Projects\n\n### Graph Tool\nRepo: https://github.com/me/graph-tool\n- Built it.\n\n### Other\nhttps://github.com/me/other\n';
  const continued = '## Projects\n\n- **Graph Tool** -- Built it.\n  Repo: github.com/me/graph-tool\n- **Other** -- https://github.com/me/other\n';
  for (const cv of [headed, continued]) {
    assert.deepEqual(checkPayload({ projects: [{ name: 'Graph Tool', url, bullets: ['x'] }] }, { cvText: cv, libraryText: null }).errors, [], cv);
    // A link that belongs to the next entry is not this project's link.
    const other = checkPayload({ projects: [{ name: 'Graph Tool', url: 'https://github.com/me/other', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
    assert.match(other.errors.join('\n'), /"Graph Tool".*does not match/, cv);
  }
});

test('given a project in both the library and cv.md, when checked, then the library link is authoritative', () => {
  const cv = '## Projects\n\n- **Ticket Triage Bot** (github.com/old/triage) -- x\n';
  const r = checkPayload({ projects: [{ name: 'Ticket Triage Bot', url: 'https://github.com/old/triage', bullets: ['x'] }] }, { cvText: cv, libraryText: LIBRARY });
  assert.match(r.errors.join('\n'), /"Ticket Triage Bot".*does not match.*article-digest\.md/);
});

test('given a project whose title is listed in Recent Achievements, when built, then the command fails and no HTML is written', () => {
  const root = dataRoot({ cv: PAPER_CV });
  const payload = { ...loadFixture(), projects: [{ name: 'Artificial Intelligence Powered Material Search Engine', bullets: ['Built a search engine for materials data.'] }] };
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

test('given a project named after an employer, a role, a section or a skill category in cv.md, when checked, then it is an error: only the Projects section is a project source (R11-scripts-a-L3-02)', () => {
  const cv = cvMarkdownFor(loadFixture());
  for (const name of ['Software Engineer', 'Northwind Devices', 'Work Experience', 'Languages']) {
    assert.ok(cv.includes(name), `the fixture cv.md lists ${name}`);
    const r = checkPayload({ projects: [{ name, bullets: ['Built an internal tool'] }] }, { cvText: cv, libraryText: null });
    assert.match(r.errors.join('\n'), new RegExp(`project "${name}" is in neither article-digest\\.md nor cv\\.md`), name);
  }
});

test('given a project under a level-3 heading of a Personal Projects section, when checked, then its cv.md link is used (R11-scripts-a-L3-02)', () => {
  const cv = '## Work Experience\n\n### Graph Co -- Austin\n\n- built github.com/me/work\n\n## Personal Projects\n\n### Graph Tool\n\n- see github.com/me/graph-tool\n\n## Skills\n';
  assert.deepEqual(checkPayload({ projects: [{ name: 'Graph Tool', url: 'https://github.com/me/graph-tool', bullets: ['x'] }] }, { cvText: cv, libraryText: null }).errors, []);
  assert.match(checkPayload({ projects: [{ name: 'Graph Co', bullets: ['x'] }] }, { cvText: cv, libraryText: null }).errors.join('\n'), /"Graph Co" is in neither/);
});

test('given an entry under a section that is about something else but names projects (Project Management), when checked, then it is not a project source (R11-scripts-a-L3-02 review)', () => {
  for (const title of ['Project Management', 'Projects & Publications']) {
    const cv = `## ${title}\n\n### Secret Tool\n- https://github.com/me/tool\n\n## Skills\n`;
    const r = checkPayload({ projects: [{ name: 'Secret Tool', url: 'https://github.com/me/tool', bullets: ['x'] }] }, { cvText: cv, libraryText: null });
    assert.match(r.errors.join('\n'), /"Secret Tool" is in neither/, title);
  }
  // A CV with a single project may title its section in the singular.
  for (const title of ['Projects', 'Selected Projects', 'Side-Projects', 'Project']) {
    const cv = `## ${title}\n\n### Secret Tool\n- https://github.com/me/tool\n\n## Skills\n`;
    assert.deepEqual(checkPayload({ projects: [{ name: 'Secret Tool', url: 'https://github.com/me/tool', bullets: ['x'] }] }, { cvText: cv, libraryText: null }).errors, [], title);
  }
});

test('given a project named after a job title in cv.md, when built, then it fails and no HTML is written (R11-scripts-a-L3-02)', () => {
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const r = build(root, { ...fixture, projects: [{ name: 'Software Engineer', bullets: ['Built an internal tool'] }] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /project "Software Engineer" is in neither article-digest\.md nor cv\.md/);
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
  // A payload that builds without the flag, so only the flag check can fail the run (R11-tests-custom-L3-03).
  const fixture = loadFixture();
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const input = path.join(root, 'payload.json');
  const output = path.join(root, 'output', 'cv.html');
  fs.writeFileSync(input, JSON.stringify(fixture));
  const flag = spawnSync(process.execPath, [BUILD, input, output, '--template=x'], { cwd: REPO, env: envFor(root), encoding: 'utf8' });
  assert.equal(flag.status, 1, flag.stderr);
  assert.match(flag.stderr, /unrecognized flag\(s\): --template=x/);
  assert.equal(fs.existsSync(output), false, 'no HTML is written');
  assert.equal(build(root, fixture).status, 0, 'the same payload builds without the flag');
});
