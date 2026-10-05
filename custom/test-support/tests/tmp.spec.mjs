import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSuiteInFreshTmp, suiteEnv, suiteRanTests, tempDir } from '../tmp.mjs';

test('the guard child gets the fresh dir as TMPDIR, TEMP and TMP (TEMP and TMP win on Windows) and no NODE_TEST_CONTEXT', () => {
  const env = suiteEnv({ PATH: '/bin', NODE_TEST_CONTEXT: 'child-v8', TMPDIR: '/old', TEMP: 'C:\\old', TMP: 'C:\\old' }, '/fresh');
  assert.deepEqual(env, { PATH: '/bin', TMPDIR: '/fresh', TEMP: '/fresh', TMP: '/fresh' });
});

test('a run counts as having run tests from the summary of either reporter: TAP (Node 22 piped default) or spec', () => {
  assert.equal(suiteRanTests('ok 1 - a\n1..1\n# tests 1\n# suites 0\n# pass 1\n'), true);
  assert.equal(suiteRanTests('✔ a (1ms)\nℹ tests 12\nℹ pass 12\n'), true);
});

test('a run that reports zero tests, or only mentions a count inside a test name, did not run tests', () => {
  assert.equal(suiteRanTests('1..0\n# tests 0\n# pass 0\n'), false);
  assert.equal(suiteRanTests('ℹ tests 0\nℹ pass 0\n'), false);
  assert.equal(suiteRanTests('ok 1 - prints ℹ tests 3 in its name\n'), false);
  assert.equal(suiteRanTests(''), false);
});

test('Given the child test runner prints TAP, the guard still sees the suite run and lists what it left', () => {
  const dir = tempDir('tmp-guard-tap-');
  fs.writeFileSync(path.join(dir, 'a.spec.mjs'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${saved ?? ''} --test-reporter=tap`.trim();
  try {
    const r = runSuiteInFreshTmp(dir, 'none');
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /^# tests 1$/m, 'the child really printed TAP');
    assert.deepEqual(r.leftovers, []);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});
