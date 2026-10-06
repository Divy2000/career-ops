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

function run(args, { env = {}, marker = null, existing = [], existingXml = {}, homeName = 'home', claude = null, localClaude = null, relativeClaude = false, realPlutil = false, nodeAt = 'bin', nodeShim = false } = {}) {
  const T = mkTmp('ci-launchd-');
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(STUBS, 'launchctl'), path.join(bin, 'launchctl'));
  // The real plutil only lints (read-only); the stub records the call and passes, or fails with STUB_PLUTIL_FAIL.
  fs.symlinkSync(realPlutil ? '/usr/bin/plutil' : path.join(STUBS, 'plutil'), path.join(bin, 'plutil'));
  // The node on the test PATH: a link to this node in `nodeAt` (bin unless a test puts it where a version manager
  // would), or with `nodeShim` a script that runs it, like an asdf or mise shim.
  fs.mkdirSync(path.join(T, nodeAt), { recursive: true });
  if (nodeShim) fs.writeFileSync(path.join(T, nodeAt, 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  else fs.symlinkSync(process.execPath, path.join(T, nodeAt, 'node'));
  const home = path.join(T, homeName);
  fs.mkdirSync(home, { recursive: true });
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
  for (const [label, xml] of Object.entries(existingXml)) fs.writeFileSync(path.join(agentsDir, `${label}.plist`), xml.replaceAll('$T', T));
  const stubLog = path.join(T, 'stub.log');
  fs.writeFileSync(stubLog, '');
  const r = spawnSync('bash', [path.join(root, 'custom', 'launchd', 'install.sh'), ...args], {
    cwd: T,
    env: { PATH: `${relativeClaude ? 'node_modules/.bin::' : ''}${nodeAt === 'bin' ? '' : `${path.join(T, nodeAt)}:`}${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace('$T', T)])) },
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

// The node pin: by default the test PATH's bin/node, the link as found (see the node tests below).
const NODE_KEY = (r, node = path.join(r.T, 'bin', 'node')) => `<key>CC_NODE_BIN</key><string>${node}</string>`;
const ENV_KEY = (r, dir) => `<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${dir}</string>${NODE_KEY(r)}</dict>`;
const ONLY_NODE = (r) => `<key>EnvironmentVariables</key><dict>${NODE_KEY(r)}</dict>`;

test('CAREER_OPS_ROOT from the environment is written into the plist and used for the launchd logs', () => {
  const data = mkTmp('ci-launchd-data-');
  const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: data } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ENV_KEY(r, data)), xml);
  assert.ok(xml.includes(`<key>StandardOutPath</key><string>${data}/data/immigration/logs/launchd.out.log</string>`), xml);
  assert.ok(xml.includes(`<key>StandardErrorPath</key><string>${data}/data/immigration/logs/launchd.err.log</string>`), xml);
  assert.ok(fs.statSync(path.join(data, 'data', 'immigration', 'logs')).isDirectory());
  assert.ok(xml.includes(`<string>${r.root}/custom/immigration/run-daily.sh</string>`), 'the script still lives in the checkout');
});

test('CAREER_OPS_DATA_DIR from the environment is written too, and CAREER_OPS_ROOT wins when both are set', () => {
  const a = mkTmp('ci-launchd-data-');
  const b = mkTmp('ci-launchd-data-');
  const onlyDir = run(['--jobs', 'daily'], { env: { CAREER_OPS_DATA_DIR: a } });
  assert.ok(plistText(onlyDir, DAILY).includes(ENV_KEY(onlyDir, a)));
  const both = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: a, CAREER_OPS_DATA_DIR: b } });
  assert.ok(plistText(both, DAILY).includes(ENV_KEY(both, a)));
});

test('a blank environment variable is not an override: no CAREER_OPS_ROOT entry (only the node pin) and the checkout is the data root', () => {
  const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: '   ', CAREER_OPS_DATA_DIR: '\t' } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ONLY_NODE(r)), xml);
  assert.doesNotMatch(xml, /CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`${r.root}/data/immigration/logs/launchd.out.log`), xml);
});

test('a marker is resolved at run time: the plist carries no CAREER_OPS_ROOT, but the log paths use the marker root', () => {
  const r = run(['--jobs', 'daily'], { marker: '$T/markerdata' });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(ONLY_NODE(r)), xml);
  assert.doesNotMatch(xml, /CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`<string>${r.T}/markerdata/data/immigration/logs/launchd.out.log</string>`), xml);
  assert.ok(fs.statSync(path.join(r.T, 'markerdata', 'data', 'immigration', 'logs')).isDirectory());
});

test('with neither, no CAREER_OPS_ROOT is written and the logs live in the checkout', () => {
  const r = run(['--jobs', 'all']);
  for (const label of [DAILY, SYNC]) {
    assert.ok(plistText(r, label).includes(ONLY_NODE(r)), plistText(r, label));
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
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict>${CLAUDE_KEY(bin)}${NODE_KEY(r)}</dict>`), plistText(r, DAILY));
  assert.doesNotMatch(plistText(r, SYNC), /CC_CLAUDE_BIN/);
  assert.match(r.stdout, new RegExp(`daily job uses claude ${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Claude Code 2\\.1\\.289\\)`));
});

test('CC_CLAUDE_BIN from the environment wins and is written next to CAREER_OPS_ROOT', () => {
  const data = mkTmp('ci-launchd-data-');
  const other = path.join(mkTmp('ci-launchd-claude-'), 'claude');
  fs.writeFileSync(other, "#!/bin/sh\necho '2.1.289 (Claude Code)'\n", { mode: 0o755 });
  const r = run(['--jobs', 'daily'], { claude: '2.1.289', env: { CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${data}</string>${CLAUDE_KEY(other)}${NODE_KEY(r)}</dict>`), plistText(r, DAILY));
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

test('both plists pin the node on PATH as found (CC_NODE_BIN), not the versioned folder its link points into', () => {
  const r = run(['--jobs', 'all']);
  assert.equal(r.status, 0, r.stderr);
  const link = path.join(r.T, 'bin', 'node');
  assert.notEqual(fs.realpathSync(link), link, 'the test node is a link');
  for (const label of [DAILY, SYNC]) assert.ok(plistText(r, label).includes(NODE_KEY(r)), plistText(r, label));
  assert.ok(r.stdout.includes(`jobs use node ${link} (${process.version})`), r.stdout);
});

const REAL_NODE = fs.realpathSync(process.execPath);
// Where each install puts the node a shell finds first, and what the plist must pin: the PATH entry as written when it
// resolves to the node that runs, else that node's real binary (an fnm per-shell link goes away with its shell; a
// shim runs node as another process, so it never resolves to it).
const NODE_LAYOUTS = [
  { name: 'Homebrew (/opt/homebrew/bin/node, a link into the Cellar that brew upgrade replaces)', nodeAt: 'opt/homebrew/bin', pin: 'as found' },
  { name: 'nvm (~/.nvm/versions/node/<version>/bin/node)', nodeAt: 'home/.nvm/versions/node/v22.6.0/bin', pin: 'as found' },
  { name: 'volta (~/.volta/bin/node, a shim)', nodeAt: 'home/.volta/bin', shim: true, pin: 'real' },
  { name: 'fnm (a per-shell link under fnm_multishells)', nodeAt: 'home/.local/state/fnm_multishells/4242_1759700000000/bin', pin: 'real' },
];

for (const { name, nodeAt, shim = false, pin } of NODE_LAYOUTS) {
  test(`node from ${name} is pinned ${pin === 'real' ? 'by its real binary' : 'as found on PATH'}`, () => {
    const r = run(['--jobs', 'daily'], { nodeAt, nodeShim: shim });
    assert.equal(r.status, 0, r.stderr);
    const expected = pin === 'real' ? REAL_NODE : path.join(r.T, nodeAt, 'node');
    assert.ok(plistText(r, DAILY).includes(NODE_KEY(r, expected)), plistText(r, DAILY));
  });
}

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

// ---- the plist on disk ----

const HAS_PLUTIL = fs.existsSync('/usr/bin/plutil');

test('&, < and > in a path are escaped: the plist passes the real plutil -lint and reads back the exact path', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const data = path.join(mkTmp('ci-launchd-data-'), 'R&D <jobs> data');
  fs.mkdirSync(data);
  const r = run(['--jobs', 'all'], { env: { CAREER_OPS_ROOT: data }, realPlutil: true });
  assert.equal(r.status, 0, r.stderr);
  for (const label of [DAILY, SYNC]) {
    const file = path.join(r.home, 'Library', 'LaunchAgents', `${label}.plist`);
    assert.ok(plistText(r, label).includes('R&amp;D &lt;jobs&gt; data'), plistText(r, label));
    const read = (key) => spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).stdout.trim();
    assert.equal(read('EnvironmentVariables.CAREER_OPS_ROOT'), data);
    assert.equal(read('StandardOutPath'), `${data}/${label === DAILY ? 'data/immigration/logs' : 'data/upstream-sync'}/launchd.out.log`);
  }
});

test('a plist that fails plutil -lint never replaces the installed one or reaches launchctl, and leaves no file behind', () => {
  const r = run(['--jobs', 'daily'], { existing: [DAILY], env: { STUB_PLUTIL_FAIL: '1' } });
  assert.notEqual(r.status, 0);
  assert.equal(plistText(r, DAILY), 'PRE-EXISTING');
  assert.deepEqual(r.plists, [`${DAILY}.plist`]);
  assert.match(r.stderr, /plist for com\.career-ops\.immigration-watch failed plutil -lint/);
  assert.doesNotMatch(r.log, /^launchctl /m);
});

test('a plist that passes lint replaces the installed one', () => {
  const r = run(['--jobs', 'daily'], { existing: [DAILY] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(plistText(r, DAILY), /^<\?xml /);
  assert.deepEqual(r.plists, [`${DAILY}.plist`]);
  assert.equal(fs.statSync(path.join(r.home, 'Library', 'LaunchAgents', `${DAILY}.plist`)).mode & 0o777, 0o644, 'readable like any LaunchAgents plist, not mktemp\'s 0600');
});

test('a data root under Documents or Desktop gets a Full Disk Access note: launchd\'s bash writes the logs there (SW3-scripts-03)', () => {
  for (const place of ['Documents', 'Desktop']) {
    const probe = run(['--jobs', 'daily']);
    const data = path.join(probe.home, place, 'career-data');
    fs.mkdirSync(data, { recursive: true });
    const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: data, HOME: probe.home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /note: the data root .* is under Desktop or Documents; give \/bin\/bash Full Disk Access/, place);
  }
  const elsewhere = run(['--jobs', 'daily']);
  assert.doesNotMatch(elsewhere.stdout, /Full Disk Access/);
});

// ---- a reinstall keeps what the user set in the Control Center (SW3-scripts-02 review) ----

/** An installed plist as an older install (another checkout and data root) and the Control Center left it. */
const oldPlist = (label, { hour, minute, weekday = null, root = '/old/checkout', data = '/old/data' }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${root}/custom/immigration/run-daily.sh</string></array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${data}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer>${weekday === null ? '' : `<key>Weekday</key><integer>${weekday}</integer>`}</dict>
  <key>StandardOutPath</key><string>${data}/data/immigration/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${data}/data/immigration/logs/launchd.err.log</string>
</dict>
</plist>
`;

test('a reinstall over a job from another checkout points it at this one and keeps the time the user set', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const r = run(['--jobs', 'daily'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 6, minute: 30 }) } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.ok(xml.includes(`<string>${r.root}/custom/immigration/run-daily.sh</string>`), xml);
  assert.ok(xml.includes(`<key>WorkingDirectory</key><string>${r.root}</string>`), xml);
  assert.doesNotMatch(xml, /\/old\//);
  assert.ok(xml.includes('<dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>'), xml);
  assert.match(r.stdout, /installed com\.career-ops\.immigration-watch \(keeping its 06:30 schedule\)/);
});

test('a reinstall keeps a job the user turned off turned off: rewritten, never enabled or bootstrapped', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const T = mkTmp('ci-launchd-disabled-');
  const disabled = path.join(T, 'disabled');
  fs.writeFileSync(disabled, `${DAILY}\n`);
  const r = run(['--jobs', 'daily'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 7, minute: 5 }) }, env: { STUB_LAUNCHD_DISABLED: disabled } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(`<string>${r.root}/custom/immigration/run-daily.sh</string>`));
  assert.equal(fs.readFileSync(disabled, 'utf8').trim(), DAILY, 'still disabled');
  assert.doesNotMatch(r.log, new RegExp(`^launchctl (enable|bootstrap) .*${DAILY.replaceAll('.', '\\.')}`, 'm'));
  assert.match(r.stdout, /installed com\.career-ops\.immigration-watch \(keeping its 07:05 schedule; left off, as set in the Control Center\)/);
});

test('--reset puts the job back at its default time and turns it on', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const T = mkTmp('ci-launchd-disabled-');
  const disabled = path.join(T, 'disabled');
  fs.writeFileSync(disabled, `${DAILY}\n`);
  const r = run(['--jobs', 'daily', '--reset'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 6, minute: 30 }) }, env: { STUB_LAUNCHD_DISABLED: disabled } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes('<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>'));
  assert.equal(fs.readFileSync(disabled, 'utf8').trim(), '');
  assert.match(r.log, new RegExp(`^launchctl bootstrap .*${DAILY.replaceAll('.', '\\.')}\\.plist$`, 'm'));
});

test('--jobs all adds the weekly sync next to an installed daily job, and the daily job keeps its time', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const r = run(['--jobs', 'all'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 6, minute: 30 }) } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.plists, [`${DAILY}.plist`, `${SYNC}.plist`]);
  assert.ok(plistText(r, DAILY).includes('<key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer>'));
  assert.ok(plistText(r, SYNC).includes('<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>0</integer></dict>'));
});

test('an installed plist whose schedule cannot be read gets the default time, not a broken one', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const r = run(['--jobs', 'daily'], { existing: [DAILY] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes('<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>'));
});

test('a turned-off job is read as off from a long print-disabled list that names it first, and from the older "=> true" form', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const T = mkTmp('ci-launchd-print-');
  const others = Array.from({ length: 200_000 }, (_, i) => `\t\t"com.example.agent-${i}" => enabled`).join('\n');
  const forms = {
    'long list, label first': `disabled services = {\n\t\t"${DAILY}" => disabled\n${others}\n\t}\n`,
    'older => true': `disabled services = {\n\t\t"com.example.other" => false\n\t\t"${DAILY}" => true\n\t}\n`,
  };
  for (const [name, text] of Object.entries(forms)) {
    const file = path.join(T, `${name.replace(/\W+/g, '-')}.txt`);
    fs.writeFileSync(file, text);
    const r = run(['--jobs', 'daily'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 7, minute: 5 }) }, env: { STUB_PRINT_DISABLED_OUTPUT: file } });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.doesNotMatch(r.log, new RegExp(`^launchctl (enable|bootstrap) .*${DAILY.replaceAll('.', '\\.')}`, 'm'), name);
    assert.match(r.stdout, /left off, as set in the Control Center/, name);
  }
});

test('a job listed as enabled, or not listed, is turned on as usual after a reinstall', { skip: !HAS_PLUTIL && 'needs /usr/bin/plutil (macOS)' }, () => {
  const T = mkTmp('ci-launchd-print-');
  const file = path.join(T, 'enabled.txt');
  fs.writeFileSync(file, `disabled services = {\n\t\t"${DAILY}" => enabled\n\t\t"${DAILY}.other" => disabled\n\t}\n`);
  const r = run(['--jobs', 'daily'], { existingXml: { [DAILY]: oldPlist(DAILY, { hour: 7, minute: 5 }) }, env: { STUB_PRINT_DISABLED_OUTPUT: file } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.log, new RegExp(`^launchctl bootstrap .*${DAILY.replaceAll('.', '\\.')}\\.plist$`, 'm'));
});
