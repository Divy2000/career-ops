import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HERE, REPO, dataRoot, envFor } from './helpers.mjs';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

const RENDER = path.join(HERE, '..', 'render-pdf.mjs');
const SECRET = 'R23-HTML-SECRET-51c0de';
const noPdftotext = Boolean(spawnSync('pdftotext', ['-v']).error);

const secretUrl = () => {
  const file = path.join(fs.realpathSync(tempDir('render-secret-')), 'id_rsa');
  fs.writeFileSync(file, `${SECRET}\n`);
  return pathToFileURL(file).href;
};
const page = (body) => `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"></head>\n<body><h1>Visible Candidate</h1>${body}</body>\n</html>\n`;
const render = (root, html) => spawnCpuLimited(process.execPath, [RENDER, html, path.join(root, 'output', 'cv-test.pdf'), '--format=letter', '--skip-fact-check'], {
  cwd: REPO, env: envFor(root), encoding: 'utf8',
});
const pdfText = (file) => spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout;

const url = secretUrl();
const cases = {
  'an iframe': `<iframe src="${url}" style="width:600px;height:120px"></iframe>`,
  'an object': `<object data="${url}" type="text/plain" width="600" height="120"></object>`,
  'an embed': `<embed src="${url}" type="text/plain" width="600" height="120">`,
};

for (const [name, body] of Object.entries(cases)) {
  test(`given session-written HTML with a local file in ${name}, when rendered, then the PDF carries the page but never the file`, { timeout: 240000 }, () => {
    const root = dataRoot();
    const html = path.join(root, 'output', 'cv-test.html');
    fs.writeFileSync(html, page(body));
    const r = render(root, html);
    const pdf = path.join(root, 'output', 'cv-test.pdf');
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // A CV that meant to load a local asset is told why it is missing.
    assert.match(r.stderr, /local-file-guard: blocked file:\/\/\S*id_rsa/);
    // Reading the PDF's text needs poppler; the blocked-load line above does not.
    if (noPdftotext) return;
    const text = pdfText(pdf);
    assert.match(text, /Visible Candidate/);
    assert.doesNotMatch(text, new RegExp(SECRET));
  });
}
