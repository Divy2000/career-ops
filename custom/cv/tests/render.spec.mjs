import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fitToPages, setDensity, countPdfPages, DENSITIES } from '../lib.mjs';
import { HERE, REPO, loadFixture, cvMarkdownFor, dataRoot, envFor } from './helpers.mjs';

const BUILD = path.join(HERE, '..', 'build-html.mjs');
const RENDER = path.join(HERE, '..', 'render-pdf.mjs');
const HTML = '<!DOCTYPE html>\n<html lang="en">\n<head></head><body>x</body></html>';

const fakeRenderer = (pages) => {
  const seen = [];
  const render = async (html, density) => {
    seen.push({ html, density });
    return { pages: pages[seen.length - 1] };
  };
  return { render, seen };
};

// Minimal PDF: catalog -> page tree with /Count n, plus a content stream whose
// text looks like another page tree.
const pdfWith = (count) => Buffer.from([
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  `2 0 obj << /Type /Pages /Kids [] /Count ${count} >> endobj`,
  '3 0 obj << /Length 40 >> stream',
  '<< /Type /Pages /Count 99 >> BT (Count 42) Tj ET',
  'endstream endobj',
  'trailer << /Root 1 0 R >>',
  '%%EOF',
].join('\n'), 'latin1');

test('given html with or without a density, when a density is set, then the html tag carries exactly that one', () => {
  const once = setDensity(HTML, 2);
  assert.match(once, /<html lang="en" data-density="2">/);
  assert.equal((setDensity(once, 3).match(/data-density=/g) ?? []).length, 1);
  assert.match(setDensity(once, 3), /<html lang="en" data-density="3">/);
});

test('given html without an <html> tag, when a density is set, then it throws', () => {
  assert.throws(() => setDensity('<body></body>', 1), /<html>/);
});

test('given a fake renderer giving 2, 2, 1 pages, when fitted to a 1-page budget, then it stops at density 2 and the HTML has data-density="2"', async () => {
  const { render, seen } = fakeRenderer([2, 2, 1, 1]);
  const r = await fitToPages({ html: HTML, maxPages: 1, render });
  assert.equal(r.fits, true);
  assert.equal(r.density, 2);
  assert.equal(r.pages, 1);
  assert.match(r.html, /data-density="2"/);
  assert.deepEqual(seen.map((s) => s.density), [0, 1, 2]);
  assert.match(seen[1].html, /data-density="1"/);
  assert.deepEqual(r.attempts, [{ density: 0, pages: 2 }, { density: 1, pages: 2 }, { density: 2, pages: 1 }]);
});

test('given every density overflowing, when fitted, then it reports no fit at the tightest density', async () => {
  const { render, seen } = fakeRenderer([3, 3, 2, 2]);
  const r = await fitToPages({ html: HTML, maxPages: 1, render });
  assert.equal(r.fits, false);
  assert.equal(r.density, DENSITIES[DENSITIES.length - 1]);
  assert.equal(r.pages, 2);
  assert.equal(seen.length, DENSITIES.length);
});

test('given a renderer that fails, when fitted, then it stops immediately with that error', async () => {
  let calls = 0;
  const render = async () => { calls++; throw new Error('fact check failed: 42% not in cv.md'); };
  await assert.rejects(fitToPages({ html: HTML, maxPages: 1, render }), /fact check failed: 42%/);
  assert.equal(calls, 1);
});

test('given a minimal PDF with /Count 3, when counted, then the result is 3 and page-like text in the content is ignored', () => {
  assert.equal(countPdfPages(pdfWith(3)), 3);
  assert.throws(() => countPdfPages(Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 5 >>\n')), /page count/);
});

// ---- CLI with real Chromium ----

const fixture = loadFixture();
const longPayload = () => {
  const p = structuredClone(fixture);
  p.experience = [...p.experience, ...p.experience.map((e) => ({ ...e, dates: '2019-01 - 2020-12' }))];
  return p;
};
const buildInto = (root, payload) => {
  const input = path.join(root, 'payload.json');
  const html = path.join(root, 'output', 'cv-test.html');
  fs.writeFileSync(input, JSON.stringify(payload));
  const r = spawnSync(process.execPath, [BUILD, input, html], { cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return html;
};
const render = (root, html, args) => spawnSync(process.execPath, [RENDER, html, path.join(root, 'output', 'cv-test.pdf'), '--format=letter', ...args], {
  cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 240000,
});

test('integration: given the made-up 6-role CV, when rendered with a 1-page budget, then the PDF has 1 page and the HTML keeps the chosen density', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const r = render(root, html, ['--max-pages=1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pdf = fs.readFileSync(path.join(root, 'output', 'cv-test.pdf'));
  assert.equal(countPdfPages(pdf), 1);
  const density = fs.readFileSync(html, 'utf8').match(/<html[^>]*data-density="(\d)"/)?.[1];
  assert.ok(density !== undefined, 'density attribute written back');
  assert.match(r.stdout, new RegExp(`density ${density}, 1 page`));
  assert.match(r.stdout, /Fact check passed/);
});

test('given every density overflowing, when run with --strict-pages, then it exits non-zero; without it, it warns and exits 0', { timeout: 240000 }, () => {
  const payload = longPayload();
  const root = dataRoot({ cv: cvMarkdownFor(payload) });
  const html = buildInto(root, payload);
  const strict = render(root, html, ['--max-pages=1', '--strict-pages']);
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /does not fit 1 page/);
  const lax = render(root, html, ['--max-pages=1']);
  assert.equal(lax.status, 0, lax.stderr);
  assert.match(lax.stderr, /does not fit 1 page/);
  assert.match(fs.readFileSync(html, 'utf8'), /<html[^>]*data-density="3"/);
});

test('given generate-pdf.mjs failing the fact check, when run, then it stops after one attempt and passes the message through', { timeout: 120000 }, () => {
  const cv = cvMarkdownFor(fixture).replace('saves the team lead about 5 hours every week', 'saves the team lead time every week');
  const root = dataRoot({ cv });
  const html = buildInto(root, fixture);
  const r = render(root, html, ['--max-pages=1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /fact/i);
  assert.match(r.stdout + r.stderr, /5 hours/);
  assert.match(fs.readFileSync(html, 'utf8'), /<html[^>]*data-density="0"/);
  assert.equal(fs.existsSync(path.join(root, 'output', 'cv-test.pdf')), false);
});

test('given a bad --max-pages or missing arguments, when run, then it exits non-zero with usage', () => {
  const root = dataRoot({ cv: '' });
  assert.notEqual(spawnSync(process.execPath, [RENDER], { cwd: REPO, encoding: 'utf8' }).status, 0);
  const bad = render(root, path.join(root, 'output', 'none.html'), ['--max-pages=zero']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /max-pages/);
});
