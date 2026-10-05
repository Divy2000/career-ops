import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  versionAtLeast, mergeLocalPaths, uniqueDestName, normalizeMarkdown, normalizeRepoUrl, sameRepo,
  summarizeUnifiedDiff, parseDoctorState, interactiveOnboardPrompt, renderHeadlessPrompt,
  validateMarkdownInput, validateInputs, LIMITS, insertHouseRule, validateProjectsInput,
} from '../lib.mjs';
import { tempDir } from '../../test-support/tmp.mjs';

const tmp = () => tempDir('ci-lib-');
const write = (dir, name, data) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
};

test('versionAtLeast compares numerically, not lexically', () => {
  assert.equal(versionAtLeast('v22.6.0', '22.6.0'), true);
  assert.equal(versionAtLeast('26.4.0', '22.6.0'), true);
  assert.equal(versionAtLeast('v22.5.9', '22.6.0'), false);
  assert.equal(versionAtLeast('v9.99.0', '22.6.0'), false);
  assert.equal(versionAtLeast('v22.10.0', '22.6.0'), true);
  assert.equal(versionAtLeast('v20.0.0', '22.6.0'), false);
});

test('mergeLocalPaths appends custom/ once and keeps every other line', () => {
  const original = '# mine\nrun-nightly.ps1\n\nqa/\n';
  const merged = mergeLocalPaths(original);
  assert.equal(merged, '# mine\nrun-nightly.ps1\n\nqa/\ncustom/\n');
  assert.equal(mergeLocalPaths(merged), null);
});

test('mergeLocalPaths adds a newline before appending when the file lacks one, and creates a file from nothing', () => {
  assert.equal(mergeLocalPaths('qa/'), 'qa/\ncustom/\n');
  assert.match(mergeLocalPaths(''), /^# .*\ncustom\/\n$/s);
});

test('mergeLocalPaths does not treat a commented custom/ line as present', () => {
  assert.equal(mergeLocalPaths('# custom/\n'), '# custom/\ncustom/\n');
});

test('uniqueDestName keeps a free name and suffixes -1, -2 before the extension', () => {
  assert.equal(uniqueDestName('resume.md', new Set()), 'resume.md');
  assert.equal(uniqueDestName('resume.md', new Set(['resume.md'])), 'resume-1.md');
  assert.equal(uniqueDestName('resume.md', new Set(['resume.md', 'resume-1.md'])), 'resume-2.md');
  assert.equal(uniqueDestName('notes.markdown', new Set(['notes.markdown'])), 'notes-1.markdown');
});

test('normalizeMarkdown strips a BOM, converts CRLF and CR to LF, and ends with exactly one newline', () => {
  assert.equal(normalizeMarkdown('﻿# A\r\nline\rend\r\n\r\n\r\n'), '# A\nline\nend\n');
  assert.equal(normalizeMarkdown('no newline'), 'no newline\n');
});

test('normalizeMarkdown changes nothing else, including trailing spaces and inner blank lines', () => {
  assert.equal(normalizeMarkdown('a  \n\n\nb\t\n'), 'a  \n\n\nb\t\n');
});

test('normalizeRepoUrl and sameRepo accept https and ssh forms of the same GitHub repo', () => {
  assert.equal(normalizeRepoUrl('https://github.com/Divy2000/career-ops.git'), 'github.com/divy2000/career-ops');
  assert.equal(normalizeRepoUrl('git@github.com:Divy2000/career-ops'), 'github.com/divy2000/career-ops');
  assert.equal(normalizeRepoUrl('https://github.com/Divy2000/career-ops/'), 'github.com/divy2000/career-ops');
  assert.equal(sameRepo('git@github.com:Divy2000/career-ops.git', 'https://github.com/Divy2000/career-ops.git'), true);
  assert.equal(sameRepo('https://github.com/career-ops-hq/career-ops.git', 'https://github.com/Divy2000/career-ops.git'), false);
});

test('summarizeUnifiedDiff counts added and removed lines and previews at most the first N lines', () => {
  const diff = ['--- a', '+++ b', '@@ -1,2 +1,3 @@', ' same', '-old', '+new', '+extra'].join('\n') + '\n';
  const s = summarizeUnifiedDiff(diff, 4);
  assert.equal(s.added, 2);
  assert.equal(s.removed, 1);
  assert.deepEqual(s.preview, ['--- a', '+++ b', '@@ -1,2 +1,3 @@', ' same']);
});

test('parseDoctorState reads the onboarding verdict, tolerating text before the JSON', () => {
  const ready = parseDoctorState('noise line\n{"onboardingNeeded":false,"missing":[],"unpersonalized":[]}\n');
  assert.deepEqual(ready, { ready: true, missing: [], unpersonalized: [] });
  const late = parseDoctorState(JSON.stringify({ onboardingNeeded: true, missing: ['cv.md'], unpersonalized: [{ path: 'modes/_profile.md', reason: 'x' }] }));
  assert.deepEqual(late, { ready: false, missing: ['cv.md'], unpersonalized: ['modes/_profile.md'] });
});

test('parseDoctorState treats unparseable output as not ready', () => {
  assert.equal(parseDoctorState('boom').ready, false);
  assert.equal(parseDoctorState('').ready, false);
});

test('interactiveOnboardPrompt names ONBOARDING.md, cv.md and the project docs', () => {
  const p = interactiveOnboardPrompt({ cv: 'documents/cv/resume.md', docs: ['documents/projects/a.md', 'documents/projects/b.md'] });
  assert.match(p, /^Read custom\/install\/ONBOARDING\.md and follow it\./);
  assert.match(p, /cv\.md \(from documents\/cv\/resume\.md\)/);
  assert.match(p, /documents\/projects\/a\.md, documents\/projects\/b\.md/);
});

test('interactiveOnboardPrompt without inputs is just the instruction', () => {
  assert.equal(interactiveOnboardPrompt({ cv: null, docs: [] }), 'Read custom/install/ONBOARDING.md and follow it.');
});

test('renderHeadlessPrompt fills the draft dir and inputs and leaves no placeholder behind', () => {
  const out = renderHeadlessPrompt('Drafts: {{DRAFT_DIR}}\nInputs: {{INPUTS}}\n', { draftDir: '/d/draft', inputs: ['/d/cv.md', '/d/p.md'] });
  assert.equal(out, 'Drafts: /d/draft\nInputs: /d/cv.md, /d/p.md\n');
  assert.doesNotMatch(out, /\{\{/);
});

test('validateMarkdownInput accepts .md and .markdown in any case and reports soft warnings', () => {
  const dir = tmp();
  const a = validateMarkdownInput(write(dir, 'Resume.MD', '# Jane Doe\n## Experience\nx\n'), { kind: 'resume' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.warnings, []);
  const b = validateMarkdownInput(write(dir, 'r.markdown', 'just words\n'), { kind: 'resume' });
  assert.equal(b.ok, true);
  assert.equal(b.warnings.length, 2);
  assert.match(b.warnings.join('\n'), /heading/);
  assert.match(b.warnings.join('\n'), /Experience/);
});

test('validateMarkdownInput rejects other extensions and points at the prompt-based install', () => {
  const dir = tmp();
  for (const name of ['r.pdf', 'r.docx', 'r.txt', 'r']) {
    const v = validateMarkdownInput(write(dir, name, '# x\n'), { kind: 'resume' });
    assert.equal(v.ok, false, name);
    assert.match(v.error, /option 1 \(Claude Code prompt\)/);
    assert.match(v.error, /PDF, DOCX and other formats/);
  }
});

test('validateMarkdownInput rejects a missing path, a directory and a symlink to a directory', () => {
  const dir = tmp();
  assert.equal(validateMarkdownInput(path.join(dir, 'nope.md'), { kind: 'resume' }).ok, false);
  fs.mkdirSync(path.join(dir, 'd.md'));
  assert.match(validateMarkdownInput(path.join(dir, 'd.md'), { kind: 'resume' }).error, /regular file/);
  fs.symlinkSync(path.join(dir, 'd.md'), path.join(dir, 'link.md'));
  assert.match(validateMarkdownInput(path.join(dir, 'link.md'), { kind: 'resume' }).error, /regular file/);
});

test('validateMarkdownInput follows a symlink to a regular markdown file', () => {
  const dir = tmp();
  write(dir, 'real.md', '# A\n');
  fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
  assert.equal(validateMarkdownInput(path.join(dir, 'link.md'), { kind: 'resume' }).ok, true);
});

test('validateMarkdownInput rejects invalid UTF-8, NUL bytes and blank files, but allows a leading BOM', () => {
  const dir = tmp();
  assert.match(validateMarkdownInput(write(dir, 'bad.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])), { kind: 'resume' }).error, /UTF-8/);
  assert.match(validateMarkdownInput(write(dir, 'nul.md', 'a\0b\n'), { kind: 'resume' }).error, /NUL/);
  assert.match(validateMarkdownInput(write(dir, 'empty.md', ''), { kind: 'resume' }).error, /empty/);
  assert.match(validateMarkdownInput(write(dir, 'blank.md', ' \n\t\n'), { kind: 'resume' }).error, /empty/);
  assert.equal(validateMarkdownInput(write(dir, 'bom.md', '﻿# A\n'), { kind: 'resume' }).ok, true);
});

test('validateMarkdownInput enforces 1 MiB for the resume and 2 MiB for a doc', () => {
  const dir = tmp();
  const big = (n) => '# h\n' + 'a'.repeat(n);
  assert.equal(LIMITS.resumeBytes, 1024 * 1024);
  assert.equal(LIMITS.docBytes, 2 * 1024 * 1024);
  const f = write(dir, 'x.md', big(1024 * 1024 + 10));
  assert.match(validateMarkdownInput(f, { kind: 'resume' }).error, /1 MiB/);
  assert.equal(validateMarkdownInput(f, { kind: 'doc' }).ok, true);
  const g = write(dir, 'y.md', big(2 * 1024 * 1024 + 10));
  assert.match(validateMarkdownInput(g, { kind: 'doc' }).error, /2 MiB/);
  // Megabyte files go as soon as they are checked, not at the end of the file's run.
  fs.rmSync(f);
  fs.rmSync(g);
});

test('validateMarkdownInput rejects a resume that is the target cv.md itself', () => {
  const dir = tmp();
  const cv = write(dir, 'cv.md', '# Me\n');
  fs.symlinkSync(cv, path.join(dir, 'alias.md'));
  assert.match(validateMarkdownInput(path.join(dir, 'alias.md'), { kind: 'resume', targetCv: cv }).error, /target cv\.md/);
  assert.match(validateMarkdownInput(cv, { kind: 'resume', targetCv: cv }).error, /target cv\.md/);
  assert.equal(validateMarkdownInput(cv, { kind: 'doc', targetCv: cv }).ok, true);
});

test('validateInputs names the failing file and caps the doc count and total size', () => {
  const dir = tmp();
  const ok = write(dir, 'ok.md', '# a\n');
  const r = validateInputs({ resume: ok, docs: [ok, path.join(dir, 'b.pdf')] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /b\.pdf/);
  const many = Array.from({ length: 21 }, () => ok);
  assert.match(validateInputs({ resume: ok, docs: many }).errors.join('\n'), /at most 20/);
  const chunk = '# h\n' + 'a'.repeat(1900 * 1024);
  const docs = Array.from({ length: 6 }, (_, i) => write(dir, `d${i}.md`, chunk));
  assert.match(validateInputs({ resume: ok, docs }).errors.join('\n'), /10 MiB/);
  for (const d of docs) fs.rmSync(d);
});

test('validateInputs passes with no inputs at all', () => {
  assert.deepEqual(validateInputs({}), { ok: true, errors: [], warnings: [] });
});

const RULE = '### Projects library (every item)\n\n- Pick from article-digest.md.\n';
const TEMPLATE = '# Custom\n\n## House Rules\n\n<!-- comment\n     more -->\n\n(none yet -- add yours above)\n\n## Custom Workflows\n\nwork\n';

test('insertHouseRule puts the rule in place of the "none yet" line when that is all the section holds', () => {
  assert.equal(insertHouseRule(TEMPLATE, RULE), '# Custom\n\n## House Rules\n\n<!-- comment\n     more -->\n\n### Projects library (every item)\n\n- Pick from article-digest.md.\n\n## Custom Workflows\n\nwork\n');
});

test('insertHouseRule appends after the existing rules of the section and keeps them byte for byte', () => {
  const mine = '# Custom\n\n## House Rules\n\n### Sponsorship check\n\n1. Check.\n\n## Custom Workflows\n';
  assert.equal(insertHouseRule(mine, RULE), '# Custom\n\n## House Rules\n\n### Sponsorship check\n\n1. Check.\n\n### Projects library (every item)\n\n- Pick from article-digest.md.\n\n## Custom Workflows\n');
});

test('insertHouseRule is idempotent: a file that already has the heading is left alone (null)', () => {
  const once = insertHouseRule(TEMPLATE, RULE);
  assert.equal(insertHouseRule(once, RULE), null);
  assert.equal(insertHouseRule('## House Rules\n\n### Projects library (edited by me)\n- mine\n', RULE), null);
});

test('insertHouseRule adds a House Rules section at the end when the file has none', () => {
  assert.equal(insertHouseRule('# Custom\n\nnotes\n', RULE), '# Custom\n\nnotes\n\n## House Rules\n\n### Projects library (every item)\n\n- Pick from article-digest.md.\n');
});

test('validateProjectsInput applies the --docs byte checks to a projects .md or .json: UTF-8, no NUL, not empty, at most 2 MiB', () => {
  const d = tmp();
  const ok = (name, data) => validateProjectsInput(write(d, name, data));
  assert.equal(ok('lib.md', '## A\n- One.\n').ok, true);
  assert.equal(ok('projects.json', '[{"name":"A"}]').ok, true);
  assert.match(ok('bad.md', Buffer.from([0x23, 0x23, 0x20, 0x41, 0x0a, 0x2d, 0x20, 0xff, 0x0a])).error, /not valid UTF-8/);
  assert.match(ok('nul.json', '[{"name":"A\u0000"}]').error, /NUL/);
  assert.match(ok('empty.md', '\n  \n').error, /empty/);
  assert.match(ok('notes.txt', '## A\n- One.\n').error, /\.md, \.markdown or \.json/);
  const big = write(d, 'big.md', `## A\n- ${'x'.repeat(LIMITS.docBytes)}\n`);
  assert.match(validateProjectsInput(big).error, /over the 2 MiB limit/);
  fs.rmSync(big);
  assert.match(validateProjectsInput(path.join(d, 'missing.md')).error, /does not exist/);
});
