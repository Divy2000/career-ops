import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLibrary,
  validateLibrary,
  serializeEntry,
  serializeLibrary,
  replaceEntry,
  appendEntry,
  convertJsonProjects,
} from '../lib.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LIBRARY = fs.readFileSync(path.join(FIX, 'library.md'), 'utf8');
const byId = (text, id) => parseLibrary(text).entries.find((e) => e.id === id);

test('given "## Title -- https://x" and three bullets, when parsed, then it has a title, URL, 3 bullets and kind project', () => {
  const e = byId(LIBRARY, 'ticket-triage-bot');
  assert.equal(e.title, 'Ticket Triage Bot');
  assert.equal(e.url, 'https://github.com/example-dev/ticket-triage');
  assert.equal(e.bullets.length, 3);
  assert.equal(e.bullets[2], 'Cut median first-response time from 9 h to 2 h.');
  assert.equal(e.kind, 'project');
  assert.deepEqual(e.tags, ['python', 'fastapi', 'rag', 'langchain']);
});

test('given "## [Title](url)", when parsed, then the link text is the title and the URL is extracted', () => {
  const e = byId(LIBRARY, 'weather-dashboard');
  assert.equal(e.title, 'Weather Dashboard');
  assert.equal(e.url, 'https://example.org/weather');
});

test('given "## Title -- [text](url)" or "## Title -- <url>", when parsed, then the URL is extracted', () => {
  const md = '## Alpha -- [repo](https://a.example)\n- One.\n\n## Beta -- <https://b.example>\n- Two.\n';
  const [a, b] = parseLibrary(md).entries;
  assert.equal(a.title, 'Alpha');
  assert.equal(a.url, 'https://a.example');
  assert.equal(b.title, 'Beta');
  assert.equal(b.url, 'https://b.example');
});

test('given a spaced em dash as the separator, when parsed, then it splits like " -- " but a spaced hyphen does not', () => {
  const md = '## Alpha \u2014 https://a.example\n- One.\n\n## Multi-agent - Planner\n- Two.\n';
  const [a, b] = parseLibrary(md).entries;
  assert.equal(a.title, 'Alpha');
  assert.equal(a.url, 'https://a.example');
  assert.equal(b.title, 'Multi-agent - Planner');
});

test('given "## Title -- tagline", when parsed, then the title is the text before the separator and the tagline is kept', () => {
  const e = byId(LIBRARY, 'inventory-forecaster');
  assert.equal(e.title, 'Inventory Forecaster');
  assert.equal(e.tagline, 'Demand planning for a campus store');
  assert.equal(e.url, null);
  assert.equal(e.dates, '2023-01 - 2023-05');
});

test('given an indented continuation line, when parsed, then it joins the bullet above it', () => {
  const e = byId(LIBRARY, 'inventory-forecaster');
  assert.deepEqual(e.bullets, ['Forecast weekly demand with Pandas, cutting stockouts by 30%. Presented the model to the store managers.']);
});

test('given an upstream digest block, when parsed, then its Proof-points bullets become the copy-paste bullets', () => {
  const e = byId(LIBRARY, 'graph-search-library');
  assert.deepEqual(e.bullets, [
    'Implemented Dijkstra and A* search in Java with 95% test coverage.',
    'Benchmarked against 5 public road-network datasets.',
  ]);
});

test('given "Kind: publication", when parsed, then the kind is publication', () => {
  assert.equal(byId(LIBRARY, 'retrieval-benchmark-study').kind, 'publication');
});

test('given a "## " line inside a code fence, when parsed, then it does not start a new entry', () => {
  const md = '## Alpha\n- One.\n\n```\n## not a heading\n```\n';
  const { entries } = parseLibrary(md);
  assert.equal(entries.length, 1);
});

test('given the sample library, when validated, then it is ok with no errors', () => {
  const v = validateLibrary(LIBRARY);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test('given two titles that normalize the same, when validated, then an error names both', () => {
  const md = '## Ticket Triage Bot\n- One.\n\n---\n\n## ticket-triage  bot\n- Two.\n';
  const v = validateLibrary(md);
  assert.equal(v.ok, false);
  const dup = v.errors.find((e) => /duplicate/i.test(e));
  assert.ok(dup, v.errors.join('\n'));
  assert.match(dup, /"Ticket Triage Bot"/);
  assert.match(dup, /"ticket-triage {2}bot"/);
});

test('given a project with no bullets, when validated, then an error says it has no copy-paste points', () => {
  const v = validateLibrary('## Empty Project -- https://e.example\nTags: go\n');
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /"Empty Project".*no copy-paste points/);
});

test('given a publication with no bullets, when validated, then it is not an error', () => {
  const v = validateLibrary('## Some Paper\nKind: publication\n');
  assert.deepEqual(v.errors, []);
});

test('given more than 6 bullets, when validated, then a warning is given; more than 8 is an error', () => {
  const bullets = (n) => Array.from({ length: n }, (_, i) => `- Point ${i + 1}.`).join('\n');
  const seven = validateLibrary(`## Seven\n${bullets(7)}\n`);
  assert.equal(seven.ok, true);
  assert.match(seven.warnings.join('\n'), /"Seven".*7 bullets/);
  const nine = validateLibrary(`## Nine\n${bullets(9)}\n`);
  assert.equal(nine.ok, false);
  assert.match(nine.errors.join('\n'), /"Nine".*9 bullets/);
});

test('given a javascript: link, when validated, then an error is reported and the URL is dropped', () => {
  const md = '## Sneaky -- javascript:alert(1)\n- One.\n\n## [Other](javascript:alert(2))\n- Two.\n';
  const { entries } = parseLibrary(md);
  assert.equal(entries[0].title, 'Sneaky');
  assert.equal(entries[0].url, null);
  assert.equal(entries[1].url, null);
  const v = validateLibrary(md);
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /"Sneaky".*http\(s\)/);
  assert.match(v.errors.join('\n'), /"Other".*http\(s\)/);
});

test('given an unknown kind, when validated, then an error lists the allowed kinds', () => {
  const v = validateLibrary('## Thing\nKind: hobby\n- One.\n');
  assert.equal(v.ok, false);
  assert.match(v.errors.join('\n'), /"Thing".*hobby.*project, publication, article/);
});

test('given an entry, when serialized and parsed back, then every field survives', () => {
  const entry = {
    title: 'Ticket Triage Bot',
    url: 'https://github.com/example-dev/ticket-triage',
    tags: ['python', 'rag'],
    kind: 'project',
    dates: '2024-02 - 2024-06',
    bullets: ['First point.', 'Second point.'],
  };
  const md = serializeEntry(entry);
  assert.equal(md, [
    '## Ticket Triage Bot -- https://github.com/example-dev/ticket-triage',
    'Tags: python, rag',
    'Dates: 2024-02 - 2024-06',
    '- First point.',
    '- Second point.',
  ].join('\n'));
  const back = parseLibrary(md).entries[0];
  assert.deepEqual(
    { title: back.title, url: back.url, tags: back.tags, kind: back.kind, dates: back.dates, bullets: back.bullets },
    entry,
  );
});

test('given a non-project kind and a tagline with a URL, when serialized, then Kind is written and the link form keeps both', () => {
  const md = serializeEntry({ title: 'Old Paper', url: 'https://p.example', tagline: 'Journal version', kind: 'publication', bullets: ['A.'] });
  assert.equal(md, '## [Old Paper](https://p.example) -- Journal version\nKind: publication\n- A.');
  const back = parseLibrary(md).entries[0];
  assert.equal(back.title, 'Old Paper');
  assert.equal(back.url, 'https://p.example');
  assert.equal(back.tagline, 'Journal version');
});

test('given multi-line text in a bullet, when serialized, then it stays on one line', () => {
  const md = serializeEntry({ title: 'X', bullets: ['line one\n## injected heading'] });
  assert.equal(parseLibrary(md).entries.length, 1);
  assert.deepEqual(parseLibrary(md).entries[0].bullets, ['line one ## injected heading']);
});

test('given a title that cannot round-trip or a non-http(s) URL, when serialized, then it throws', () => {
  assert.throws(() => serializeEntry({ title: 'A -- B', bullets: ['x'] }), /title/);
  assert.throws(() => serializeEntry({ title: '  ', bullets: ['x'] }), /title/);
  assert.throws(() => serializeEntry({ title: 'A', url: 'javascript:alert(1)', bullets: ['x'] }), /http\(s\)/);
});

test('given a file with other content, when one entry is replaced, then all other bytes are unchanged', () => {
  const target = byId(LIBRARY, 'weather-dashboard');
  const block = LIBRARY.slice(target.start, target.end);
  const replacement = { title: 'Weather Dashboard', url: 'https://example.org/weather-v2', tags: ['react'], bullets: ['Rebuilt it.'] };
  const out = replaceEntry(LIBRARY, 'weather-dashboard', replacement);
  const before = LIBRARY.slice(0, target.start);
  const after = LIBRARY.slice(target.end);
  assert.ok(block.length > 0);
  assert.ok(out.startsWith(before));
  assert.ok(out.endsWith(after));
  assert.equal(out, before + serializeEntry(replacement) + after);
});

test('given the last entry, when replaced, then the trailing newline is kept', () => {
  const out = replaceEntry(LIBRARY, 'retrieval-benchmark-study', { title: 'Retrieval Benchmark Study', kind: 'publication', bullets: ['Shorter.'] });
  assert.ok(out.endsWith('Kind: publication\n- Shorter.\n'));
});

test('given an unknown id or a rename onto another title, when replaced, then it throws', () => {
  assert.throws(() => replaceEntry(LIBRARY, 'nope', { title: 'X', bullets: ['a'] }), /nope/);
  assert.throws(() => replaceEntry(LIBRARY, 'weather-dashboard', { title: 'Ticket Triage Bot', bullets: ['a'] }), /already/);
});

test('given an existing library, when an entry is appended, then it follows a --- separator and the old text is untouched', () => {
  const out = appendEntry(LIBRARY, { title: 'New Thing', bullets: ['Did it.'] });
  assert.equal(out, `${LIBRARY.replace(/\s+$/, '')}\n\n---\n\n## New Thing\n- Did it.\n`);
});

test('given an empty file, when an entry is appended, then a library header is created', () => {
  const out = appendEntry('', { title: 'First', bullets: ['One.'] });
  assert.equal(out, '# Projects library\n\n## First\n- One.\n');
});

test('given a duplicate title, when appended, then it throws', () => {
  assert.throws(() => appendEntry(LIBRARY, { title: 'ticket triage BOT', bullets: ['x'] }), /already/);
});

test('given a projects.json entry, when converted, then it becomes a "## Name -- url" block with Tags and bullets = description then highlights', () => {
  const data = JSON.parse(fs.readFileSync(path.join(FIX, 'projects.json'), 'utf8'));
  const { entries, warnings } = convertJsonProjects(data);
  assert.deepEqual(warnings, []);
  assert.equal(serializeEntry(entries[0]), [
    '## Ticket Triage Bot -- https://github.com/example-dev/ticket-triage',
    'Tags: python, fastapi, rag',
    '- Built a FastAPI service that routes support tickets with a RAG clasifier.',
    '- Cut median first-response time from 9 h to 2 h.',
  ].join('\n'));
  assert.equal(serializeEntry(entries[1]), '## Weather Dashboard\nTags: react\n- Built a React dashboard showing hourly forecasts.');
});

test('given a JSON Resume projects array or whole resume, when converted, then the result is the same shape with dates', () => {
  const resume = JSON.parse(fs.readFileSync(path.join(FIX, 'resume.json'), 'utf8'));
  const expected = [
    '## Ticket Triage Bot -- https://github.com/example-dev/ticket-triage',
    'Tags: python, fastapi, rag',
    'Dates: 2024-02 - 2024-06',
    '- Built a FastAPI service that routes support tickets with a RAG clasifier.',
    '- Cut median first-response time from 9 h to 2 h.',
  ].join('\n');
  assert.equal(serializeEntry(convertJsonProjects(resume).entries[0]), expected);
  assert.equal(serializeEntry(convertJsonProjects(resume.projects).entries[0]), expected);
});

test('given a JSON Resume project with only a start date, when converted, then it is shown as ongoing', () => {
  const { entries } = convertJsonProjects([{ name: 'Ongoing', description: 'Still going.', startDate: '2025-01' }]);
  assert.equal(entries[0].dates, '2025-01 - Present');
});

test('given a non-http(s) url or a name with a heading separator, when converted, then it is fixed and a warning says so', () => {
  const { entries, warnings } = convertJsonProjects([
    { name: 'Alpha -- Beta', url: 'ftp://files.example/x', description: 'Thing.' },
  ]);
  assert.equal(entries[0].title, 'Alpha - Beta');
  assert.equal(entries[0].url, null);
  assert.match(warnings.join('\n'), /Alpha -- Beta.*ftp:\/\/files\.example\/x/);
  assert.match(warnings.join('\n'), /Alpha -- Beta.*renamed/);
});

test('given input that is not a projects list or an item without a name, when converted, then it throws naming the problem', () => {
  assert.throws(() => convertJsonProjects({ basics: {} }), /projects/);
  assert.throws(() => convertJsonProjects([{ description: 'x' }]), /projects\[0\].*name/);
  assert.throws(() => convertJsonProjects([{ name: 'A', highlights: 'not a list' }]), /projects\[0\].*highlights/);
});

test('given converted entries, when serialized as a library, then blocks are separated by --- under a header', () => {
  const out = serializeLibrary([{ title: 'A', bullets: ['a.'] }, { title: 'B', bullets: ['b.'] }]);
  assert.equal(out, '# Projects library\n\n## A\n- a.\n\n---\n\n## B\n- b.\n');
  assert.equal(validateLibrary(out).ok, true);
});
