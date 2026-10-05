import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suiteEnv } from '../tmp.mjs';

test('the guard child gets the fresh dir as TMPDIR, TEMP and TMP (TEMP and TMP win on Windows) and no NODE_TEST_CONTEXT', () => {
  const env = suiteEnv({ PATH: '/bin', NODE_TEST_CONTEXT: 'child-v8', TMPDIR: '/old', TEMP: 'C:\\old', TMP: 'C:\\old' }, '/fresh');
  assert.deepEqual(env, { PATH: '/bin', TMPDIR: '/fresh', TEMP: '/fresh', TMP: '/fresh' });
});
