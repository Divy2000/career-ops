import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const TEMPLATES = path.join(ROOT, 'custom', 'install', 'templates');
const PROJECTS_RULE = path.join(TEMPLATES, '_custom-projects.md');
const read = (f) => fs.readFileSync(f, 'utf8');

test('the projects house rule ships as a section that starts with its own heading', () => {
  assert.ok(fs.existsSync(PROJECTS_RULE), 'template missing');
  assert.match(read(PROJECTS_RULE), /^### Projects library \(/);
});

test('every fork command the projects rule names exists and accepts the flags it is given', () => {
  const text = read(PROJECTS_RULE);
  const commands = [...text.matchAll(/`node (custom\/[\w/-]+\.mjs)([^`]*)`/g)].map((m) => ({ script: m[1], args: m[2] }));
  const scripts = new Set(commands.map((c) => c.script));
  for (const s of ['custom/projects/rank.mjs', 'custom/cv/build-html.mjs', 'custom/cv/render-pdf.mjs']) assert.ok(scripts.has(s), `${s} not named`);
  for (const { script, args } of commands) {
    assert.ok(fs.existsSync(path.join(ROOT, script)), `${script} does not exist`);
    const help = spawnSync(process.execPath, [path.join(ROOT, script), '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(help.status, 0, `${script} --help`);
    for (const flag of args.match(/--[a-z-]+/g) ?? []) assert.ok(help.stdout.includes(flag), `${script} does not document ${flag}`);
  }
});

test('the projects rule sends papers to Recent Achievements and never to Projects', () => {
  const text = read(PROJECTS_RULE);
  assert.match(text, /Never put a research paper or publication in Projects/);
  assert.match(text, /## Recent Achievements/);
  assert.match(text, /awards\[\]/);
});

test('the _custom.md template says where the projects block comes from', () => {
  assert.match(read(path.join(TEMPLATES, '_custom.md')), /custom\/install\/templates\/_custom-projects\.md/);
});

test('the shipped house-rule templates use no em or en dash', () => {
  for (const f of fs.readdirSync(TEMPLATES)) assert.ok(!/[\u2013\u2014]/.test(read(path.join(TEMPLATES, f))), f);
});

test('the house rule updates the way the README does: the README installs a detached tag checkout, so it switches to main before pulling', () => {
  const readme = read(path.join(ROOT, '.github', 'README.md'));
  const updating = readme.slice(readme.indexOf('## Updating'));
  const pull = updating.match(/^(git switch main && git pull --ff-only)$/m)?.[1];
  assert.ok(pull, 'the README Updating section names the switch-then-pull command');
  const rule = read(path.join(TEMPLATES, '_custom.md')).split('\n').find((l) => l.includes('update-system.mjs apply'));
  assert.ok(rule.includes(`\`${pull}\``), rule);
  assert.equal(/`git pull --ff-only`/.test(rule), false, 'no bare pull, which fails on a detached HEAD');
});
