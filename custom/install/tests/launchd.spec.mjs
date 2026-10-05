import { test, after } from 'node:test';
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
const scratch = [];
after(() => scratch.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mkTmp = (prefix) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(d);
  return d;
};

function run(args, { env = {}, marker = null, existing = [], homeName = 'home', claude = null, localClaude = null, relativeClaude = false } = {}) {
  const T = mkTmp('ci-launchd-');
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  for (const t of ['launchctl', 'plutil']) fs.symlinkSync(path.join(STUBS, t), path.join(bin, t));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const home = path.join(T, homeName);
  fs.mkdirSync(home);
  if (localClaude !== null) {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), `#!/bin/sh\necho '${localClaude} (Claude Code)'\n`, { mode: 0o755 });
  }
  // The script derives ROOT from its own location, so run a copy inside a scratch "checkout".
  const root = path.join(T, 'root');
  fs.mkdirSync(path.join(root, 'custom', 'launchd'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, 'custom', 'launchd', 'install.sh'));
  fs.copyFileSync(path.join(HERE, '..', '..', '..', 'path-resolver.mjs'), path.join(root, 'path-resolver.mjs'));
  // The version check reads the approved list next to the confinement module, as in a real checkout.
  fs.mkdirSync(path.join(root, 'custom', 'control-center', 'server', 'claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'custom', 'control-center', 'server', 'core'), { recursive: true });
  fs.copyFileSync(path.join(HERE, '..', '..', 'control-center', 'server', 'claude', 'confinement.mjs'), path.join(root, 'custom', 'control-center', 'server', 'claude', 'confinement.mjs'));
  fs.writeFileSync(path.join(root, 'custom', 'control-center', 'server', 'core', 'contract.json'), JSON.stringify({ claude: { approvedVersions: ['2.1.289'] } }));
  // A claude on the test PATH answering `--version` with `claude` (never the real one: /opt/homebrew/bin is not on it).
  if (claude !== null) fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho '${claude} (Claude Code)'\n`, { mode: 0o755 });
  // A claude reached only through relative PATH entries (node_modules/.bin, and an empty entry, which is the current
  // folder), both first on PATH: the script runs from T, where both exist.
  if (relativeClaude) {
    fs.mkdirSync(path.join(T, 'node_modules', '.bin'), { recursive: true });
    for (const f of [path.join(T, 'node_modules', '.bin', 'claude'), path.join(T, 'claude')]) fs.writeFileSync(f, "#!/bin/sh\necho '2.1.289 (Claude Code)'\n", { mode: 0o755 });
  }
  if (marker !== null) fs.writeFileSync(path.join(root, '.career-ops-data'), `${marker.replace('$T', T)}\n`);
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const label of existing) fs.writeFileSync(path.join(agentsDir, `${label}.plist`), 'PRE-EXISTING');
  const stubLog = path.join(T, 'stub.log');
  fs.writeFileSync(stubLog, '');
  const r = spawnSync('bash', [path.join(root, 'custom', 'launchd', 'install.sh'), ...args], {
    cwd: T,
    env: { PATH: `${relativeClaude ? 'node_modules/.bin::' : ''}${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog, ...env },
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agents = path.join(home, 'Library', 'LaunchAgents');
  return { ...r, T, root, home, plists: fs.existsSync(agents) ? fs.readdirSync(agents).sort() : [], log: fs.readFileSync(stubLog, 'utf8') };
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

const DAILY = 'com.career-ops.immigration-watch';
const SYNC = 'com.career-ops.upstream-sync';
const plistText = (r, label) => fs.readFileSync(path.join(r.home, 'Library', 'LaunchAgents', `${label}.plist`), 'utf8');

// The test's bin/node links to this node, so the plist pins its real path.
const NODE = fs.realpathSync(process.execPath);
const NODE_KEY = `<key>CC_NODE_BIN</key><string>${NODE}</string>`;
const ENV_KEY = (dir) => `<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${dir}</string>${NODE_KEY}</dict>`;
const ONLY_NODE = `<key>EnvironmentVariables</key><dict>${NODE_KEY}</dict>`;

test('CAREER_OPS_ROOT from the environment is written into the plist and used for the launchd logs', () => {
  const data = mkTmp('ci-launchd-data-');
  const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: data } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ENV_KEY(data)), xml);
  assert.ok(xml.includes(`<key>StandardOutPath</key><string>${data}/data/immigration/logs/launchd.out.log</string>`), xml);
  assert.ok(xml.includes(`<key>StandardErrorPath</key><string>${data}/data/immigration/logs/launchd.err.log</string>`), xml);
  assert.ok(fs.statSync(path.join(data, 'data', 'immigration', 'logs')).isDirectory());
  assert.ok(xml.includes(`<string>${r.root}/custom/immigration/run-daily.sh</string>`), 'the script still lives in the checkout');
});

test('CAREER_OPS_DATA_DIR from the environment is written too, and CAREER_OPS_ROOT wins when both are set', () => {
  const a = mkTmp('ci-launchd-data-');
  const b = mkTmp('ci-launchd-data-');
  assert.ok(plistText(run(['--jobs', 'daily'], { env: { CAREER_OPS_DATA_DIR: a } }), DAILY).includes(ENV_KEY(a)));
  assert.ok(plistText(run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: a, CAREER_OPS_DATA_DIR: b } }), DAILY).includes(ENV_KEY(a)));
});

test('a blank environment variable is not an override: no CAREER_OPS_ROOT entry (only the node pin) and the checkout is the data root', () => {
  const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: '   ', CAREER_OPS_DATA_DIR: '\t' } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ONLY_NODE), xml);
  assert.doesNotMatch(xml, /CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`${r.root}/data/immigration/logs/launchd.out.log`), xml);
});

test('a marker is resolved at run time: the plist carries no CAREER_OPS_ROOT, but the log paths use the marker root', () => {
  const r = run(['--jobs', 'daily'], { marker: '$T/markerdata' });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ONLY_NODE), xml);
  assert.doesNotMatch(xml, /CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`<string>${r.T}/markerdata/data/immigration/logs/launchd.out.log</string>`), xml);
  assert.ok(fs.statSync(path.join(r.T, 'markerdata', 'data', 'immigration', 'logs')).isDirectory());
});

test('with neither, no CAREER_OPS_ROOT is written and the logs live in the checkout', () => {
  const r = run(['--jobs', 'all']);
  for (const label of [DAILY, SYNC]) {
    assert.ok(plistText(r, label).includes(ONLY_NODE), plistText(r, label));
    assert.doesNotMatch(plistText(r, label), /CAREER_OPS_ROOT/);
  }
  assert.ok(plistText(r, SYNC).includes(`${r.root}/data/upstream-sync/launchd.out.log`));
});

test('--jobs daily leaves an already-installed weekly sync plist untouched and says how to remove it', () => {
  const r = run(['--jobs', 'daily'], { existing: [SYNC] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(plistText(r, SYNC), 'PRE-EXISTING');
  assert.ok(!r.log.includes(`${SYNC}`), 'launchctl was not asked about the sync job');
  assert.match(r.stdout, /weekly sync job .*still installed/i);
  const plist = path.join(r.home, 'Library', 'LaunchAgents', `${SYNC}.plist`);
  assert.ok(r.stdout.includes(`launchctl bootout gui/${process.getuid()}/${SYNC}`), r.stdout);
  assert.ok(r.stdout.includes(`rm '${plist}'`), r.stdout);
});

test('the printed rm command is properly shell-quoted even when HOME contains a single quote', () => {
  const r = run(['--jobs', 'daily'], { existing: [SYNC], homeName: "ho'me" });
  assert.equal(r.status, 0, r.stderr);
  const plist = path.join(r.home, 'Library', 'LaunchAgents', `${SYNC}.plist`);
  const quoted = `'${plist.replaceAll("'", "'\\''")}'`;
  assert.ok(r.stdout.includes(`rm ${quoted}`), r.stdout);
  const cmd = r.stdout.split('\n').find((l) => l.includes('To remove it:')).split('To remove it: ')[1];
  const run2 = spawnSync('bash', ['-c', `rm() { printf '%s' "$1"; }; ${cmd.replace(/^launchctl [^;]*; /, '')}`], { encoding: 'utf8' });
  assert.equal(run2.stdout, plist, 'bash reads the quoted word back as the exact path');
});

test('--jobs daily prints nothing about the weekly sync when it was never installed', () => {
  const r = run(['--jobs', 'daily']);
  assert.doesNotMatch(r.stdout + r.stderr, /upstream-sync|weekly sync/i);
});

test('a job the Control Center disabled is enabled again before it is bootstrapped, so a reinstall succeeds', () => {
  const T = mkTmp('ci-launchd-disabled-');
  const disabled = path.join(T, 'disabled');
  fs.writeFileSync(disabled, 'com.career-ops.immigration-watch\ncom.career-ops.upstream-sync\n');
  const r = run(['--jobs', 'all'], { env: { STUB_LAUNCHD_DISABLED: disabled } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed com\.career-ops\.immigration-watch/);
  assert.match(r.stdout, /installed com\.career-ops\.upstream-sync/);
  assert.equal(fs.readFileSync(disabled, 'utf8').trim(), '');
  const calls = r.log.trim().split('\n');
  for (const label of ['com.career-ops.immigration-watch', 'com.career-ops.upstream-sync']) {
    const enable = calls.findIndex((c) => /^launchctl enable gui\/\d+\//.test(c) && c.endsWith(`/${label}`));
    const bootstrap = calls.findIndex((c) => c.startsWith('launchctl bootstrap ') && c.endsWith(`/${label}.plist`));
    assert.ok(enable > -1 && bootstrap > enable, `${label}: enable at ${enable}, bootstrap at ${bootstrap}\n${r.log}`);
  }
});

const CLAUDE_KEY = (bin) => `<key>CC_CLAUDE_BIN</key><string>${bin}</string>`;

test('the daily plist pins the approved claude found on PATH (CC_CLAUDE_BIN), and the weekly plist does not', () => {
  const r = run(['--jobs', 'all'], { claude: '2.1.289' });
  assert.equal(r.status, 0, r.stderr);
  const bin = path.join(r.T, 'bin', 'claude');
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict>${CLAUDE_KEY(bin)}${NODE_KEY}</dict>`), plistText(r, DAILY));
  assert.doesNotMatch(plistText(r, SYNC), /CC_CLAUDE_BIN/);
  assert.match(r.stdout, new RegExp(`daily job uses claude ${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Claude Code 2\\.1\\.289\\)`));
});

test('CC_CLAUDE_BIN from the environment wins and is written next to CAREER_OPS_ROOT', () => {
  const data = mkTmp('ci-launchd-data-');
  const other = path.join(mkTmp('ci-launchd-claude-'), 'claude');
  fs.writeFileSync(other, "#!/bin/sh\necho '2.1.289 (Claude Code)'\n", { mode: 0o755 });
  const r = run(['--jobs', 'daily'], { claude: '2.1.289', env: { CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${data}</string>${CLAUDE_KEY(other)}${NODE_KEY}</dict>`), plistText(r, DAILY));
});

test('a relative CC_CLAUDE_BIN is a usage error that installs nothing', () => {
  const r = run(['--jobs', 'daily'], { env: { CC_CLAUDE_BIN: 'claude' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CC_CLAUDE_BIN must be an absolute path/);
  assert.deepEqual(r.plists, []);
});

test('an unapproved claude is still pinned, with a warning that the Claude steps will be skipped until it is approved', () => {
  const r = run(['--jobs', 'daily'], { claude: '2.1.290' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(CLAUDE_KEY(path.join(r.T, 'bin', 'claude'))));
  assert.match(r.stderr, /warning: Claude Code 2\.1\.290 is not approved .*the daily job skips its policy pass and rank/);
});

test('no claude anywhere: no CC_CLAUDE_BIN, and a warning that says how to pin one', () => {
  const r = run(['--jobs', 'daily']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(plistText(r, DAILY), /CC_CLAUDE_BIN/);
  assert.match(r.stderr, /warning: no claude found .*CC_CLAUDE_BIN=/);
});

test('with no claude on PATH, the native installer location ~/.local/bin/claude is pinned', () => {
  const r = run(['--jobs', 'daily'], { localClaude: '2.1.289' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(CLAUDE_KEY(path.join(r.home, '.local', 'bin', 'claude'))), plistText(r, DAILY));
});

test('relative PATH entries are skipped, not the end of the search: the first claude on PATH by absolute path is pinned', () => {
  const r = run(['--jobs', 'daily'], { relativeClaude: true, claude: '2.1.289', localClaude: '2.1.289' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(CLAUDE_KEY(path.join(r.T, 'bin', 'claude'))), plistText(r, DAILY));
  assert.doesNotMatch(r.stderr, /no claude found/);
});

test('a claude only behind relative PATH entries falls back to ~/.local/bin/claude, else to no pin with the warning', () => {
  const local = run(['--jobs', 'daily'], { relativeClaude: true, localClaude: '2.1.289' });
  assert.equal(local.status, 0, local.stderr);
  assert.ok(plistText(local, DAILY).includes(CLAUDE_KEY(path.join(local.home, '.local', 'bin', 'claude'))), plistText(local, DAILY));
  const none = run(['--jobs', 'daily'], { relativeClaude: true });
  assert.equal(none.status, 0, none.stderr);
  assert.doesNotMatch(plistText(none, DAILY), /CC_CLAUDE_BIN/);
  assert.match(none.stderr, /warning: no claude found .*CC_CLAUDE_BIN=/);
});

// ---- the node the jobs run on ----

test('both plists pin the node the installer ran, by its real path (CC_NODE_BIN): launchd never sees a node from nvm, fnm or volta', () => {
  const r = run(['--jobs', 'all']);
  assert.equal(r.status, 0, r.stderr);
  for (const label of [DAILY, SYNC]) assert.ok(plistText(r, label).includes(NODE_KEY), plistText(r, label));
  assert.ok(r.stdout.includes(`jobs use node ${NODE} (${process.version})`), r.stdout);
});

const PINNED_NODE = path.resolve(HERE, '..', '..', 'launchd', 'pinned-node.sh');

/** Sources pinned-node.sh the way the jobs do, after a launchd-like PATH, and reports which node the job would run. */
function pinnedNode(env) {
  const r = spawnSync('bash', ['-c', `export PATH=/usr/bin:/bin\nsource "${PINNED_NODE}"\nprintf '%s\\n%s' "$PATH" "$(command -v node || true)"`], { env, encoding: 'utf8' });
  const [pathLine, node] = r.stdout.split('\n');
  return { status: r.status, stderr: r.stderr, path: pathLine, node };
}

test('a job that sources pinned-node.sh runs the pinned node first, ahead of everything on its PATH', () => {
  const dir = mkTmp('ci-launchd-node-');
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  const r = pinnedNode({ CC_NODE_BIN: path.join(dir, 'node') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.path, `${dir}:/usr/bin:/bin`);
  assert.equal(r.node, path.join(dir, 'node'));
  assert.equal(r.stderr, '');
});

test('with no pin, pinned-node.sh leaves PATH alone', () => {
  const r = pinnedNode({});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.path, '/usr/bin:/bin');
  assert.equal(r.stderr, '');
});

test('a pinned node that is gone (its version was uninstalled) leaves PATH alone and warns how to pin again', () => {
  const r = pinnedNode({ CC_NODE_BIN: path.join(mkTmp('ci-launchd-node-'), 'node') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.path, '/usr/bin:/bin');
  assert.match(r.stderr, /warning: CC_NODE_BIN .*node is not an executable.*custom\/launchd\/install\.sh/);
});
