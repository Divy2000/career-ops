import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runSuiteInFreshTmp, specsWithoutTmpCheck, suiteEnv, suiteRanTests, tempDir } from '../tmp.mjs';

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
  // Any reporter the caller set is replaced: two reporters for one destination is an error.
  process.env.NODE_OPTIONS = `${(saved ?? '').replace(/--test-reporter[= ]\S+/g, '')} --test-reporter=tap`.trim();
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

test('the guard child keeps only a spec or tap reporter from the caller\'s NODE_OPTIONS, so it prints a summary the guard can read (SW4-tests-27)', () => {
  const env = suiteEnv({ PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=4096 --test-reporter=dot --test-reporter-destination=out.txt --test-reporter junit' }, '/fresh');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(suiteEnv({ NODE_OPTIONS: '--test-reporter=tap' }, '/fresh').NODE_OPTIONS, '--test-reporter=tap');
  assert.equal(suiteEnv({ NODE_OPTIONS: '--test-reporter spec' }, '/fresh').NODE_OPTIONS, '--test-reporter spec');
});

test('Given NODE_OPTIONS sends a spec and a tap report to two destinations, the guard child keeps only the first reporter, since node --test refuses two reporters with no destinations', () => {
  const opts = '--test-reporter=spec --test-reporter-destination=stdout --test-reporter tap --test-reporter-destination out.tap';
  assert.equal(suiteEnv({ NODE_OPTIONS: opts }, '/fresh').NODE_OPTIONS, '--test-reporter=spec');
  const dir = tempDir('tmp-guard-two-');
  fs.writeFileSync(path.join(dir, 'a.spec.mjs'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = opts;
  try {
    const r = runSuiteInFreshTmp(dir, 'none');
    assert.equal(r.status, 0, r.output);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

test('Given NODE_OPTIONS asks for the dot reporter, the guard still sees the suite run', () => {
  const dir = tempDir('tmp-guard-dot-');
  fs.writeFileSync(path.join(dir, 'a.spec.mjs'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--test-reporter=dot';
  try {
    const r = runSuiteInFreshTmp(dir, 'none');
    assert.equal(r.status, 0, r.output);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

test('Given the caller exports FORCE_COLOR, the guard child prints a plain summary the guard can read (SW5-tests-18)', () => {
  assert.equal('FORCE_COLOR' in suiteEnv({ PATH: '/bin', FORCE_COLOR: '1' }, '/fresh'), false);
  const dir = tempDir('tmp-guard-color-');
  fs.writeFileSync(path.join(dir, 'a.spec.mjs'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  const saved = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    const r = runSuiteInFreshTmp(dir, 'none');
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.output, /\x1b\[/);
  } finally {
    if (saved === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = saved;
  }
});

const TMP_MJS = new URL('../tmp.mjs', import.meta.url).href;

/** Runs one fixture spec under node --test with a fresh TMPDIR; returns the run and what it left in that TMPDIR. */
function runFixtureSpec(source) {
  const dir = tempDir('tmp-check-spec-');
  const fresh = tempDir('tmp-check-fresh-');
  const file = path.join(dir, 'fixture.spec.mjs');
  fs.writeFileSync(file, source);
  const r = spawnSync(process.execPath, ['--test', file], { env: suiteEnv(process.env, fresh), encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, leftovers: fs.readdirSync(fresh).sort() };
}

test('Given a spec that loads tmp.mjs leaves a file in the temp dir, its run fails naming the file and the temp dir is still left empty (R34-flake-tmpguard)', () => {
  const r = runFixtureSpec(`import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ${JSON.stringify(TMP_MJS)};
test('leaks', () => { fs.writeFileSync(path.join(os.tmpdir(), 'leaked-file'), 'x'); });
`);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /leaked-file/);
  assert.deepEqual(r.leftovers, []);
});

test('Given a child process of a spec that loads tmp.mjs leaves a dir in $TMPDIR, the spec run fails naming it (R34-flake-tmpguard)', () => {
  const r = runFixtureSpec(`import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import ${JSON.stringify(TMP_MJS)};
test('child leaks', () => { spawnSync('sh', ['-c', 'mkdir "$TMPDIR/leaked-by-child"']); });
`);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /leaked-by-child/);
  assert.deepEqual(r.leftovers, []);
});

test('Given a spec that loads tmp.mjs cleans up after itself, its run passes and leaves nothing in the temp dir: the check reports no false leftover (R34-flake-tmpguard control)', () => {
  const r = runFixtureSpec(`import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from ${JSON.stringify(TMP_MJS)};
test('uses a temp dir', () => { fs.writeFileSync(path.join(tempDir('kept-'), 'f'), 'x'); });
`);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.leftovers, []);
});

test('Given a spec that loads tmp.mjs removes its own private temp dir, its run passes instead of crashing on ENOENT at exit (R34-flake-tmpguard FC-02)', () => {
  const r = runFixtureSpec(`import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import ${JSON.stringify(TMP_MJS)};
test('removes the temp dir', () => { fs.rmSync(os.tmpdir(), { recursive: true, force: true }); });
`);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /ENOENT/);
  assert.deepEqual(r.leftovers, []);
});

test('specsWithoutTmpCheck lists the specs whose imports never reach tmp.mjs, following relative helpers and ignoring imports commented out by line or block (R34-flake-tmpguard)', () => {
  const dir = tempDir('tmp-check-graph-');
  const support = path.join(dir, 'test-support');
  const tests = path.join(dir, 'suite', 'tests');
  fs.mkdirSync(support);
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(support, 'tmp.mjs'), '');
  fs.writeFileSync(path.join(tests, 'helper.mjs'), "import { tempDir } from '../../test-support/tmp.mjs';\nexport const x = 1;\n");
  fs.writeFileSync(path.join(tests, 'direct.spec.mjs'), "import { test } from 'node:test';\nimport '../../test-support/tmp.mjs';\n");
  fs.writeFileSync(path.join(tests, 'via-helper.spec.mjs'), "import {\n  x,\n} from './helper.mjs';\n");
  fs.writeFileSync(path.join(tests, 'commented.spec.mjs'), "// import '../../test-support/tmp.mjs';\nimport { test } from 'node:test';\n");
  fs.writeFileSync(path.join(tests, 'block-comment.spec.mjs'), "/*\nimport '../../test-support/tmp.mjs';\n*/\nimport { test } from 'node:test';\n");
  fs.writeFileSync(path.join(tests, 'none.spec.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\n");
  fs.writeFileSync(path.join(tests, 'notes.md'), "import '../../test-support/tmp.mjs';\n");
  assert.deepEqual(specsWithoutTmpCheck(tests, path.join(support, 'tmp.mjs')), ['block-comment.spec.mjs', 'commented.spec.mjs', 'none.spec.mjs']);
});

test('Given a spec that loads tmp.mjs handles SIGTERM itself and keeps running, its temp dir stays usable and what it leaves is still reported (R34-flake-tmpguard fix check 2)', async () => {
  const dir = tempDir('tmp-check-signal-');
  const fresh = tempDir('tmp-check-fresh-');
  const file = path.join(dir, 'fixture.spec.mjs');
  fs.writeFileSync(file, `import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ${JSON.stringify(TMP_MJS)};
test('survives SIGTERM', async () => {
  const alive = setInterval(() => {}, 1000);
  const got = new Promise((r) => process.once('SIGTERM', r));
  fs.writeFileSync(path.join(${JSON.stringify(fresh)}, 'pid'), String(process.pid));
  await got;
  clearInterval(alive);
  fs.writeFileSync(path.join(os.tmpdir(), 'after-signal'), 'x');
});
`);
  const runner = spawn(process.execPath, ['--test', file], { env: suiteEnv(process.env, fresh), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  runner.stdout.on('data', (d) => { output += d; });
  runner.stderr.on('data', (d) => { output += d; });
  try {
    const pidFile = path.join(fresh, 'pid');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8')) {
      assert.ok(Date.now() < deadline, 'the fixture spec never started');
      await new Promise((r) => setTimeout(r, 50));
    }
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    await new Promise((r) => (runner.exitCode !== null || runner.signalCode !== null ? r() : runner.once('close', r)));
    fs.rmSync(pidFile);
    assert.notEqual(runner.exitCode, 0, output);
    assert.match(output, /left 1 entry in its temp dir \(now removed\): after-signal/);
    assert.deepEqual(fs.readdirSync(fresh), []);
  } finally {
    runner.kill('SIGKILL');
  }
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`Given a spec that loads tmp.mjs is killed by ${signal} mid-test, its private temp dir is still removed (R34-flake-tmpguard fix check)`, async () => {
    const dir = tempDir('tmp-check-signal-');
    const fresh = tempDir('tmp-check-fresh-');
    const file = path.join(dir, 'fixture.spec.mjs');
    fs.writeFileSync(file, `import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ${JSON.stringify(TMP_MJS)};
test('waits', async () => {
  fs.writeFileSync(path.join(${JSON.stringify(fresh)}, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(os.tmpdir(), 'in-flight'), 'x');
  await new Promise((r) => setTimeout(r, 60_000));
});
`);
    const runner = spawn(process.execPath, ['--test', file], { env: suiteEnv(process.env, fresh), stdio: 'ignore' });
    try {
      const pidFile = path.join(fresh, 'pid');
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8')) {
        assert.ok(Date.now() < deadline, 'the fixture spec never started');
        await new Promise((r) => setTimeout(r, 50));
      }
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), signal);
      await new Promise((r) => (runner.exitCode !== null || runner.signalCode !== null ? r() : runner.once('exit', r)));
      fs.rmSync(pidFile);
      assert.deepEqual(fs.readdirSync(fresh), []);
    } finally {
      runner.kill('SIGKILL');
    }
  });
}

/** Starts one fixture module under plain node (no test runner in between) with a fresh TMPDIR. */
function startFixture(source) {
  const dir = tempDir('tmp-check-plain-');
  const fresh = tempDir('tmp-check-fresh-');
  const file = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(file, source.replaceAll('FRESH', JSON.stringify(fresh)));
  const child = spawn(process.execPath, [file], { env: suiteEnv(process.env, fresh), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const closed = new Promise((r) => child.once('close', (code, signal) => r({ code, signal, output, leftovers: fs.readdirSync(fresh).sort() })));
  return { child, fresh, closed };
}

test('Given a spec that loads tmp.mjs leaves a file in its temp dir and its tests pass, the spec process exits with status 1, the status a failing test gives (R34-mut-06)', async () => {
  const { child, closed } = startFixture(`import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ${JSON.stringify(TMP_MJS)};
fs.writeFileSync(path.join(os.tmpdir(), 'leaked-file'), 'x');
`);
  try {
    const r = await closed;
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /left 1 entry in its temp dir \(now removed\): leaked-file/);
    assert.deepEqual(r.leftovers, []);
  } finally {
    child.kill('SIGKILL');
  }
});

test('Given a spec that loads tmp.mjs removed its own temp dir and is then killed by SIGTERM, it still dies by SIGTERM instead of crashing on ENOENT (R34-mut-04)', async () => {
  const { child, fresh, closed } = startFixture(`import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ${JSON.stringify(TMP_MJS)};
fs.rmSync(os.tmpdir(), { recursive: true, force: true });
setInterval(() => {}, 1000);
fs.writeFileSync(path.join(FRESH, 'ready'), String(process.pid));
`);
  try {
    const ready = path.join(fresh, 'ready');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(ready) || !fs.readFileSync(ready, 'utf8')) {
      assert.ok(Date.now() < deadline, 'the fixture never started');
      await new Promise((r) => setTimeout(r, 50));
    }
    fs.rmSync(ready);
    child.kill('SIGTERM');
    const r = await closed;
    assert.equal(r.signal, 'SIGTERM', r.output);
    assert.doesNotMatch(r.output, /ENOENT/);
    assert.deepEqual(r.leftovers, []);
  } finally {
    child.kill('SIGKILL');
  }
});

/** A suite dir with an empty test-support/tmp.mjs and the given files in suite/tests; returns specsWithoutTmpCheck over it. */
function graphFixture(files) {
  const dir = tempDir('tmp-check-graph-');
  const support = path.join(dir, 'test-support');
  const tests = path.join(dir, 'suite', 'tests');
  fs.mkdirSync(support);
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(support, 'tmp.mjs'), '');
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(tests, name), source);
  return specsWithoutTmpCheck(tests, path.join(support, 'tmp.mjs'));
}

test('specsWithoutTmpCheck lists a spec whose relative imports exist but never reach tmp.mjs, or do not exist (R34-mut-09)', () => {
  assert.deepEqual(graphFixture({
    'plain-helper.mjs': "import fs from 'node:fs';\nexport const y = 1;\n",
    'helper-only.spec.mjs': "import { y } from './plain-helper.mjs';\n",
    'missing.spec.mjs': "import './no-such-helper.mjs';\n",
    'missing-then-tmp.spec.mjs': "import './no-such-helper.mjs';\nimport '../../test-support/tmp.mjs';\n",
  }), ['helper-only.spec.mjs', 'missing.spec.mjs']);
});

test('specsWithoutTmpCheck lists a spec whose helpers import each other in a cycle that never reaches tmp.mjs (R34-mut-08)', () => {
  assert.deepEqual(graphFixture({
    'cycle-a.mjs': "import './cycle-b.mjs';\n",
    'cycle-b.mjs': "import './cycle-a.mjs';\n",
    'cycle.spec.mjs': "import './cycle-a.mjs';\nimport './cycle-b.mjs';\n",
    'cycle-then-tmp.spec.mjs': "import './cycle-a.mjs';\nimport '../../test-support/tmp.mjs';\n",
  }), ['cycle.spec.mjs']);
});

test('specsWithoutTmpCheck lists a spec whose only mention of tmp.mjs is an import line inside a template string, while quotes in a regex and comment openers in a string hide no real import (R34 leftover)', () => {
  const tmpImport = "import '../../test-support/tmp.mjs';";
  assert.deepEqual(graphFixture({
    'template.spec.mjs': `import { test } from 'node:test';\nconst fixture = \`\n${tmpImport}\n\`;\n`,
    'nested-template.spec.mjs': `const fixture = \`a \${\`b\`} \${{ x: 1 }.x}\n${tmpImport}\n\`;\n`,
    'after-template.spec.mjs': `const fixture = \`\${'}'}\`;\nconst quote = /["'\`]/;\n${tmpImport}\n`,
    'glob-string.spec.mjs': `const glob = '**/*.spec.mjs';\n${tmpImport}\nconst end = '*/';\n`,
  }), ['nested-template.spec.mjs', 'template.spec.mjs']);
});

test('specsWithoutTmpCheck reads an export of a quoted value as a value, not an import, and still follows export ... from (R34 leftover)', () => {
  assert.deepEqual(graphFixture({
    'root.mjs': "import { join } from 'node:path';\nexport const ROOT = join(import.meta.dirname, '..');\nexport const TMP = '../../test-support/tmp.mjs';\n",
    'reexport-all.mjs': "export * from '../../test-support/tmp.mjs';\n",
    'reexport-named.mjs': "export {\n  tempDir,\n} from '../../test-support/tmp.mjs';\n",
    'value-export.spec.mjs': "import { ROOT } from './root.mjs';\n",
    'export-all.spec.mjs': "import './reexport-all.mjs';\n",
    'export-named.spec.mjs': "import { tempDir } from './reexport-named.mjs';\n",
  }), ['value-export.spec.mjs']);
});

test('specsWithoutTmpCheck tells template text from its substitutions: escapes, a lone $ or {, and a comment opening a substitution keep an import line inside the template (R34 leftover)', () => {
  const tmpImport = "import '../../test-support/tmp.mjs';";
  assert.deepEqual(graphFixture({
    'odd-template.spec.mjs': 'const t = `abc`;\n' + tmpImport + '\n',
    'substitution.spec.mjs': 'const t = `${a}`;\n' + tmpImport + '\n',
    'escaped-backtick.spec.mjs': 'const t = `a\\`b\n' + tmpImport + '\n`;\n',
    'escaped-substitution.spec.mjs': 'const t = `\\${\n' + tmpImport + '\n`;\n',
    'backtick-string.spec.mjs': "const t = `${'`'}\n" + tmpImport + '\n`;\n',
    'lone-brace.spec.mjs': 'const t = `a{\n' + tmpImport + '\n`;\n',
    'lone-dollar.spec.mjs': 'const t = `$x\n' + tmpImport + '\n`;\n',
    'comment-substitution.spec.mjs': 'const t = `${/*\n' + tmpImport + '\n*/1}`;\n',
  }), ['backtick-string.spec.mjs', 'comment-substitution.spec.mjs', 'escaped-backtick.spec.mjs', 'escaped-substitution.spec.mjs', 'lone-brace.spec.mjs', 'lone-dollar.spec.mjs']);
});

test('specsWithoutTmpCheck ends a block comment only at its own */, so /*/ stays open, /**/ closes, code right after */ is read and an unclosed comment hides the rest (R34 leftover)', () => {
  const tmpImport = "import '../../test-support/tmp.mjs';";
  assert.deepEqual(graphFixture({
    'slash-star-slash.spec.mjs': '/*/\n' + tmpImport + '\n*/\n',
    'empty-comment.spec.mjs': '/**/\n' + tmpImport + '\n',
    'comment-then-import.spec.mjs': '/* note */' + tmpImport + '\n',
    'unclosed-comment.spec.mjs': '/*\n' + tmpImport + '\n',
  }), ['slash-star-slash.spec.mjs', 'unclosed-comment.spec.mjs']);
});
