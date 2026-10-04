import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PACK = path.join(HERE, '..', 'pack');
const FORK = path.join(PACK, 'cv-template.fork.html');
const UPSTREAM = path.join(REPO, 'templates', 'cv-template.html');
const fork = fs.readFileSync(FORK, 'utf8');
const upstream = fs.readFileSync(UPSTREAM, 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'payload-typical.json'), 'utf8'));

const placeholders = (t) => [...new Set(t.match(/\{\{[A-Z_]+\}\}/g))].sort();
const markers = (t) => [...t.matchAll(/<!--\s+([A-Z][A-Z ]*?)\s+-->/g)].map((m) => m[1]);
// Every declaration block whose selector list names `selector`, joined.
const rule = (selector) => {
  const bodies = [...fork.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').some((sel) => sel.trim() === selector))
    .map((m) => m[2]);
  return bodies.length ? bodies.join('\n') : null;
};

// Builds with upstream build-cv-html.mjs and the fork pack, as custom/cv/build-html.mjs will.
function build(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pack-'));
  const input = path.join(dir, 'payload.json');
  const output = path.join(dir, 'cv.html');
  fs.writeFileSync(input, JSON.stringify(payload));
  const env = { ...process.env, CAREER_OPS_ROOT: dir };
  delete env.CAREER_OPS_DATA_DIR;
  const r = spawnSync(process.execPath, [path.join(REPO, 'build-cv-html.mjs'), input, output, FORK], { cwd: REPO, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(output, 'utf8');
}

test('given the fork template, when checked, then its placeholder set equals upstream', () => {
  assert.deepEqual(placeholders(fork), placeholders(upstream));
});

test('given the fork template, when checked, then the section markers match upstream in order', () => {
  assert.deepEqual(markers(fork), markers(upstream));
  for (const m of ['CORE COMPETENCIES', 'WORK EXPERIENCE', 'PROJECTS', 'EDUCATION', 'CERTIFICATIONS', 'AWARDS', 'INTERESTS', 'SKILLS', 'END']) {
    assert.ok(markers(fork).includes(m), m);
  }
});

test('given the fork template, when checked, then ligatures are off on every element and the body', () => {
  for (const sel of ['*', 'body']) {
    const body = rule(sel);
    assert.ok(body, sel);
    assert.match(body, /font-variant-ligatures:\s*none/, sel);
    assert.match(body, /font-feature-settings:\s*"liga" 0, "clig" 0, "dlig" 0/, sel);
  }
});

test('given the fork pack, when checked, then no heading is letter-spaced and no file has an em or en dash', () => {
  for (const m of fork.matchAll(/letter-spacing:\s*([^;]+);/g)) assert.match(m[1].trim(), /^(0|normal)$/, m[0]);
  const files = [FORK, ...fs.readdirSync(path.join(PACK, 'sections')).map((f) => path.join(PACK, 'sections', f))];
  for (const f of files) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(f, 'utf8')), f);
});

test('given the fork template, when checked, then it hides nothing (verify-ats penalises display:none as keyword stuffing)', () => {
  assert.equal(/display:\s*none|visibility:\s*hidden/.test(fork), false);
});

test('given the fork template, when checked, then densities 0 to 3 shrink the font and the margins', () => {
  const levels = [0, 1, 2, 3].map((n) => {
    const body = rule(`html[data-density="${n}"]`);
    assert.ok(body, `density ${n}`);
    const px = Number(body.match(/--font-size:\s*([\d.]+)px/)?.[1]);
    const inch = Number(body.match(/--page-margin:\s*([\d.]+)in/)?.[1]);
    assert.ok(px > 0 && inch > 0, body);
    return { px, inch };
  });
  for (let n = 1; n < levels.length; n++) {
    assert.ok(levels[n].px < levels[n - 1].px, `font at density ${n}`);
    assert.ok(levels[n].inch <= levels[n - 1].inch, `margin at density ${n}`);
  }
  assert.ok(Math.abs(levels[0].px - 13.33) < 0.01, 'density 0 is a 10pt body');
});

test('given the fork template, when checked, then section headings and entry headers never strand at a page bottom', () => {
  assert.match(rule('.section-title'), /break-after:\s*avoid/);
  for (const sel of ['.job-header', '.project-title', '.edu-header', '.award-item']) {
    assert.match(rule(sel) ?? '', /break-inside:\s*avoid/, sel);
  }
  for (const sel of ['.job-header', '.project-title']) assert.match(rule(sel) ?? '', /break-after:\s*avoid/, sel);
});

test('given a project with 3 bullets and a URL, when built, then the title is a link and there is a 3-item list', () => {
  const html = build({ ...FIXTURE, projects: [FIXTURE.projects[2]] });
  const project = html.match(/<div class="project">[\s\S]*?<\/ul>/)[0];
  assert.match(project, /<div class="project-title"><a href="https:\/\/github\.com\/jordan-rivera-example\/plant-doctor">Plant Disease Detector App<\/a>/);
  assert.equal((project.match(/<li>/g) ?? []).length, 3);
});

test('given a role, when built, then title, company, location and dates share one row', () => {
  const html = build(FIXTURE);
  const header = html.match(/<div class="job-header">([\s\S]*?)<\/div>/)[1];
  assert.match(header, /class="job-role">Software Engineer</);
  assert.match(header, /class="job-company">Northwind Devices</);
  assert.match(header, /class="job-location">[^<]*Austin, Texas</);
  assert.match(header, /class="job-period">2024-10 - Present</);
  assert.ok(!/<div class="job-role">/.test(html), 'no separate title line');
});

test('given an awards entry, when built, then it renders as a row under "Recent Achievements"', () => {
  const html = build({ ...FIXTURE, sections: { awards: 'Recent Achievements' } });
  const section = html.match(/<!-- AWARDS -->([\s\S]*?)<!-- /)[1];
  assert.match(section, /class="section-title">Recent Achievements</);
  assert.match(section, /class="award-title">First Place, Campus AI Hackathon</);
  assert.match(section, /class="award-org">[^<]*Lakeside University</);
  assert.match(section, /class="award-year">2023</);
});

test('given an education entry, when built, then degree, school and years share one row', () => {
  const html = build(FIXTURE);
  const header = html.match(/<div class="edu-header">([\s\S]*?)<\/div>\s*<\/div>/)[1];
  assert.match(header, /class="edu-title">Master of Science, Computer Science</);
  assert.match(header, /class="edu-org">[^<]*Lakeside University</);
  assert.match(header, /class="edu-year">2022-08 - 2023-12</);
});
