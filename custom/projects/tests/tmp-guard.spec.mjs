import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuiteInFreshTmp } from '../../test-support/tmp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a run of this suite leaves nothing behind in TMPDIR', () => {
  const r = runSuiteInFreshTmp(here, path.basename(fileURLToPath(import.meta.url)));
  assert.equal(r.status, 0, r.output.slice(-4000));
  assert.deepEqual(r.leftovers, []);
});
