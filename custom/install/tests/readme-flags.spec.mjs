// Every installer flag the landing README documents must be accepted by install.sh. By default the check runs
// against the working tree and against the tag bootstrap.sh pins (CAREER_OPS_INSTALL_REF:-<tag>), which is what the
// README's clone and bootstrap commands install; give a ref to check only that one instead:
//   CAREER_OPS_INSTALL_CHECK_REF=fork-install-v3 node --test custom/install/tests/readme-flags.spec.mjs
//   node custom/install/tests/readme-flags.spec.mjs --ref fork-install-v3
// A ref given that way fails the check when it cannot be read. The default pinned tag is skipped with a fetch hint
// when this clone does not have it (a shallow clone, the sync worktree); the working tree is always checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';
import { gitTestEnv } from '../../test-support/git-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL_REL = 'custom/install/install.sh';
const readme = readFileSync(path.join(ROOT, '.github/README.md'), 'utf8');

/** The ref from `--ref <ref>`, `--ref=<ref>` or CAREER_OPS_INSTALL_CHECK_REF; null means the working tree. */
export function checkRef(argv = process.argv.slice(2), env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ref' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--ref=') && argv[i].length > '--ref='.length) return argv[i].slice('--ref='.length);
  }
  return env.CAREER_OPS_INSTALL_CHECK_REF || null;
}

/**
 * install.sh at `ref` (written under a temp checkout layout), or the working tree's. A ref missing from this clone
 * fails when it was given explicitly; the default pinned tag is then skipped with a fetch hint instead, so a shallow
 * clone or the sync worktree can still run the working-tree check.
 */
function installerAt(ref, { explicit }) {
  if (!ref) return { file: path.join(ROOT, INSTALL_REL), label: 'the working tree' };
  const present = spawnSync('git', ['-C', ROOT, 'rev-parse', '-q', '--verify', `${ref}^{commit}`], { encoding: 'utf8', env: gitTestEnv() }).status === 0;
  if (!present && !explicit) return { skip: `${ref} is not in this clone; fetch it to check it too: git fetch origin tag ${ref}` };
  const shown = spawnSync('git', ['-C', ROOT, 'show', `${ref}:${INSTALL_REL}`], { encoding: 'utf8', env: gitTestEnv(), maxBuffer: 16 * 1024 * 1024 });
  assert.equal(shown.status, 0, `could not read ${INSTALL_REL} at ${ref}: ${shown.stderr.trim()} (fetch the tag first: git fetch origin tag ${ref})`);
  const file = path.join(tempDir('readme-flags-'), INSTALL_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, shown.stdout, { mode: 0o755 });
  return { file, label: ref };
}

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)].map((m) => m[2]);
}

/** Arguments of every README command line that runs install.sh, or bootstrap.sh (which hands its arguments to install.sh). */
function commandLines(markdown) {
  const out = [];
  for (const block of fencedBlocks(markdown)) {
    for (const line of block.replace(/\\\n\s*/g, ' ').split('\n')) {
      const m = line.match(/(?:^|\s)\S*(?:install\/install\.sh|bootstrap\.sh)\s+(--\S.*)$/);
      if (m) out.push(m[1].replace(/\s+#.*$/, '').trim().split(/\s+/));
    }
  }
  return out;
}

/**
 * Each documented flag with sample values, from the flags table and from inline code such as `--projects projects.md`:
 * `<placeholder>` becomes a sample value, `a\|b\|c` each alternative, `[optional ...]` is dropped. A flag mentioned
 * bare takes the value its documented form shows.
 */
function documentedFlags(markdown) {
  const forms = new Map();
  for (const m of markdown.matchAll(/`(--[a-z][a-z0-9-]*)((?: [^`]*)?)`/g)) {
    const [, flag, rest] = m;
    const words = rest.replace(/\[[^\]]*\]/g, '').trim();
    const values = words ? (/\\?\|/.test(words) ? words.split(/\\?\|/).map((w) => w.trim()) : [words.split(/\s+/)[0].replace(/^<([^>]+)>$/, '$1')]) : [];
    const known = forms.get(flag) ?? [];
    forms.set(flag, [...new Set([...known, ...values])]);
  }
  const out = [];
  for (const [flag, values] of forms) {
    if (values.length === 0) out.push([flag]);
    for (const v of values) out.push([flag, v]);
  }
  return out;
}

// `--help` after the documented arguments: the parser reads them first, so an unknown flag or a missing value exits 2.
function runHelp(installer, args, limits = {}) {
  const home = tempDir('readme-flags-home-');
  return spawnCpuLimited('bash', [installer, ...args, '--help'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home }, ...limits });
}

function accepts(installer, args) {
  const r = runHelp(installer, args);
  return { ok: r.status === 0 && /Usage:/.test(r.stdout), why: `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n')[0]}` };
}

/** The tag bootstrap.sh installs by default: the one README users get. */
export function pinnedRef(bootstrap = readFileSync(path.join(ROOT, 'custom/install/bootstrap.sh'), 'utf8')) {
  const m = /CAREER_OPS_INSTALL_REF:-([^}"\s]+)\}/.exec(bootstrap);
  assert.ok(m, 'bootstrap.sh pins no CAREER_OPS_INSTALL_REF default');
  return m[1];
}

/** The installers to check: the one asked for, else the working tree and the tag bootstrap.sh pins. */
export function refsToCheck(argv = process.argv.slice(2), env = process.env) {
  const asked = checkRef(argv, env);
  return asked ? [asked] : [null, pinnedRef()];
}

const explicit = checkRef() !== null;
for (const ref of refsToCheck()) test(`every installer flag the README documents is accepted by install.sh at ${ref ?? 'the working tree'}`, (t) => {
  const at = installerAt(ref, { explicit });
  if (at.skip) return t.skip(at.skip);
  const { file, label } = at;
  const invocations = [...commandLines(readme), ...documentedFlags(readme)];
  const flags = new Set(invocations.flat().filter((a) => a.startsWith('--')));
  // The README's own install commands and the flag table: if these are not found, the check would prove nothing.
  for (const needed of ['--resume', '--docs', '--projects', '--onboard', '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--dry-run', '--ref']) {
    assert.ok(flags.has(needed), `the README check found no ${needed}; found ${[...flags].join(' ')}`);
  }
  const rejected = invocations.map((args) => ({ args, ...accepts(file, args) })).filter((r) => !r.ok).map((r) => `${r.args.join(' ')} (${r.why})`);
  assert.deepEqual(rejected, [], `install.sh at ${label} rejects what the README documents`);
});

function fakeInstaller(body) {
  const file = path.join(tempDir('readme-flags-fake-'), 'install.sh');
  writeFileSync(file, body);
  return file;
}

test('Given a loaded machine, an installer --help run is bounded by CPU time, not by a tight wall-clock timeout (R34-flake-walltime)', () => {
  const r = runHelp(fakeInstaller('ulimit -t\n'), ['--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '30\n');
});

test('Given an installer that spins in a loop, its --help run is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = runHelp(fakeInstaller('while :; do :; done\n'), [], { cpuSeconds: 1 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the spinning installer was not killed');
});

test('Given an installer that blocks on a child that never ends, its --help run is still killed instead of hanging the suite (R34-flake-walltime)', () => {
  const r = runHelp(fakeInstaller('exec sleep 60\n'), [], { hangMs: 1000 });
  assert.equal(r.status, null);
  assert.ok(r.signal, 'the blocked installer was not killed');
});

test('the check reads its ref from --ref, --ref= or CAREER_OPS_INSTALL_CHECK_REF, and defaults to the working tree', () => {
  assert.equal(checkRef([], {}), null);
  assert.equal(checkRef(['--ref', 'fork-install-v3'], {}), 'fork-install-v3');
  assert.equal(checkRef(['--ref=fork-install-v3'], {}), 'fork-install-v3');
  assert.equal(checkRef([], { CAREER_OPS_INSTALL_CHECK_REF: 'fork-install-v3' }), 'fork-install-v3');
  assert.equal(checkRef(['--ref', 'a'], { CAREER_OPS_INSTALL_CHECK_REF: 'b' }), 'a');
});

test('the sample invocations cover the documented value forms', () => {
  const sample = '`--resume <file.md>` `--docs <a.md> [b.md ...]` `--onboard interactive\\|headless\\|none` `--docs` `--projects projects.md` `--yes`';
  assert.deepEqual(documentedFlags(sample), [['--resume', 'file.md'], ['--docs', 'a.md'], ['--onboard', 'interactive'], ['--onboard', 'headless'], ['--onboard', 'none'], ['--projects', 'projects.md'], ['--yes']]);
  assert.deepEqual(commandLines('```bash\n~/career-ops/custom/install/install.sh --resume r.md --docs a.md   # note\nbash bootstrap.sh --resume r.md\nless bootstrap.sh\n```\n'), [['--resume', 'r.md', '--docs', 'a.md'], ['--resume', 'r.md']]);
});

test('given the pinned tag is missing locally (a shallow clone, the sync worktree), when the default check runs, then it skips with a fetch hint; a ref given explicitly still fails', () => {
  const missing = 'no-such-install-tag-sw4';
  assert.deepEqual(installerAt(missing, { explicit: false }), { skip: `${missing} is not in this clone; fetch it to check it too: git fetch origin tag ${missing}` });
  assert.throws(() => installerAt(missing, { explicit: true }), new RegExp(`could not read ${INSTALL_REL} at ${missing}: .*git fetch origin tag ${missing}`));
  assert.match(readFileSync(installerAt('HEAD', { explicit: false }).file, 'utf8'), /^#!/);
});

test('Given GIT_DIR exported at another repository, when the check reads a ref, then it still reads this checkout (R35-tests-custom-X-01)', (t) => {
  const other = tempDir('readme-flags-other-');
  assert.equal(spawnSync('git', ['init', '-q', other], { env: gitTestEnv() }).status, 0);
  const saved = process.env.GIT_DIR;
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  process.env.GIT_DIR = path.join(other, '.git');
  const head = spawnSync('git', ['-C', ROOT, 'show', `HEAD:${INSTALL_REL}`], { encoding: 'utf8', env: gitTestEnv(), maxBuffer: 16 * 1024 * 1024 }).stdout;
  assert.equal(readFileSync(installerAt('HEAD', { explicit: true }).file, 'utf8'), head);
  assert.equal(installerAt('HEAD', { explicit: false }).skip, undefined, 'the default ref was looked up in the other repository');
});

test('by default the check covers the working tree and the tag bootstrap.sh pins, which README users install (SW4-tests-07)', () => {
  assert.deepEqual(refsToCheck([], {}), [null, 'fork-install-v3']);
  assert.deepEqual(refsToCheck(['--ref', 'x'], {}), ['x']);
  assert.equal(pinnedRef('local ref="${CAREER_OPS_INSTALL_REF:-fork-install-v9}"'), 'fork-install-v9');
});
