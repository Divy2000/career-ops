import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../tmp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const survivors = path.join(here, '../survivors.mjs');
const mutate = path.join(here, '../mutate.mjs');
const repo = path.resolve(here, '../../..');

const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

function mutant(id, status, mutatorName, start, end, replacement) {
  return { id, status, mutatorName, location: { start, end }, replacement };
}

function writeReport(report) {
  const file = path.join(tempDir('survivors-'), 'mutation.json');
  fs.writeFileSync(file, JSON.stringify(report));
  return file;
}

test('survivors prints one line per surviving mutant, file:line | mutator | original -> mutated, sorted by file and line', () => {
  const report = {
    projectRoot: path.join(repo, 'custom/immigration'),
    files: {
      'lib.mjs': {
        source: 'const a = 1;\nif (a > 0) {\n  run();\n}\n',
        mutants: [
          mutant('2', 'Survived', 'BlockStatement', { line: 2, column: 12 }, { line: 4, column: 2 }, '{}'),
          mutant('1', 'Survived', 'EqualityOperator', { line: 2, column: 5 }, { line: 2, column: 10 }, 'a >= 0'),
          mutant('3', 'Killed', 'BooleanLiteral', { line: 1, column: 11 }, { line: 1, column: 12 }, '0'),
          mutant('4', 'NoCoverage', 'StringLiteral', { line: 1, column: 1 }, { line: 1, column: 6 }, '""'),
        ],
      },
      'a.mjs': { source: 'x || y\n', mutants: [mutant('5', 'Survived', 'LogicalOperator', { line: 1, column: 1 }, { line: 1, column: 7 }, 'x && y')] },
    },
  };
  const r = node(survivors, [writeReport(report)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    'custom/immigration/a.mjs:1 | LogicalOperator | x || y -> x && y',
    'custom/immigration/lib.mjs:2 | EqualityOperator | a > 0 -> a >= 0',
    'custom/immigration/lib.mjs:2 | BlockStatement | { run(); } -> {}',
  ]);
});

test('survivors reads Stryker 1-based columns and prints exactly the source text each mutant replaced', () => {
  const report = {
    projectRoot: path.join(repo, 'custom/immigration'),
    files: { 'lib.mjs': { source: "if (typeof x !== 'string') {}\n", mutants: [mutant('1', 'Survived', 'StringLiteral', { line: 1, column: 18 }, { line: 1, column: 26 }, '""'), mutant('2', 'Survived', 'ConditionalExpression', { line: 1, column: 5 }, { line: 1, column: 26 }, 'true')] } },
  };
  const r = node(survivors, [writeReport(report)]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    "custom/immigration/lib.mjs:1 | ConditionalExpression | typeof x !== 'string' -> true",
    'custom/immigration/lib.mjs:1 | StringLiteral | \'string\' -> ""',
  ]);
});

test('survivors reads several reports in one call', () => {
  const one = (root, file) => ({ projectRoot: path.join(repo, root), files: { [file]: { source: 'a\n', mutants: [mutant('1', 'Survived', 'StringLiteral', { line: 1, column: 1 }, { line: 1, column: 2 }, 'b')] } } });
  const r = node(survivors, [writeReport(one('custom/control-center', 'server/x.ts')), writeReport(one('custom/pipeline', 'lib.mjs'))]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), ['custom/control-center/server/x.ts:1 | StringLiteral | a -> b', 'custom/pipeline/lib.mjs:1 | StringLiteral | a -> b']);
});

test('survivors with no report argument prints usage and exits 2', () => {
  const r = node(survivors, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node custom\/test-support\/survivors\.mjs/);
});

test('survivors refuses a JSON file that is not a Stryker report', () => {
  const r = node(survivors, [writeReport({ files: {} })]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has no projectRoot; it is not a Stryker mutation\.json report/);
});

test('mutate with no package prints usage and exits 2', () => {
  const r = node(mutate, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node custom\/test-support\/mutate\.mjs <package>/);
});

test('mutate refuses a package without node:test specs, and a path outside custom/', () => {
  for (const pkg of ['control-center', '../career-ops', 'no-such-package']) {
    const r = node(mutate, [pkg]);
    assert.equal(r.status, 2, pkg);
    assert.match(r.stderr, /has no tests\/\*\.spec\.mjs/, pkg);
  }
});

const leftovers = path.join(here, '../stryker-leftovers.mjs');

test('stryker-leftovers passes when no file under the given folders carries Stryker instrumentation', () => {
  const dir = tempDir('leftovers-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub/a.ts'), 'export const a = 1;\n');
  const r = node(leftovers, [dir]);
  assert.equal(r.status, 0, r.stderr);
});

test('stryker-leftovers fails, naming each instrumented file and the restore command, when a killed run left one behind', () => {
  const dir = tempDir('leftovers-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub/a.ts'), 'function stryNS_9fa48() {}\nexport const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.mjs'), 'export const b = 2;\n');
  const r = node(leftovers, [dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sub\/a\.ts/);
  assert.doesNotMatch(r.stderr, /b\.mjs/);
  assert.match(r.stderr, /git checkout/);
});

test('stryker-leftovers skips node_modules and Stryker\'s own temp and report folders', () => {
  const dir = tempDir('leftovers-');
  for (const sub of ['node_modules/x', '.stryker-tmp/backup', 'reports']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, 'a.js'), 'function stryNS_1() {}\n');
  }
  const r = node(leftovers, [dir]);
  assert.equal(r.status, 0, r.stderr);
});

test('blockClaude puts a claude that always fails first on PATH, so a mutant cannot reach the real CLI', async () => {
  const { blockClaude } = await import('../no-claude.mjs');
  const dir = tempDir('no-claude-');
  const env = blockClaude(dir, { PATH: '/usr/bin:/bin', HOME: '/home/me' });
  assert.equal(env.HOME, '/home/me');
  assert.equal(env.PATH, `${dir}${path.delimiter}/usr/bin:/bin`);
  const r = spawnSync('claude', ['-p', 'hi'], { env, encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /claude is blocked during mutation testing/);
});

test('blockClaude marks the env as blocked, so a test that checks the real CLI skips instead of failing the dry run', async () => {
  const { blockClaude, CLAUDE_BLOCKED_ENV } = await import('../no-claude.mjs');
  const env = blockClaude(tempDir('no-claude-'), { PATH: '/usr/bin:/bin' });
  assert.equal(CLAUDE_BLOCKED_ENV, 'CC_CLAUDE_BLOCKED');
  assert.equal(env[CLAUDE_BLOCKED_ENV], '1');
});
