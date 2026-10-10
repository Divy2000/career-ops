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
          mutant('2', 'Survived', 'BlockStatement', { line: 2, column: 11 }, { line: 4, column: 1 }, '{}'),
          mutant('1', 'Survived', 'EqualityOperator', { line: 2, column: 4 }, { line: 2, column: 9 }, 'a >= 0'),
          mutant('3', 'Killed', 'BooleanLiteral', { line: 1, column: 10 }, { line: 1, column: 11 }, '0'),
          mutant('4', 'NoCoverage', 'StringLiteral', { line: 1, column: 0 }, { line: 1, column: 5 }, '""'),
        ],
      },
      'a.mjs': { source: 'x || y\n', mutants: [mutant('5', 'Survived', 'LogicalOperator', { line: 1, column: 0 }, { line: 1, column: 6 }, 'x && y')] },
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

test('survivors reads several reports in one call', () => {
  const one = (root, file) => ({ projectRoot: path.join(repo, root), files: { [file]: { source: 'a\n', mutants: [mutant('1', 'Survived', 'StringLiteral', { line: 1, column: 0 }, { line: 1, column: 1 }, 'b')] } } });
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
