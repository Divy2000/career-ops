// Shared test world for install.sh and bootstrap.sh: a temp HOME, stubs first on PATH (git, npm, claude,
// security, launchctl, ...) that record argv into one log, a fake checkout that the git stub "clones",
// a node shim that fakes the version, and an optional fake terminal file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { isNestedCheckout } from '../../../lib/mjs-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_DIR = path.join(HERE, '..');
export const INSTALL_SH = path.join(INSTALL_DIR, 'install.sh');
export const BOOTSTRAP_SH = path.join(INSTALL_DIR, 'bootstrap.sh');
export const REPO_ROOT = path.resolve(INSTALL_DIR, '..', '..');
export const FORK_URL = 'https://github.com/Divy2000/career-ops.git';
const STUBS = path.join(HERE, 'stubs');

const DEFAULT_TOOLS = ['git', 'node', 'npm', 'security', 'uname', 'launchctl', 'plutil', 'claude', 'open'];

// The tools install.sh probes for. A world has one only when its stub is in `tools`: the system copies are left off
// the world PATH, so a "missing npm" spec means the same on Linux, where npm, git or gh live in /usr/bin, as on macOS.
const PROBED = new Set(['git', 'node', 'npm', 'npx', 'claude', 'brew', 'gh', 'pdftotext', 'go']);
// The system tools that change real state (Keychain, launchd, plists). A world reaches them only through its stubs,
// so a spec that forgets one fails on a missing command instead of touching the real system.
const REAL_STATE = new Set(['security', 'launchctl', 'plutil']);
/** The system folders a world links commands from, in PATH order. */
export const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
let systemBin = null;

/** Links every command in `dirs` (earlier folders win) into `into`, except the probed and real-state tools. */
export function linkSystemCommands(dirs, into) {
  // Names already linked, not fs.existsSync: that follows the link, so a dangling one seen again (a command in both
  // /usr/bin and /bin on merged-/usr systems) would be linked twice and throw EEXIST.
  const linked = new Set();
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const link = path.join(into, name);
      if (PROBED.has(name) || REAL_STATE.has(name) || linked.has(name)) continue;
      linked.add(name);
      fs.symlinkSync(path.join(dir, name), link);
    }
  }
}

/** One folder per test process of links to every system command except the probed ones, in PATH order. */
function systemBinDir() {
  if (systemBin) return systemBin;
  systemBin = path.join(fs.realpathSync(tempDir('ci-sysbin-')), 'bin');
  fs.mkdirSync(systemBin);
  linkSystemCommands(SYSTEM_DIRS, systemBin);
  return systemBin;
}

const put = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, mode ? { mode } : undefined);
  return file;
};

function buildFakeCheckout(dir) {
  put(path.join(dir, 'package.json'), '{"name":"fake-career-ops"}\n');
  fs.copyFileSync(path.join(REPO_ROOT, 'path-resolver.mjs'), path.join(dir, 'path-resolver.mjs'));
  put(path.join(dir, 'doctor.mjs'), `import fs from 'node:fs';
import path from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, 'doctor ' + args.join(' ') + '\\n');
const root = getCareerOpsRoot();
// Like the real doctor: copies every personalization template that is absent, and never overwrites one.
if (args.includes('--init-templates')) {
  for (const rel of ['modes/_profile.md', 'modes/_custom.md', 'modes/_brief.md', 'voice-dna.md']) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'TEMPLATE ' + rel + '\\n'); }
  }
}
if (args.includes('--json')) {
  const missing = ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'portals.yml'].filter((p) => !fs.existsSync(path.join(root, p)));
  const unpersonalized = (process.env.FAKE_DOCTOR_UNPERSONALIZED || '').split(',').filter(Boolean).map((p) => ({ path: p, reason: 'x' }));
  console.log(JSON.stringify({ onboardingNeeded: missing.length > 0, missing, unpersonalized }));
} else {
  console.log('doctor stub ok');
  process.exit(Number(process.env.FAKE_DOCTOR_EXIT || 0));
}
`);
  put(path.join(dir, 'plugins.mjs'), `import fs from 'node:fs';
fs.appendFileSync(process.env.STUB_LOG, 'plugins ' + process.argv.slice(2).join(' ') + '\\n');
`);
  put(path.join(dir, 'plugins/h1b-sponsor/install-h1b-index.mjs'), `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
fs.appendFileSync(process.env.STUB_LOG, 'h1b-install ' + process.argv.slice(2).join(' ') + '\\n');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
fs.mkdirSync(path.join(root, 'data', 'h1b'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'h1b', 'index.ndjson.gz'), 'x');
`);
  put(path.join(dir, 'custom/launchd/install.sh'), '#!/bin/bash\necho "launchd-install $*" >> "$STUB_LOG"\nexit "${FAKE_LAUNCHD_EXIT:-0}"\n', 0o755);
  put(path.join(dir, 'custom/control-center/bin/cc'), '#!/bin/sh\necho "cc $*" >> "$STUB_LOG"\n', 0o755);
  put(path.join(dir, 'custom/control-center/package.json'), '{"name":"fake-cc"}\n');
}

export function makeWorld({ tools = DEFAULT_TOOLS, keychain = false } = {}) {
  const T = fs.realpathSync(tempDir('ci-world-'));
  const bin = path.join(T, 'bin');
  const home = path.join(T, 'home');
  const cwd = path.join(T, 'cwd');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  for (const t of tools) fs.symlinkSync(path.join(STUBS, t), path.join(bin, t));
  const stubLog = path.join(T, 'stub.log');
  const keychainFlag = path.join(T, 'keychain-present');
  fs.writeFileSync(stubLog, '');
  if (keychain) fs.writeFileSync(keychainFlag, '');
  const fakeSrc = path.join(T, 'fake-src');
  buildFakeCheckout(fakeSrc);
  const ttyFile = path.join(T, 'tty');

  const baseEnv = {
    PATH: `${bin}:${systemBinDir()}`,
    HOME: home,
    USER: 'tester',
    STUB_LOG: stubLog,
    STUB_KEYCHAIN: keychainFlag,
    FAKE_SRC: fakeSrc,
    REAL_NODE: process.execPath,
    CAREER_OPS_INSTALL_TTY: path.join(T, 'no-such-tty'),
    CAREER_OPS_CLAUDE_FALLBACK_DIRS: path.join(home, '.local', 'bin'),
    LANG: 'en_US.UTF-8',
    // The test run's TMPDIR, so whatever the installer or a nested tool makes goes where the caller chose.
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };

  const world = {
    T, home, cwd, bin, fakeSrc, stubLog, keychainFlag, ttyFile,
    env: () => ({ ...baseEnv }),
    claudeArgv: () => (fs.existsSync(`${stubLog}.claude.argv`) ? fs.readFileSync(`${stubLog}.claude.argv`, 'utf8').split('\0').slice(0, -1) : null),
    log: () => fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean),
    calls: (prefix) => world.log().filter((l) => l === prefix || l.startsWith(`${prefix} `)),
    setKeychain: (on) => (on ? fs.writeFileSync(keychainFlag, '') : fs.rmSync(keychainFlag, { force: true })),
    ttyOutput: () => fs.readFileSync(ttyFile, 'utf8'),
    /** A checkout that already exists: the fake source plus a .git dir whose origin is `origin`. */
    makeCheckout(dir, { origin = FORK_URL, files = {} } = {}) {
      fs.cpSync(fakeSrc, dir, { recursive: true });
      put(path.join(dir, '.git', 'origin-url'), `${origin}\n`);
      for (const [rel, data] of Object.entries(files)) put(path.join(dir, rel), data);
      return dir;
    },
    write: (rel, data) => put(path.join(T, rel), data),
    /** Every file under T except the stub log, tty file and the fake source, as {relpath: base64}. */
    snapshot() {
      const out = {};
      const skip = new Set([stubLog, ttyFile, fakeSrc]);
      // The walk never crosses into a checkout on its own (the shared isNestedCheckout rule); the fake
      // checkouts this world makes are part of what a test compares, so each is then walked as a root of its own.
      const roots = [T];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (skip.has(f)) continue;
          if (e.isDirectory()) {
            out[`${path.relative(T, f)}/`] = '';
            if (isNestedCheckout(f)) {
              roots.push(f);
              continue;
            }
            walk(f);
          } else out[path.relative(T, f)] = fs.readFileSync(f).toString('base64');
        }
      };
      while (roots.length) walk(roots.shift());
      return out;
    },
    /** Runs the script under a real pseudo-terminal, sending each answer once its prompt has appeared. */
    runInPty(args, { steps, env = {}, script = INSTALL_SH, timeout = 120_000 } = {}) {
      const childEnv = { ...baseEnv, ...env };
      delete childEnv.CAREER_OPS_INSTALL_TTY;
      const r = spawnSync('python3', [path.join(HERE, 'pty_run.py'), JSON.stringify(steps), '--', 'bash', script, ...args], {
        env: childEnv, cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    run(args, { env = {}, tty = null, script = INSTALL_SH, timeout = 90_000 } = {}) {
      if (tty !== null) {
        fs.writeFileSync(ttyFile, tty);
        baseEnv.CAREER_OPS_INSTALL_TTY = ttyFile;
      } else baseEnv.CAREER_OPS_INSTALL_TTY = path.join(T, 'no-such-tty');
      const r = spawnSync('bash', [script, ...args], {
        env: { ...baseEnv, ...env },
        cwd,
        encoding: 'utf8',
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}`, signal: r.signal };
    },
  };
  return world;
}

export function installLogs(dataRoot) {
  const dir = path.join(dataRoot, 'data', 'install');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^install-.*\.log$/.test(n)).map((n) => path.join(dir, n));
}

/** Why the pty tests cannot run on `searchPath` (no python3, or one that cannot import pty), or false when they can. */
/** What pythonPtyMissing's probe prints once `import pty` ran, so a shim that only exits 0 does not pass. */
export const PTY_PROBE_OK = 'pty-probe-ok';

export function pythonPtyMissing(searchPath) {
  const r = spawnSync('python3', ['-c', `import pty; print(${JSON.stringify(PTY_PROBE_OK)})`], { env: { ...process.env, PATH: searchPath }, encoding: 'utf8', timeout: 20_000 });
  if (r.error) return `python3 is not available (${r.error.code ?? r.error.message})`;
  if (r.status !== 0) return `python3 cannot run: ${`${r.stderr}`.trim().split('\n')[0] || `exit ${r.status}`}`;
  if (`${r.stdout}`.trim() !== PTY_PROBE_OK) return 'python3 exited 0 without running the pty probe';
  return false;
}
