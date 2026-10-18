import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { specsWithoutTmpCheck } from '../../test-support/tmp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Every spec that loads test-support/tmp.mjs fails its own run when it leaves anything in its temp dir, so this
// suite leaves nothing in TMPDIR once every spec loads it; re-running the suite here would only double its run time.
test('every spec of this suite loads test-support/tmp.mjs, so a run of it that leaves anything in TMPDIR fails', () => {
  assert.deepEqual(specsWithoutTmpCheck(here), [], 'import ../../test-support/tmp.mjs in these specs');
});
