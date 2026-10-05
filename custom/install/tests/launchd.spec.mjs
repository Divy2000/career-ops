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

function run(args, { env = {}, marker = null, existing = [], homeName = 'home', claude = null, localClaude = null } = {}) {
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
  if (marker !== null) fs.writeFileSync(path.join(root, '.career-ops-data'), `${marker.replace('$T', T)}\n`);
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const label of existing) fs.writeFileSync(path.join(agentsDir, `${label}.plist`), 'PRE-EXISTING');
  const stubLog = path.join(T, 'stub.log');
  fs.writeFileSync(stubLog, '');
  const r = spawnSync('bash', [path.join(root, 'custom', 'launchd', 'install.sh'), ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: stubLog, ...env },
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

const ENV_KEY = (dir) => `<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${dir}</string></dict>`;

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

test('a blank environment variable is not an override: no EnvironmentVariables entry and the checkout is the data root', () => {
  const r = run(['--jobs', 'daily'], { env: { CAREER_OPS_ROOT: '   ', CAREER_OPS_DATA_DIR: '\t' } });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.doesNotMatch(xml, /EnvironmentVariables|CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`${r.root}/data/immigration/logs/launchd.out.log`), xml);
});

test('a marker is resolved at run time: the plist carries no CAREER_OPS_ROOT, but the log paths use the marker root', () => {
  const r = run(['--jobs', 'daily'], { marker: '$T/markerdata' });
  assert.equal(r.status, 0, r.stderr);
  const xml = plistText(r, DAILY);
  assert.doesNotMatch(xml, /EnvironmentVariables|CAREER_OPS_ROOT/);
  assert.ok(xml.includes(`<string>${r.T}/markerdata/data/immigration/logs/launchd.out.log</string>`), xml);
  assert.ok(fs.statSync(path.join(r.T, 'markerdata', 'data', 'immigration', 'logs')).isDirectory());
});

test('with neither, no CAREER_OPS_ROOT is written and the logs live in the checkout', () => {
  const r = run(['--jobs', 'all']);
  for (const label of [DAILY, SYNC]) assert.doesNotMatch(plistText(r, label), /EnvironmentVariables|CAREER_OPS_ROOT/);
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
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict>${CLAUDE_KEY(bin)}</dict>`), plistText(r, DAILY));
  assert.doesNotMatch(plistText(r, SYNC), /CC_CLAUDE_BIN/);
  assert.match(r.stdout, new RegExp(`daily job uses claude ${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(Claude Code 2\\.1\\.289\\)`));
});

test('CC_CLAUDE_BIN from the environment wins and is written next to CAREER_OPS_ROOT', () => {
  const data = mkTmp('ci-launchd-data-');
  const other = path.join(mkTmp('ci-launchd-claude-'), 'claude');
  fs.writeFileSync(other, "#!/bin/sh\necho '2.1.289 (Claude Code)'\n", { mode: 0o755 });
  const r = run(['--jobs', 'daily'], { claude: '2.1.289', env: { CAREER_OPS_ROOT: data, CC_CLAUDE_BIN: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(plistText(r, DAILY).includes(`<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>${data}</string>${CLAUDE_KEY(other)}</dict>`), plistText(r, DAILY));
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
