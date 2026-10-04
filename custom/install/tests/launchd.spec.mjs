import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'launchd', 'install.sh');
const STUBS = path.join(HERE, 'stubs');

// Runs the real launchd/install.sh with a temp HOME and stub launchctl/plutil, so no real launchd job is touched.
function run(args) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-launchd-')));
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  for (const t of ['launchctl', 'plutil']) fs.symlinkSync(path.join(STUBS, t), path.join(bin, t));
  const home = path.join(T, 'home');
  fs.mkdirSync(home);
  // The script derives ROOT from its own location, so run a copy inside a scratch "checkout".
  const root = path.join(T, 'root');
  fs.mkdirSync(path.join(root, 'custom', 'launchd'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'custom', 'launchd', 'install.sh'));
  const stubLog = path.join(T, 'stub.log');
  fs.writeFileSync(stubLog, '');
  const r = spawnSync('bash', [path.join(root, 'custom', 'launchd', 'install.sh'), ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog },
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agents = path.join(home, 'Library', 'LaunchAgents');
  return { ...r, plists: fs.existsSync(agents) ? fs.readdirSync(agents).sort() : [], log: fs.readFileSync(stubLog, 'utf8') };
}

test('--jobs daily installs only the daily plist and never bootstraps the sync job', () => {
  const r = run(['--jobs', 'daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.plists, ['com.career-ops.immigration-watch.plist']);
  assert.doesNotMatch(r.log, /upstream-sync/);
});

test('--jobs all installs both plists, and so does no flag at all (the maintainer default)', () => {
  for (const args of [['--jobs', 'all'], []]) {
    const r = run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.plists, ['com.career-ops.immigration-watch.plist', 'com.career-ops.upstream-sync.plist']);
  }
});

test('an unknown --jobs value is a usage error (exit 2) that installs nothing', () => {
  const r = run(['--jobs', 'weekly']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /daily|all/);
  assert.deepEqual(r.plists, []);
});

test('--jobs without a value is a usage error', () => {
  assert.equal(run(['--jobs']).status, 2);
});

test('an unknown flag is a usage error', () => {
  assert.equal(run(['--bogus']).status, 2);
});
