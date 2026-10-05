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

test('sync.sh runs the control-center checks after the custom tests and before pushing', () => {
  const sync = readFileSync(SYNC, 'utf8');
  const custom = sync.indexOf('node --test custom/*/tests/*.spec.mjs');
  const cc = sync.indexOf('control_center_checks "$STATE_DIR/$TODAY.control-center-tests.txt"');
  const push = sync.indexOf('git push');
  assert.ok(custom > -1 && cc > custom && push > cc, `order was custom=${custom} cc=${cc} push=${push}`);
});

test('sync.sh auto-merges only when the control-center checks passed too', () => {
  const line = readFileSync(SYNC, 'utf8').split('\n').find((l) => l.startsWith('if [ $CUSTOM_OK = 1 ]'));
  assert.ok(line, 'auto-merge condition not found');
  const decide = (ccOk) => spawnSync('bash', ['-c', `CUSTOM_OK=1 NEW_FAILURES= AUTO_MERGE=1 KEPT_README=0 CC_OK=${ccOk}\n${line}\necho merge\nelse\necho hold\nfi`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(decide(1), 'merge');
  assert.equal(decide(0), 'hold');
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
