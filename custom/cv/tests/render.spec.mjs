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

test('given a data-density with spaces around =, other quoting or repeats, when a density is set, then exactly one remains', () => {
  for (const tag of ['<html data-density = "0">', "<html lang=\"en\" DATA-DENSITY='1' data-density=2>", '<html\n  data-density\t=\t"3"\n  lang="en">']) {
    const out = setDensity(`${tag}<body></body></html>`, 2);
    const html = out.match(/<html\b[^>]*>/i)[0];
    assert.equal((html.match(/data-density/gi) ?? []).length, 1, html);
    assert.match(html, /data-density="2"/, html);
  }
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

test('given a report whose good CV is indexed, when a strict render for it overflows every density, then nothing is published and the index keeps that CV (SW6-libs-01)', { timeout: 240000 }, () => {
  const payload = longPayload();
  const root = dataRoot({ cv: cvMarkdownFor(payload) });
  const html = buildInto(root, payload);
  const index = path.join(root, 'data', 'pdf-index.tsv');
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const indexed = '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit\n12\toutput/cv-acme-v1.pdf\toutput/cv-acme-v1.html\tletter\t2026-10-01\tcv\n';
  fs.writeFileSync(index, indexed);
  const strict = render(root, html, ['--max-pages=1', '--strict-pages', '--report=12']);
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /does not fit 1 page/);
  assert.equal(fs.readFileSync(index, 'utf8'), indexed);
  const lax = render(root, html, ['--max-pages=1', '--report=12']);
  assert.equal(lax.status, 0, lax.stderr);
  assert.match(fs.readFileSync(index, 'utf8'), /^12\toutput\/cv-test\.pdf\toutput\/cv-test\.html\tletter\t\d{4}-\d{2}-\d{2}\tcv$/m, 'without --strict-pages the kept PDF is indexed for the report, as before');
});

test('given an indexed CV with the same file names, when a strict re-render of it overflows every density, then its PDF, HTML and index row are untouched and no draft is left behind (SW5-tests-01)', { timeout: 240000 }, () => {
  const payload = longPayload();
  const root = dataRoot({ cv: cvMarkdownFor(payload) });
  const html = buildInto(root, payload);
  const goodHtml = setDensity(fs.readFileSync(html, 'utf8'), 1);
  fs.writeFileSync(html, goodHtml);
  const pdf = path.join(root, 'output', 'cv-test.pdf');
  const goodPdf = pdfWith(1);
  fs.writeFileSync(pdf, goodPdf);
  const index = path.join(root, 'data', 'pdf-index.tsv');
  fs.mkdirSync(path.dirname(index), { recursive: true });
  const indexed = '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit\n12\toutput/cv-test.pdf\toutput/cv-test.html\tletter\t2026-10-01\tcv\n';
  fs.writeFileSync(index, indexed);
  const strict = render(root, html, ['--max-pages=1', '--strict-pages', '--report=12']);
  assert.notEqual(strict.status, 0);
  assert.match(strict.stderr, /does not fit 1 page/);
  assert.equal(fs.readFileSync(html, 'utf8'), goodHtml, 'the indexed HTML keeps its density');
  assert.deepEqual(fs.readFileSync(pdf), goodPdf, 'the indexed PDF is not overwritten by an overflowing draft');
  assert.equal(fs.readFileSync(index, 'utf8'), indexed);
  assert.deepEqual(fs.readdirSync(path.join(root, 'output')).sort(), ['cv-test.html', 'cv-test.pdf']);
});

test('given generate-pdf.mjs failing the fact check, when run, then it passes the message through and leaves the input untouched', { timeout: 120000 }, () => {
  const cv = cvMarkdownFor(fixture).replace('saves the team lead about 5 hours every week', 'saves the team lead time every week');
  const root = dataRoot({ cv });
  const html = buildInto(root, fixture);
  const before = fs.readFileSync(html, 'utf8');
  const r = render(root, html, ['--max-pages=1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /fact/i);
  assert.match(r.stdout + r.stderr, /5 hours/);
  assert.equal(fs.readFileSync(html, 'utf8'), before, 'a failed run leaves the input HTML as it was');
  assert.deepEqual(fs.readdirSync(path.join(root, 'output')), ['cv-test.html'], 'no PDF and no draft is left behind');
});

test('given an output folder that does not exist yet, when rendered, then it is created as upstream does and the PDF lands there (review of SW5-tests-01)', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const pdf = path.join(root, 'output', '2026', 'cv-test.pdf');
  const r = spawnSync(process.execPath, [RENDER, html, pdf, '--format=letter', '--max-pages=1'], { cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(countPdfPages(fs.readFileSync(pdf)), 1);
  assert.deepEqual(fs.readdirSync(path.dirname(pdf)), ['cv-test.pdf'], 'no scratch folder is left behind');
});

test('given an output in a new folder outside the workspace, when rendered, then upstream refuses it and no folder is created (review of SW5-tests-01)', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const before = fs.readFileSync(html, 'utf8');
  const outside = dataRoot();
  const pdf = path.join(outside, 'new-dir', 'cv-test.pdf');
  const r = spawnSync(process.execPath, [RENDER, html, pdf, '--format=letter', '--max-pages=1'], { cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 240000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /outside the tracker workspace/);
  assert.equal(fs.existsSync(path.dirname(pdf)), false, 'the new folder is not created');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['output']);
  assert.equal(fs.readFileSync(html, 'utf8'), before);
});

test('given an output under a folder linked outside the workspace, when rendered, then upstream refuses it and nothing is written through the link (review of SW5-tests-01)', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const foreign = path.join(dataRoot(), 'output');
  fs.symlinkSync(foreign, path.join(root, 'output', 'link'));
  // Read-only, so even a scratch folder created there for a moment fails the run.
  fs.chmodSync(foreign, 0o555);
  try {
    const r = spawnSync(process.execPath, [RENDER, html, path.join(root, 'output', 'link', 'cv-test.pdf'), '--format=letter', '--max-pages=1'], { cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 240000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /outside the tracker workspace/);
    assert.deepEqual(fs.readdirSync(foreign), []);
  } finally {
    fs.chmodSync(foreign, 0o755);
  }
});

test('given an output path that is an existing folder, when the final render fails, then the input HTML is left as it was (review of SW5-tests-01)', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const before = setDensity(fs.readFileSync(html, 'utf8'), 3);
  fs.writeFileSync(html, before);
  const pdf = path.join(root, 'output', 'cv-test.pdf');
  fs.mkdirSync(pdf);
  const r = render(root, html, ['--max-pages=2']);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(html, 'utf8'), before, 'the chosen density is not kept when nothing was published');
  assert.deepEqual(fs.readdirSync(pdf), []);
});

test('given space-separated flag values, when run, then they are honored like the = form', { timeout: 240000 }, () => {
  const root = dataRoot({ cv: cvMarkdownFor(fixture) });
  const html = buildInto(root, fixture);
  const r = spawnSync(process.execPath, [RENDER, html, path.join(root, 'output', 'cv-test.pdf'), '--format', 'letter', '--max-pages', '1'], {
    cwd: REPO, env: envFor(root), encoding: 'utf8', timeout: 240000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Format: LETTER/);
  assert.match(r.stdout, /, 1 page \(budget 1;/);
});

test('given a value flag with no value, when run, then it exits non-zero naming the flag', () => {
  const root = dataRoot({ cv: '' });
  const r = spawnSync(process.execPath, [RENDER, 'a.html', 'b.pdf', '--max-pages'], { cwd: REPO, env: envFor(root), encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--max-pages requires a value/);
});

test('given a bad --max-pages or missing arguments, when run, then it exits non-zero with usage', () => {
  const root = dataRoot({ cv: '' });
  assert.notEqual(spawnSync(process.execPath, [RENDER], { cwd: REPO, encoding: 'utf8' }).status, 0);
  const bad = render(root, path.join(root, 'output', 'none.html'), ['--max-pages=zero']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /max-pages/);
});

test('the render children run on their temp root only: no CAREER_OPS_* override from the shell reaches them', () => {
  const keys = ['CAREER_OPS_TRACKER', 'CAREER_OPS_PDF_INDEX', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_PIPELINE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = `/real/data/${k}`;
  try {
    const env = envFor('/tmp/cv-root');
    assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('CAREER_OPS_')), ['CAREER_OPS_ROOT']);
    assert.equal(env.CAREER_OPS_ROOT, '/tmp/cv-root');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
