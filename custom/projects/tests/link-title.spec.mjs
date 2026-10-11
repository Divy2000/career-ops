import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLibrary, serializeEntry, replaceEntry, appendEntry, convertJsonProjects } from '../lib.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LIBRARY = fs.readFileSync(path.join(FIX, 'library.md'), 'utf8');
const LINK_TITLE = '[Foo](https://example.com/x)';

test('given an edit whose title is written as a markdown link and no URL, when replaced, then it is refused and the URL is not invented (R23-scripts-a-L3-02)', () => {
  assert.throws(() => replaceEntry(LIBRARY, 'weather-dashboard', { title: LINK_TITLE, bullets: ['One.'] }), /read back as entered/);
});

test('given an edit whose title is written as a markdown link with a tagline only, when replaced, then it is refused (R23-scripts-a-L3-02)', () => {
  assert.throws(() => replaceEntry(LIBRARY, 'weather-dashboard', { title: LINK_TITLE, tagline: 'A tool', bullets: ['One.'] }), /read back as entered/);
});

test('given a new entry whose title is written as a markdown link, when added, then it is still refused (R23-scripts-a-L3-02)', () => {
  assert.throws(() => appendEntry(LIBRARY, { title: LINK_TITLE, bullets: ['One.'] }), /read back as entered/);
});

test('given an imported project named as a markdown link, when serialized, then it is refused rather than read back with an invented URL (R23-scripts-a-L3-02)', () => {
  const { entries } = convertJsonProjects([{ name: LINK_TITLE, highlights: ['One.'] }]);
  assert.throws(() => serializeEntry(entries[0]), /read back as entered/);
});

test('given a bracketed title with a URL and a tagline, when replaced, then it reads back with its own title and URL', () => {
  const out = replaceEntry(LIBRARY, 'weather-dashboard', { title: '[Beta] Weather', url: 'https://example.com/w', tagline: 'A tool', bullets: ['One.'] });
  const e = parseLibrary(out).entries.find((x) => x.title === '[Beta] Weather');
  assert.equal(e.url, 'https://example.com/w');
});
