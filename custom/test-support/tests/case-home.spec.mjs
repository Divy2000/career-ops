import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { caseFlippedHome } from '../case-home.mjs';
import { tempDir } from '../tmp.mjs';

test('on a platform other than macOS there is no case-flipped home, and nothing is created', () => {
  const base = tempDir('case-home-base-');
  assert.equal(caseFlippedHome({ platform: 'linux', bases: [base] }), null);
  assert.deepEqual(fs.readdirSync(base), []);
});

test('a base folder on a case-sensitive volume gives no case-flipped home, and what was tried is removed', (t) => {
  const base = tempDir('case-home-base-');
  const probe = path.join(base, 'Probe');
  fs.mkdirSync(probe);
  const sensitive = !fs.existsSync(path.join(base, 'probe'));
  fs.rmdirSync(probe);
  if (!sensitive) return t.skip('this TMPDIR is on a case-insensitive volume');
  assert.equal(caseFlippedHome({ platform: 'darwin', bases: [base] }), null);
  assert.deepEqual(fs.readdirSync(base), []);
});

test('the first case-insensitive base gives a home and its flipped spelling, which cleanup removes', (t) => {
  const h = caseFlippedHome();
  if (!h) return t.skip('no case-insensitive temp folder here (Linux, or a case-sensitive volume)');
  try {
    assert.notEqual(h.flipped, h.home);
    assert.equal(h.flipped.toLowerCase(), h.home.toLowerCase());
    assert.ok(fs.existsSync(h.flipped));
  } finally {
    h.cleanup();
  }
  assert.equal(fs.existsSync(h.home), false);
});
