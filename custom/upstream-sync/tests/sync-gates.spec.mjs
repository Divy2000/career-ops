import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
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
  const script = `TOKEN=tok-123 MODEL=m STATE_DIR="${dir}" PROMPT=p LOG="${dir}/log"\n${block('CLAUDE_OUT="$(CLAUDE_CODE_OAUTH_TOKEN=', /--output-format text/)}`;
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

const GREEN = { CUSTOM_OK: '1', CC_OK: '1', NEW_FAILURES: '', AUTO_MERGE: '1', KEPT_README: '0', UNEXPECTED_UPSTREAM: '', CLAUDE_HOLD: '', PROTECTED_EDITS: '' };
// Each gate that must hold the PR for a human, alone, and the reason the PR comment gives for it.
const BLOCKING = [
  [{ CUSTOM_OK: '0' }, 'custom tests FAIL'],
  [{ CC_OK: '0' }, 'control-center tests and typecheck FAIL'],
  [{ NEW_FAILURES: '❌ cost check\n❌ scan dedupe' }, 'new upstream-suite failures: ❌ cost check, ❌ scan dedupe'],
  [{ AUTO_MERGE: '0' }, 'run with --no-merge'],
  [{ KEPT_README: '1' }, 'fork README kept over an upstream .github/README.md (compare by hand)'],
  [{ UNEXPECTED_UPSTREAM: 'scan.mjs\nmodes/oferta.md' }, 'upstream files edited outside conflict resolution: scan.mjs, modes/oferta.md'],
  [{ CLAUDE_HOLD: 'the sync Claude asked for a human: check X' }, 'the sync Claude asked for a human: check X'],
  [{ PROTECTED_EDITS: 'custom/a/tests/x.spec.mjs\ncustom/upstream-sync/lib.sh' }, 'fork tests, gates or guard files edited by the sync (review by hand): custom/a/tests/x.spec.mjs, custom/upstream-sync/lib.sh'],
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
  assert.equal(mergeBlockers({}).split('; ').length, 5, 'the four pass/fail flags and an unread Claude verdict block when unset; empty failure lists do not');
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

test('sync.sh blocks on upstream edits this run made after the merge, outside the conflicts it handed Claude', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const claude = sync.indexOf('claude -p');
  const changed = sync.indexOf('CHANGED_SINCE_MERGE="$(changed_since_snapshot "$MERGE_SNAPSHOT")" || fail ');
  const unexpected = sync.indexOf('UNEXPECTED_UPSTREAM="$(unexpected_upstream "$CHANGED_SINCE_MERGE" "$CONFLICTS")"');
  assert.ok(changed > claude && unexpected > changed, `changed_since_snapshot at ${changed}, its own statement before ${unexpected}`);
  const decide = sync.indexOf('BLOCKERS="$(merge_blockers)"');
  assert.ok(claude > -1 && unexpected > claude && decide > unexpected, `order was claude=${claude} unexpected=${unexpected} decide=${decide}`);
});

// node stub for `node test-all.mjs --quick`: prints the given output and exits with the given code.
function suiteWorld({ exit = 0, output }) {
  const dir = tempDir('sync-suite-');
  stub(path.join(dir, 'bin'), 'node', `printf '%s\\n' "${output}"\nexit ${exit}`);
  const run = (script) => spawnSync('bash', ['-c', `source "${LIB}"\n${script}`], { cwd: dir, env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8' });
  return { dir, run, read: (f) => readFileSync(path.join(dir, f), 'utf8') };
}

test('suite_failures records each failing test once, sorted, from a run that finished', () => {
  const w = suiteWorld({ exit: 1, output: '  ✅ ok one\n  ❌ zeta broke\n  ❌ alpha broke\n  ❌ zeta broke\n📊 Results: 1 passed, 3 failed, 0 warnings' });
  assert.equal(w.run(`suite_failures "${w.dir}/f.txt"`).status, 0);
  assert.equal(w.read('f.txt'), '❌ alpha broke\n❌ zeta broke\n');
});

test('suite_failures records a run with no Results summary as a crash, never as no failures', () => {
  const w = suiteWorld({ exit: 3, output: 'TypeError: boom' });
  w.run(`suite_failures "${w.dir}/f.txt"`);
  assert.match(w.read('f.txt'), /^SUITE CRASHED \(exit 3, no Results summary; see .*f\.txt\.raw\)$/m);
});

test('suite_failures records a crash after a failing child suite, though the child\'s own Results line was echoed (SW3-tests-02)', () => {
  // test-all copies a failing child suite's stdout into its failure message, child summary line included.
  const w = suiteWorld({ exit: 1, output: '  ❌ tests/agent-inbox-tests.mjs failed:\n      Results: 30 passed, 1 failed\nnode:internal/process: TypeError: boom' });
  w.run(`suite_failures "${w.dir}/f.txt"`);
  assert.match(w.read('f.txt'), /^SUITE CRASHED \(exit 1, no Results summary; see .*\)$/m);
});

test('suite_failures records a crash when the suite exits non-zero with no failure line, summary or not (SW3-tests-02)', () => {
  const w = suiteWorld({ exit: 1, output: '  ✅ ok one\n📊 Results: 1 passed, 0 failed, 0 warnings' });
  w.run(`suite_failures "${w.dir}/f.txt"`);
  assert.match(w.read('f.txt'), /^SUITE CRASHED \(exit 1, /m);
});

test('a clean run of the suite records no failures', () => {
  const w = suiteWorld({ exit: 0, output: '  ✅ ok one\n📊 Results: 1 passed, 0 failed, 0 warnings' });
  assert.equal(w.run(`suite_failures "${w.dir}/f.txt"`).status, 0);
  assert.equal(w.read('f.txt'), '');
});

test('new_failures counts only failures that are not in the baseline text, and a crash after the merge is one', () => {
  const w = suiteWorld({ output: '' });
  const newOnes = (base) => spawnSync('bash', ['-c', `source "${LIB}"\nnew_failures "$B" after.txt`], { cwd: w.dir, env: { PATH: '/usr/bin:/bin', B: base }, encoding: 'utf8' });
  writeFileSync(path.join(w.dir, 'after.txt'), '❌ alpha broke\n❌ beta broke\n');
  assert.equal(newOnes('❌ alpha broke').stdout, '❌ beta broke\n');
  assert.equal(newOnes('').stdout, '❌ alpha broke\n❌ beta broke\n', 'an empty baseline: every failure is new');
  writeFileSync(path.join(w.dir, 'after.txt'), '❌ alpha broke\n');
  assert.equal(newOnes('❌ alpha broke').stdout, '');
  writeFileSync(path.join(w.dir, 'after.txt'), 'SUITE CRASHED (exit 1, no Results summary; see x)\n');
  assert.match(newOnes('❌ alpha broke').stdout, /^SUITE CRASHED/);
});

test('new_failures fails, never prints nothing, when the after-merge failures cannot be read', () => {
  const w = suiteWorld({ output: '' });
  const r = spawnSync('bash', ['-c', `source "${LIB}"\nnew_failures "" missing.txt`], { cwd: w.dir, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('sync.sh reads the baseline once, before Claude runs, and compares against that copy in memory', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const read = sync.indexOf('BASELINE_FAILURES="$(cat "$STATE_DIR/$TODAY.baseline-failures.txt")" || fail ');
  const claude = sync.indexOf('claude -p');
  assert.ok(read > sync.indexOf('suite_failures "$STATE_DIR/$TODAY.baseline-failures.txt"') && read < claude, `baseline read at ${read}`);
  assert.equal(sync.indexOf('baseline-failures.txt', claude), -1, 'nothing after Claude reads the baseline file');
  assert.match(sync, /^suite_failures "\$STATE_DIR\/\$TODAY\.after-failures\.txt"$/m);
  assert.match(sync, /^NEW_FAILURES="\$\(new_failures "\$BASELINE_FAILURES" "\$STATE_DIR\/\$TODAY\.after-failures\.txt"\)" \|\| fail /m);
});

/** sync.sh's own baseline lines, then (after `between`, standing in for Claude) its after-merge comparison, with test-all stubbed. */
function baselineGate({ before, after, between }) {
  const w = suiteWorld({ output: '' });
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const slice = (first, last) => {
    const from = lines.findIndex((l) => l.startsWith(first));
    const to = lines.findIndex((l, i) => i >= from && l.startsWith(last));
    assert.ok(from > -1 && to >= from, `${first} .. ${last} not found in sync.sh`);
    return lines.slice(from, to + 1).join('\n');
  };
  const bin = path.join(w.dir, 'bin');
  const shell = (body, output, env = {}) => {
    stub(bin, 'node', `printf '%s\\n' "${output}"\nexit 1`);
    return spawnSync('bash', ['-c', `source "${LIB}"\nSTATE_DIR="${w.dir}" TODAY=t\nfail() { echo "!!! $1" >&2; exit 1; }\n${body}`], { cwd: w.dir, env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: 'utf8' });
  };
  const first = shell(`${slice('suite_failures "$STATE_DIR/$TODAY.baseline-failures.txt"', 'BASELINE_FAILURES=')}\nprintf '%s' "$BASELINE_FAILURES"`, before);
  assert.equal(first.status, 0, first.stderr);
  between(path.join(w.dir, 't.baseline-failures.txt'));
  const second = shell(`${slice('suite_failures "$STATE_DIR/$TODAY.after-failures.txt"', 'NEW_FAILURES=')}\nprintf '%s' "$NEW_FAILURES"`, after, { BASELINE_FAILURES: first.stdout });
  return second;
}

test('a baseline file deleted or edited after it was read cannot hide a new upstream-suite failure', () => {
  const before = '  ❌ alpha broke\n📊 Results: 9 passed, 1 failed, 0 warnings';
  const after = '  ❌ alpha broke\n  ❌ beta broke\n📊 Results: 9 passed, 2 failed, 0 warnings';
  const deleted = baselineGate({ before, after, between: (file) => rmSync(file) });
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(deleted.stdout, '❌ beta broke');
  const edited = baselineGate({ before, after, between: (file) => writeFileSync(file, '❌ alpha broke\n❌ beta broke\n') });
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(edited.stdout, '❌ beta broke');
});

test('the sync prompt carries the baseline failures and conflicts verbatim, even when they hold $ replacement patterns', () => {
  const lines = readFileSync(SYNC, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('PROMPT="$('));
  const to = lines.findIndex((l, i) => i > from && l.includes('sync-prompt.md")"'));
  const snippet = lines.slice(from, to + 1).join('\n').replace('"$LIVE/custom/upstream-sync/sync-prompt.md"', `"${path.join(HERE, '..', 'sync-prompt.md')}"`);
  const baseline = "❌ cost check: expected $& got $$5 ($` and $')";
  // The baseline as sync.sh holds it, in memory since before Claude runs.
  const script = `STATE_DIR=/s TODAY=2026-10-04 BEHIND=3 CONFLICTS='a $& b'\n${snippet}\nprintf '%s' "$PROMPT"`;
  const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, BASELINE_FAILURES: baseline }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(baseline), r.stdout.slice(0, 3000));
  assert.ok(r.stdout.includes('a $& b'));
  assert.equal(r.stdout.includes('{{'), false, 'every placeholder is filled');
});

// ---- the sync Claude's own verdict (SW4-scripts-01) ----

/** Runs sync.sh's own lines from the claude call through CLAUDE_HOLD with a claude stub that prints `out` and exits `exit`. */
function claudeVerdict(out, exit = 0) {
  const dir = tempDir('sync-verdict-');
  const bin = path.join(dir, 'bin');
  stub(bin, 'claude', `printf '%s\\n' "${out.replace(/"/g, '\\"')}"\nexit ${exit}`);
  // sync.sh runs under `set -uo pipefail`, which makes the claude | tee pipeline report claude's exit.
  assert.match(readFileSync(SYNC, 'utf8'), /^set -uo pipefail$/m);
  const script = `set -uo pipefail\nsource "${LIB}"\nTOKEN=t MODEL=m STATE_DIR="${dir}" PROMPT=p LOG="${dir}/log"\n${block('CLAUDE_OUT="$(CLAUDE_CODE_OAUTH_TOKEN=', /^CLAUDE_HOLD=/)}\nprintf '%s' "$CLAUDE_HOLD"`;
  const r = spawnSync('bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { hold: r.stdout, log: readFileSync(path.join(dir, 'log'), 'utf8') };
}

test('a SYNC: ok verdict holds nothing, and Claude\'s reply still reaches the day log', () => {
  const r = claudeVerdict('Merged cleanly.\nSYNC: ok');
  assert.equal(r.hold, '');
  assert.match(r.log, /Merged cleanly\.\nSYNC: ok/);
});

test('a SYNC: needs-human verdict holds the PR with Claude\'s reason', () => {
  assert.equal(claudeVerdict('Resolved scan.mjs by taking upstream.\nSYNC: needs-human dropped the fork edit to scan.mjs; check the shortlist').hold, 'the sync Claude asked for a human: dropped the fork edit to scan.mjs; check the shortlist');
});

test('the last verdict line counts, so a quoted one earlier in the reply cannot clear a hold', () => {
  assert.equal(claudeVerdict('The prompt says to end with SYNC: ok\nSYNC: ok\nSYNC: needs-human tests flaky').hold, 'the sync Claude asked for a human: tests flaky');
});

test('no verdict, an unknown one, or a failed claude run holds the PR', () => {
  assert.equal(claudeVerdict('ran out of turns').hold, 'the sync Claude gave no SYNC verdict');
  assert.equal(claudeVerdict('SYNC: probably fine').hold, 'the sync Claude gave an unknown verdict: SYNC: probably fine');
  assert.equal(claudeVerdict('SYNC: ok', 1).hold, 'the sync Claude exited 1');
});

test('sync.sh reads the verdict before it pushes or decides', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const hold = sync.indexOf('CLAUDE_HOLD="$(sync_verdict "$CLAUDE_RC" "$CLAUDE_OUT")"');
  assert.ok(hold > sync.indexOf('claude -p') && hold < sync.indexOf('git push') && hold < sync.indexOf('BLOCKERS="$(merge_blockers)"'), `verdict at ${hold}`);
});

// ---- which custom/ paths the sync Claude may change without a human (SW4-scripts-02) ----

const isProtected = (p) => spawnSync('bash', ['-c', `source "${LIB}"\nprotected_paths "$P"`], { env: { PATH: '/usr/bin:/bin', P: p }, encoding: 'utf8' }).stdout.trim();

const SECTION_GATED = 'custom/control-center/server/core/contract.json';
const REPO_ROOT = path.resolve(HERE, '../../..');

/** The paths (one per element) protected_paths keeps, asked in one call. */
const protectedOf = (paths) => new Set(spawnSync('bash', ['-c', `source "${LIB}"\nprotected_paths "$P"`], { env: { PATH: '/usr/bin:/bin', P: paths.join('\n') }, encoding: 'utf8' }).stdout.split('\n').filter(Boolean));

/**
 * The Dev Chat deny globs under custom/ that the sync does not hold: a glob counts as covered when a sample path for
 * it and every tracked file it matches is a protected path or contract.json, which contract_gate_edits gates by its
 * `claude` and `playwrightMcp` sections.
 */
function driftGaps(globs) {
  assert.ok(readFileSync(LIB, 'utf8').includes(`local f=${SECTION_GATED}`), 'contract_gate_edits gates contract.json');
  const gaps = [];
  for (const glob of globs) {
    const sample = glob.replaceAll('**/', 'a/b/').replaceAll('**', 'a/b').replaceAll('*', 'x');
    const tracked = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '--', `:(glob)${glob}`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    const paths = [sample, ...tracked].filter((p) => p !== SECTION_GATED);
    const kept = protectedOf(paths);
    const open = paths.filter((p) => !kept.has(p));
    if (open.length) gaps.push(`${glob}: ${open.slice(0, 3).join(', ')}`);
  }
  return gaps;
}

function devChatGlobs() {
  const modes = readFileSync(path.join(HERE, '../../control-center/server/claude/modes.ts'), 'utf8');
  const list = modes.slice(modes.indexOf('export const DEVCHAT_DENIED_WRITES'), modes.indexOf('];', modes.indexOf('export const DEVCHAT_DENIED_WRITES')));
  return [...list.matchAll(/'(custom\/[^']+)'/g)].map((m) => m[1]);
}

test('protected_paths keeps every path Dev Chat may not write under custom/, and nothing else', () => {
  const globs = devChatGlobs();
  assert.ok(globs.length > 15, `read ${globs.length} globs from modes.ts`);
  assert.deepEqual(driftGaps(globs), []);
  for (const free of ['custom/a.mjs', 'custom/pipeline/shortlist.mjs', 'custom/control-center/server/routes/read.ts', 'custom/control-center/web/App.tsx', 'scan.mjs']) assert.equal(isProtected(free), '', free);
});

test('a Dev Chat list that denies server/core/** (the guard branch) is covered: every file there is protected but contract.json, which is section-gated', () => {
  assert.deepEqual(driftGaps([...devChatGlobs(), 'custom/control-center/server/core/**']), []);
  assert.equal(isProtected(SECTION_GATED), '', 'contract.json is not a whole-file hold: its clis, exports and writers follow upstream');
  for (const f of ['custom/control-center/server/core/adapter.ts', 'custom/control-center/server/core/child.ts', 'custom/control-center/server/core/new-module.ts']) assert.equal(isProtected(f), f);
});

test('sync.sh holds on protected edits found in the same snapshot comparison', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const changed = sync.indexOf('CHANGED_SINCE_MERGE="$(changed_since_snapshot "$MERGE_SNAPSHOT")"');
  const guarded = sync.indexOf('PROTECTED_EDITS="$({ protected_paths "$CHANGED_SINCE_MERGE"; contract_gate_edits "$MERGE_SNAPSHOT"; }');
  assert.ok(changed > -1 && guarded > changed && guarded < sync.indexOf('BLOCKERS="$(merge_blockers)"'), `protected at ${guarded}`);
});

test('every file the guard code loads from server/core is gated: adapter code as a protected path, contract.json by its gate sections (SW5-scripts-01)', () => {
  // The drift check above only compares this list with Dev Chat's, so a gap both share went unseen: neither named
  // server/core, though the guard reads its approved Claude versions and the Playwright probe from there.
  const dir = path.join(HERE, '../../control-center/server/claude');
  const refs = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => /\.(ts|mjs)$/.test(n))) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/['"]\.\.\/core\/([^'"]+)['"]/g)) refs.add(m[1].replace(/\.js$/, '.ts'));
    for (const m of src.matchAll(/'core', '([^']+)'/g)) refs.add(m[1]);
  }
  assert.ok(refs.size >= 2, [...refs].join(', '));
  const lib = readFileSync(LIB, 'utf8');
  for (const ref of refs) {
    const rel = `custom/control-center/server/core/${ref}`;
    if (ref.endsWith('.json')) assert.ok(lib.includes(`local f=${rel}`), `${rel} is checked by contract_gate_edits`);
    else assert.equal(isProtected(rel), rel, `${rel} is a protected path`);
  }
});
