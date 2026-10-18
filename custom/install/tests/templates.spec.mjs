import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../../test-support/tmp.mjs';

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

test('the sponsorship house rule names the company-alerts.tsv columns and status vocabulary, never resumption (R17-scripts-b-L2-01)', () => {
  const text = read(path.join(TEMPLATES, '_custom-sponsorship.md'));
  for (const col of ['date', 'company', 'slug', 'status', 'headline', 'url']) {
    assert.ok(text.includes(col), `the template does not name the \`${col}\` column`);
  }
  for (const status of ['paused', 'stopped', 'restricted', 'resumed', 'expanded']) {
    assert.ok(text.includes(status), `the template does not name the \`${status}\` status`);
  }
  assert.ok(text.includes('resumed'), 'the template must spell the status resumed');
  assert.match(text, /never\s+`resumption`/, 'the template must warn that the status is resumed, never resumption');
});

// readAlerts in custom/immigration/lib.mjs keeps the last row of a slug among rows with the same date, so a
// newest-first file would let an older same-day row win.
test('the sponsorship house rule appends company-alerts.tsv rows oldest first, newest last, as the parser reads them (R18-scripts-b-review-03)', () => {
  const rule = read(path.join(TEMPLATES, '_custom-sponsorship.md')).split('\n').find((l) => l.includes('company-alerts.tsv') && l.includes('append'));
  assert.ok(rule, 'the template names where to append a company alert');
  assert.doesNotMatch(rule, /newest first/, rule);
  assert.match(rule, /at the end of the file \(oldest first, newest last\)/, rule);
});

test('the sponsorship house rule records every alert status it lists, expansion included (R18-scripts-b-review-04)', () => {
  const rule = read(path.join(TEMPLATES, '_custom-sponsorship.md')).split('\n').find((l) => l.includes('company-alerts.tsv') && l.includes('append'));
  assert.ok(rule, 'the template names when to append a company alert');
  for (const event of ['pause', 'stop', 'restriction', 'resumption', 'expansion']) assert.ok(rule.includes(event), `the trigger does not name ${event}: ${rule}`);
});

// shortlist.mjs and the evaluation match alerts by companySlug(name), so the rule must spell that normalization out,
// and every example it gives must be what companySlug returns.
test('the sponsorship house rule spells out the company slug rule with examples companySlug agrees with (R18-scripts-b-review-09)', async () => {
  const { companySlug } = await import(path.join(ROOT, 'custom', 'immigration', 'lib.mjs'));
  const rule = read(path.join(TEMPLATES, '_custom-sponsorship.md')).split('\n').find((l) => l.includes('`<slug>`'));
  assert.ok(rule, 'the template defines the slug column');
  const examples = [...rule.matchAll(/`([^`]+)` is `([^`]+)`/g)].map((m) => [m[1], m[2]]);
  assert.ok(examples.length >= 3, `the slug rule needs examples: ${rule}`);
  assert.ok(examples.some(([name]) => name.includes('&')), 'an example shows & becoming and');
  for (const [name, slug] of examples) assert.equal(companySlug(name), slug, `${name} in ${rule}`);
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
