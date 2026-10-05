import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HERE, '..', 'sync.sh');
const LIB = path.join(HERE, '..', 'lib.sh');

function stub(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(path.join(dir, name), 0o755);
}

/** The lines of sync.sh from the one starting with `first` through the next one matching `last`. */
function block(first, last) {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith(first));
  assert.ok(from > -1, `no line starting with ${first}`);
  const to = lines.findIndex((l, i) => i >= from && last.test(l));
  return lines.slice(from, to + 1).join('\n');
}

test('the headless sync Claude gets the OAuth token but runs with subprocess env scrubbing, so Bash children (tests, npm scripts) never see it', () => {
  const dir = tempDir('sync-claude-');
  const bin = path.join(dir, 'bin');
  const seen = path.join(dir, 'env.txt');
  stub(bin, 'claude', `env > "${seen}"`);
  const script = `TOKEN=tok-123 MODEL=m STATE_DIR="${dir}" PROMPT=p\n${block('CLAUDE_CODE_OAUTH_TOKEN=', /--output-format text/)}`;
  const r = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(seen, 'utf8');
  assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=tok-123$/m);
  assert.match(env, /^CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1$/m);
  assert.match(env, /^ANTHROPIC_API_KEY=$/m);
});

// npm stub: logs each call's arguments; `npm ... test` prints what vitest prints, or fails when told to.
function npmWorld({ testExit = 0, testOutput = ' Test Files  3 passed (3)\n      Tests  42 passed (42)' } = {}) {
  const dir = tempDir('sync-cc-');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  stub(bin, 'npm', `echo "$*" >> "${calls}"\ncase " $* " in *" test "*) printf '%s\\n' "${testOutput}"; exit ${testExit};; esac`);
  const run = () => spawnSync('bash', ['-c', `source "${LIB}"\ncontrol_center_checks "${dir}/cc.log"`], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { dir, calls, run, log: () => readFileSync(path.join(dir, 'cc.log'), 'utf8'), callList: () => readFileSync(calls, 'utf8').trim().split('\n') };
}

test('control_center_checks installs control-center from its lockfile without scripts, then runs its tests and typecheck, logging all of it', () => {
  const w = npmWorld();
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  const calls = w.callList();
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^--prefix custom\/control-center ci\b.*--ignore-scripts/);
  assert.match(calls[1], /^--prefix custom\/control-center test$/);
  assert.match(calls[2], /^--prefix custom\/control-center run typecheck$/);
  assert.match(w.log(), /Tests +42 passed/);
});

test('control_center_checks fails when the tests fail, and runs nothing after the failing step', () => {
  const w = npmWorld({ testExit: 1, testOutput: ' Tests  1 failed | 41 passed (42)' });
  assert.notEqual(w.run().status, 0);
  assert.equal(w.callList().length, 2);
});

test('control_center_checks fails when no test ran, even if npm exits 0', () => {
  const w = npmWorld({ testOutput: 'No test files found, exiting with code 0' });
  assert.notEqual(w.run().status, 0);
});

// node stub: logs each call's arguments and prints what `node --test` prints, in the given reporter's format.
function customTestsWorld({ exit = 0, output }) {
  const dir = tempDir('sync-custom-');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.txt');
  mkdirSync(path.join(dir, 'custom/a/tests'), { recursive: true });
  writeFileSync(path.join(dir, 'custom/a/tests/a.spec.mjs'), '');
  stub(bin, 'node', `echo "$*" >> "${calls}"\nprintf '%s\\n' "${output}"\nexit ${exit}`);
  const run = () => spawnSync('bash', ['-c', `source "${LIB}"\ncustom_tests "${dir}/custom.log"`], { cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { run, log: () => readFileSync(path.join(dir, 'custom.log'), 'utf8'), calls: () => readFileSync(calls, 'utf8').trim() };
}

test('custom_tests passes on the TAP summary Node 22 prints when output goes to a file', () => {
  const w = customTestsWorld({ output: 'ok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 0' });
  assert.equal(w.run().status, 0);
  assert.equal(w.calls(), '--test custom/a/tests/a.spec.mjs');
  assert.match(w.log(), /^# pass 1$/m);
});

test('custom_tests passes on the spec reporter summary Node 23+ prints', () => {
  assert.equal(customTestsWorld({ output: '✔ a (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0' }).run().status, 0);
});

test('custom_tests fails when a test fails, and when no test ran even if node exits 0', () => {
  assert.notEqual(customTestsWorld({ exit: 1, output: '# tests 2\n# pass 1\n# fail 1' }).run().status, 0);
  assert.notEqual(customTestsWorld({ output: '1..0\n# tests 0\n# pass 0' }).run().status, 0);
  assert.notEqual(customTestsWorld({ output: 'ℹ tests 0\nℹ pass 0' }).run().status, 0);
});

test('sync.sh runs the control-center checks after the custom tests and before pushing', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const custom = sync.indexOf('custom_tests "$STATE_DIR/$TODAY.custom-tests.txt"');
  const cc = sync.indexOf('control_center_checks "$STATE_DIR/$TODAY.control-center-tests.txt"');
  const push = sync.indexOf('git push');
  assert.ok(custom > -1 && cc > custom && push > cc, `order was custom=${custom} cc=${cc} push=${push}`);
});

const GREEN = { CUSTOM_OK: '1', CC_OK: '1', NEW_FAILURES: '', AUTO_MERGE: '1', KEPT_README: '0', UNEXPECTED_UPSTREAM: '' };
// Each gate that must hold the PR for a human, alone, and the reason the PR comment gives for it.
const BLOCKING = [
  [{ CUSTOM_OK: '0' }, 'custom tests FAIL'],
  [{ CC_OK: '0' }, 'control-center tests and typecheck FAIL'],
  [{ NEW_FAILURES: '❌ cost check\n❌ scan dedupe' }, 'new upstream-suite failures: ❌ cost check, ❌ scan dedupe'],
  [{ AUTO_MERGE: '0' }, 'run with --no-merge'],
  [{ KEPT_README: '1' }, 'fork README kept over an upstream .github/README.md (compare by hand)'],
  [{ UNEXPECTED_UPSTREAM: 'scan.mjs\nmodes/oferta.md' }, 'upstream files edited outside conflict resolution: scan.mjs, modes/oferta.md'],
];

function mergeBlockers(vars) {
  const r = spawnSync('bash', ['-c', `set -u\nsource "${LIB}"\nmerge_blockers`], { env: { PATH: '/usr/bin:/bin', ...vars }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('merge_blockers finds nothing when every gate is green', () => {
  assert.equal(mergeBlockers(GREEN), '');
});

test('merge_blockers names each gate that holds the PR, alone or together', () => {
  for (const [held, why] of BLOCKING) assert.equal(mergeBlockers({ ...GREEN, ...held }), why);
  assert.equal(mergeBlockers({ ...GREEN, CUSTOM_OK: '0', KEPT_README: '1' }), 'custom tests FAIL; fork README kept over an upstream .github/README.md (compare by hand)');
});

test('merge_blockers holds the PR when a gate was never decided', () => {
  assert.equal(mergeBlockers({}).split('; ').length, 4, 'the four pass/fail flags block when unset; empty failure lists do not');
});

test('sync.sh auto-merges exactly when merge_blockers finds nothing', () => {
  const decide = (vars) => spawnSync('bash', ['-c', `source "${LIB}"\n${block('BLOCKERS="$(merge_blockers)"', /^if \[ -z "\$BLOCKERS" \]; then$/)}\necho merge\nelse\necho hold\nfi`], { env: { PATH: '/usr/bin:/bin', ...vars }, encoding: 'utf8' }).stdout.trim();
  assert.equal(decide(GREEN), 'merge');
  for (const [held] of BLOCKING) assert.equal(decide({ ...GREEN, ...held }), 'hold', JSON.stringify(held));
});

test('sync.sh tells the PR why it was not auto-merged', () => {
  assert.ok(readFileSync(SYNC, 'utf8').includes('gh pr comment "$PR_URL" --body "Not auto-merged: $BLOCKERS."'));
});

test('unexpected_upstream lists the upstream files that differ but did not conflict', () => {
  const run = (changed, conflicts) => spawnSync('bash', ['-c', `source "${LIB}"\nunexpected_upstream "$C" "$K"`], { env: { PATH: '/usr/bin:/bin', C: changed, K: conflicts }, encoding: 'utf8' }).stdout;
  assert.equal(run('', ''), '');
  assert.equal(run('scan.mjs\nmodes/oferta.md', 'modes/oferta.md'), 'scan.mjs\n');
  assert.equal(run('modes/oferta.md', 'modes/oferta.md\ncustom/a.mjs'), '');
  assert.equal(run('scan.mjs', 'scan.mjs.bak'), 'scan.mjs\n', 'whole names, not prefixes');
});

test('sync.sh blocks on upstream edits outside the conflicts it handed Claude', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const changed = sync.indexOf('CHANGED_UPSTREAM="$(git diff');
  const unexpected = sync.indexOf('UNEXPECTED_UPSTREAM="$(unexpected_upstream "$CHANGED_UPSTREAM" "$CONFLICTS")"');
  const decide = sync.indexOf('BLOCKERS="$(merge_blockers)"');
  assert.ok(changed > -1 && unexpected > changed && decide > unexpected, `order was changed=${changed} unexpected=${unexpected} decide=${decide}`);
});

// node stub for `node test-all.mjs --quick`: prints the given output and exits with the given code.
function suiteWorld({ exit = 0, output }) {
  const dir = tempDir('sync-suite-');
  stub(path.join(dir, 'bin'), 'node', `printf '%s\\n' "${output}"\nexit ${exit}`);
  const run = (script) => spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], { cwd: dir, env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { dir, run, read: (f) => readFileSync(path.join(dir, f), 'utf8') };
}

test('suite_failures records each failing test once, sorted, from a run that finished', () => {
  const w = suiteWorld({ exit: 1, output: '  ✅ ok one\n  ❌ zeta broke\n  ❌ alpha broke\n  ❌ zeta broke\nResults: 1 passed, 3 failed' });
  assert.equal(w.run(`suite_failures "${w.dir}/f.txt"`).status, 0);
  assert.equal(w.read('f.txt'), '❌ alpha broke\n❌ zeta broke\n');
});

test('suite_failures records a run with no Results summary as a crash, never as no failures', () => {
  const w = suiteWorld({ exit: 3, output: 'TypeError: boom' });
  w.run(`suite_failures "${w.dir}/f.txt"`);
  assert.match(w.read('f.txt'), /^SUITE CRASHED \(exit 3, no Results summary; see .*f\.txt\.raw\)$/m);
});

test('new_failures counts only failures that are not in the baseline, and a crash after the merge is one', () => {
  const w = suiteWorld({ output: '' });
  writeFileSync(path.join(w.dir, 'base.txt'), '❌ alpha broke\n');
  writeFileSync(path.join(w.dir, 'after.txt'), '❌ alpha broke\n❌ beta broke\n');
  assert.equal(w.run('new_failures base.txt after.txt').stdout, '❌ beta broke\n');
  writeFileSync(path.join(w.dir, 'after.txt'), '❌ alpha broke\n');
  assert.equal(w.run('new_failures base.txt after.txt').stdout, '');
  writeFileSync(path.join(w.dir, 'after.txt'), 'SUITE CRASHED (exit 1, no Results summary; see x)\n');
  assert.match(w.run('new_failures base.txt after.txt').stdout, /^SUITE CRASHED/);
});

test('sync.sh compares the upstream suite through suite_failures and new_failures', () => {
  const sync = readFileSync(SYNC, 'utf8');
  assert.match(sync, /^suite_failures "\$STATE_DIR\/\$TODAY\.baseline-failures\.txt"$/m);
  assert.match(sync, /^suite_failures "\$STATE_DIR\/\$TODAY\.after-failures\.txt"$/m);
  assert.match(sync, /^NEW_FAILURES="\$\(new_failures "\$STATE_DIR\/\$TODAY\.baseline-failures\.txt" "\$STATE_DIR\/\$TODAY\.after-failures\.txt"\)"$/m);
});

test('the sync prompt carries the baseline failures and conflicts verbatim, even when they hold $ replacement patterns', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('PROMPT="$('));
  const to = lines.findIndex((l, i) => i > from && l.includes('sync-prompt.md")"'));
  const snippet = lines.slice(from, to + 1).join('\n').replace('"$LIVE/custom/upstream-sync/sync-prompt.md"', `"${path.join(HERE, '..', 'sync-prompt.md')}"`);
  const baseline = "❌ cost check: expected $& got $$5 ($` and $')";
  // cat stands in for reading the baseline-failures file.
  const script = `STATE_DIR=/s TODAY=2026-10-04 BEHIND=3 CONFLICTS='a $& b'\ncat() { printf '%s' "$BASELINE_TEXT"; }\n${snippet}\nprintf '%s' "$PROMPT"`;
  const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, BASELINE_TEXT: baseline }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(baseline), r.stdout.slice(0, 3000));
  assert.ok(r.stdout.includes('a $& b'));
  assert.equal(r.stdout.includes('{{'), false, 'every placeholder is filled');
});
