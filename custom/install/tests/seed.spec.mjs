import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, '..', 'seed.mjs');
const VALIDATE = path.join(HERE, '..', 'validate-md.mjs');
const LIB = path.join(HERE, '..', 'lib.mjs');
const CLI = path.join(HERE, '..', 'cli.mjs');

const tmp = () => tempDir('ci-seed-');
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
const seed = (args) => run(SEED, args);
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f).toString('base64');
    }
  };
  walk(dir);
  return out;
};

test('validate-md prints JSON and exits 0 for good input, with warnings on stderr', () => {
  const d = tmp();
  const r = put(path.join(d, 'r.md'), 'plain words\n');
  const res = run(VALIDATE, ['--resume', r]);
  assert.equal(res.status, 0);
  const json = JSON.parse(res.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.warnings.length, 2);
  assert.match(res.stderr, /warning:/);
});

test('validate-md exits 2 naming file and reason for a bad doc, and treats --docs values as a list', () => {
  const d = tmp();
  const r = put(path.join(d, 'r.md'), '# A\n');
  const a = put(path.join(d, 'a.md'), '# A\n');
  const res = run(VALIDATE, ['--resume', r, '--docs', a, put(path.join(d, 'b.pdf'), '%PDF-1.4\n')]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).ok, false);
  assert.match(res.stderr, /b\.pdf/);
  assert.match(res.stderr, /option 1 \(Claude Code prompt\)/);
});

test('validate-md rejects a resume equal to the --cv target', () => {
  const d = tmp();
  const cv = put(path.join(d, 'cv.md'), '# Me\n');
  const res = run(VALIDATE, ['--resume', cv, '--cv', cv]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /target cv\.md/);
});

test('seed local-paths creates, then merges once, keeping other lines', () => {
  const d = tmp();
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  const f = path.join(d, 'config', 'local-paths.txt');
  assert.match(fs.readFileSync(f, 'utf8'), /^custom\/$/m);
  fs.writeFileSync(f, 'mine/\n');
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'added');
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine/\ncustom/\n');
  assert.equal(seed(['local-paths', '--dir', d]).stdout.trim(), 'present');
  assert.equal(fs.readFileSync(f, 'utf8'), 'mine/\ncustom/\n');
});

test('seed custom-template copies only when absent and never overwrites', () => {
  const d = tmp();
  const t = put(path.join(d, 't.md'), 'TEMPLATE\n');
  const data = path.join(d, 'data');
  assert.equal(seed(['custom-template', '--data', data, '--template', t]).stdout.trim(), 'created');
  const target = path.join(data, 'modes', '_custom.md');
  assert.equal(fs.readFileSync(target, 'utf8'), 'TEMPLATE\n');
  fs.writeFileSync(target, 'SENTINEL-MINE\n');
  assert.equal(seed(['custom-template', '--data', data, '--template', t]).stdout.trim(), 'exists');
  assert.equal(fs.readFileSync(target, 'utf8'), 'SENTINEL-MINE\n');
});

test('copy-documents puts the resume in documents/cv and docs in documents/projects, byte for byte', () => {
  const d = tmp();
  const raw = '﻿# Jane\r\nbody\r\n';
  const r = put(path.join(d, 'src', 'resume.md'), raw);
  const a = put(path.join(d, 'src', 'proj.md'), '# P\n');
  const data = path.join(d, 'data');
  const res = seed(['copy-documents', '--data', data, '--resume', r, '--docs', a]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim().split('\n').join('|'), `copied\tresume\t${path.join(data, 'documents/cv/resume.md')}|copied\tdoc\t${path.join(data, 'documents/projects/proj.md')}`);
  assert.equal(fs.readFileSync(path.join(data, 'documents/cv/resume.md'), 'utf8'), raw);
});

test('copy-documents gives a different file of the same name a -1 suffix and never overwrites', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const existing = put(path.join(data, 'documents/projects/proj.md'), 'EXISTING\n');
  const a = put(path.join(d, 'src', 'proj.md'), '# New\n');
  const res = seed(['copy-documents', '--data', data, '--docs', a]);
  assert.match(res.stdout, /copied\tdoc\t.*proj-1\.md/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'EXISTING\n');
  assert.equal(fs.readFileSync(path.join(data, 'documents/projects/proj-1.md'), 'utf8'), '# New\n');
});

test('copy-documents is idempotent: an identical earlier copy is reported present, not duplicated', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const a = put(path.join(d, 'src', 'proj.md'), '# New\n');
  seed(['copy-documents', '--data', data, '--docs', a]);
  const again = seed(['copy-documents', '--data', data, '--docs', a]);
  assert.match(again.stdout, /present\tdoc\t.*proj\.md/);
  assert.deepEqual(fs.readdirSync(path.join(data, 'documents/projects')), ['proj.md']);
});

test('copy-documents never writes article-digest.md or anything outside documents/', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'src', 'resume.md'), '# R\n');
  seed(['copy-documents', '--data', data, '--resume', r]);
  assert.deepEqual(Object.keys(tree(data)), ['documents/cv/resume.md']);
});

test('cv-status reports absent, identical after normalization, and differs with counts and a preview', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '﻿# Jane\r\nline one\r\n');
  assert.equal(seed(['cv-status', '--data', data, '--resume', r]).stdout.trim(), 'absent');
  put(path.join(data, 'cv.md'), '# Jane\nline one\n');
  assert.equal(seed(['cv-status', '--data', data, '--resume', r]).stdout.trim(), 'identical');
  put(path.join(data, 'cv.md'), '# Jane\nold line\n');
  const out = seed(['cv-status', '--data', data, '--resume', r]).stdout.trim().split('\n');
  assert.equal(out[0], 'differs');
  assert.ok(out.includes('added\t1'));
  assert.ok(out.includes('removed\t1'));
  assert.ok(out.some((l) => l === 'diff\t-old line'));
  assert.ok(out.some((l) => l === 'diff\t+line one'));
});

test('cv-write seeds an absent cv.md with the normalized resume and refuses to touch an existing one', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '﻿# Jane\r\nline\r\n\r\n');
  const first = seed(['cv-write', '--data', data, '--resume', r]);
  assert.equal(first.stdout.trim(), 'created');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# Jane\nline\n');
  fs.writeFileSync(path.join(data, 'cv.md'), 'MINE\n');
  const second = seed(['cv-write', '--data', data, '--resume', r]);
  assert.notEqual(second.status, 0);
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), 'MINE\n');
});

test('cv-write --replace backs up the old cv.md byte for byte, then replaces it atomically', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# New\n');
  put(path.join(data, 'cv.md'), 'OLD\r\nbytes\n');
  const res = seed(['cv-write', '--data', data, '--resume', r, '--replace']);
  const [kind, backup] = res.stdout.trim().split('\t');
  assert.equal(kind, 'replaced');
  assert.match(path.basename(backup), /^cv\.md\.bak-\d{8}T\d{6}/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'OLD\r\nbytes\n');
  assert.equal(fs.readFileSync(path.join(data, 'cv.md'), 'utf8'), '# New\n');
  assert.deepEqual(fs.readdirSync(data).filter((n) => n.includes('tmp')), []);
});

test('cv-write --replace on an identical cv.md is a no-op with no backup', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const r = put(path.join(d, 'resume.md'), '# Same\r\n');
  put(path.join(data, 'cv.md'), '# Same\n');
  const res = seed(['cv-write', '--data', data, '--resume', r, '--replace']);
  assert.equal(res.stdout.trim(), 'identical');
  assert.deepEqual(fs.readdirSync(data), ['cv.md']);
});

test('lib.mjs is a library: running it directly executes no command (cli.mjs is the entry point)', () => {
  const r = run(LIB, ['version-ge', 'v20.0.0', '22.6.0']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('cli.mjs doctor-state reads stdin and prints a ready or incomplete line', () => {
  const ready = spawnSync(process.execPath, [CLI, 'doctor-state'], { input: '{"onboardingNeeded":false,"missing":[],"unpersonalized":[]}', encoding: 'utf8' });
  assert.equal(ready.stdout, 'ready\t\n');
  const late = spawnSync(process.execPath, [CLI, 'doctor-state'], { input: '{"onboardingNeeded":true,"missing":["cv.md"],"unpersonalized":[]}', encoding: 'utf8' });
  assert.equal(late.stdout.trim(), 'incomplete\tcv.md');
});

test('cli.mjs version-ge exits 0 when the version meets the floor and 1 otherwise', () => {
  assert.equal(run(CLI, ['version-ge', 'v22.6.0', '22.6.0']).status, 0);
  assert.equal(run(CLI, ['version-ge', 'v20.19.0', '22.6.0']).status, 1);
});

test('cli.mjs same-path compares normalized and real paths, existing or not', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'a'));
  fs.symlinkSync(path.join(d, 'a'), path.join(d, 'link'));
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'x', '..', 'a')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'link')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'nope'), path.join(d, 'nope')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'a'), path.join(d, 'b')]).status, 1);
});

test('cli.mjs same-path resolves symlinks in the deepest existing ancestor of a path that does not exist yet', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'real'));
  fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'new', 'deeper'), path.join(d, 'real', 'new', 'deeper')]).status, 0);
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'new'), path.join(d, 'real', 'other')]).status, 1);
  assert.equal(run(CLI, ['same-path', path.join(d, 'link', 'a', '..', 'new'), path.join(d, 'real', 'new')]).status, 0);
});

const PROJECTS_LIB = path.join(HERE, '..', '..', 'projects', 'lib.mjs');
const RULE_TEMPLATE = path.join(HERE, '..', 'templates', '_custom-projects.md');
const CUSTOM_TEMPLATE = path.join(HERE, '..', 'templates', '_custom.md');

test('projects-rule appends the shipped projects block to modes/_custom.md exactly once', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'absent');
  assert.equal(seed(['custom-template', '--data', data, '--template', CUSTOM_TEMPLATE]).stdout.trim(), 'created');
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'added');
  const file = path.join(data, 'modes', '_custom.md');
  const text = fs.readFileSync(file, 'utf8');
  const rule = fs.readFileSync(RULE_TEMPLATE, 'utf8').trimEnd();
  assert.equal(text.split(rule).length - 1, 1, 'the block appears once, verbatim');
  assert.ok(!text.includes('(none yet -- add yours above)\n\n## Custom Workflows'), 'the placeholder line was replaced');
  assert.ok(text.indexOf(rule) > text.indexOf('## House Rules') && text.indexOf(rule) < text.indexOf('## Custom Workflows'));
  assert.equal(seed(['projects-rule', '--data', data, '--template', RULE_TEMPLATE]).stdout.trim(), 'present');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('projects-check accepts a valid library or projects JSON and rejects an invalid one with exit 2', () => {
  const d = tmp();
  const good = put(path.join(d, 'lib.md'), '# Projects library\n\n## Kite Tracker -- https://example.org/kites\n- Tracked kites.\n');
  const json = put(path.join(d, 'projects.json'), JSON.stringify([{ name: 'Kite Tracker', description: 'Tracked kites.', highlights: [] }]));
  const bad = put(path.join(d, 'bad.md'), '## Empty\nTags: go\n');
  const notList = put(path.join(d, 'bad.json'), '{"basics":{}}');
  for (const f of [good, json]) {
    const r = seed(['projects-check', '--lib', PROJECTS_LIB, '--file', f]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ok\t1');
  }
  const r = seed(['projects-check', '--lib', PROJECTS_LIB, '--file', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"Empty".*no copy-paste points/);
  assert.equal(seed(['projects-check', '--lib', PROJECTS_LIB, '--file', notList]).status, 2);
});

test('projects-seed copies the file to documents/projects and creates article-digest.md only when absent', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const json = put(path.join(d, 'src', 'projects.json'), JSON.stringify([{ name: 'Kite Tracker', url: 'https://example.org/kites', description: 'Tracked kites.', highlights: ['Plotted paths.'], keywords: ['python'] }]));
  const r = seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', json]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [`copied\tprojects\t${path.join(data, 'documents/projects/projects.json')}`, 'created']);
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), '# Projects library\n\n## Kite Tracker -- https://example.org/kites\nTags: python\n- Tracked kites.\n- Plotted paths.\n');
  fs.writeFileSync(path.join(data, 'article-digest.md'), 'MINE\n');
  const again = seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', json]);
  assert.equal(again.stdout.trim().split('\n').at(-1), 'exists');
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), 'MINE\n');
});

test('projects-seed writes a markdown library byte for byte', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const text = '# My projects\n\n## Kite Tracker\n\n**Hero metrics:** 40 kites\n\n**Proof points:**\n- Tracked kites.\n';
  const lib = put(path.join(d, 'src', 'lib.md'), text);
  assert.equal(seed(['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', lib]).status, 0);
  assert.equal(fs.readFileSync(path.join(data, 'article-digest.md'), 'utf8'), text);
});

test('projects-check and projects-seed refuse bytes that are not UTF-8 instead of decoding them leniently', () => {
  const d = tmp();
  const data = path.join(d, 'data');
  const bad = put(path.join(d, 'bad.md'), Buffer.from('## A\n- \xff\n', 'latin1'));
  for (const args of [['projects-check', '--lib', PROJECTS_LIB, '--file', bad], ['projects-seed', '--lib', PROJECTS_LIB, '--data', data, '--file', bad]]) {
    const r = seed(args);
    assert.equal(r.status, 2, args[0]);
    assert.match(r.stderr, /not valid UTF-8/, args[0]);
  }
  assert.equal(fs.existsSync(path.join(data, 'article-digest.md')), false);
});
