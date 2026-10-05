// Every installer flag the landing README documents must be accepted by install.sh. By default the check runs
// against the working tree; give a ref to check the installer a published tag ships instead, which is what the
// README's clone and bootstrap commands pin:
//   CAREER_OPS_INSTALL_CHECK_REF=fork-install-v3 node --test custom/install/tests/readme-flags.spec.mjs
//   node custom/install/tests/readme-flags.spec.mjs --ref fork-install-v3
// A ref that cannot be read fails the check; it never passes by skipping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

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

/** install.sh at `ref` (written under a temp checkout layout), or the working tree's. */
function installerAt(ref) {
  if (!ref) return { file: path.join(ROOT, INSTALL_REL), label: 'the working tree' };
  const shown = spawnSync('git', ['-C', ROOT, 'show', `${ref}:${INSTALL_REL}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
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

function accepts(installer, args) {
  const home = tempDir('readme-flags-home-');
  // `--help` after the documented arguments: the parser reads them first, so an unknown flag or a missing value exits 2.
  const r = spawnSync('bash', [installer, ...args, '--help'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
  return { ok: r.status === 0 && /Usage:/.test(r.stdout), why: `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n')[0]}` };
}

const ref = checkRef();

test(`every installer flag the README documents is accepted by install.sh at ${ref ?? 'the working tree'}`, () => {
  const { file, label } = installerAt(ref);
  const invocations = [...commandLines(readme), ...documentedFlags(readme)];
  const flags = new Set(invocations.flat().filter((a) => a.startsWith('--')));
  // The README's own install commands and the flag table: if these are not found, the check would prove nothing.
  for (const needed of ['--resume', '--docs', '--projects', '--onboard', '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--dry-run', '--ref']) {
    assert.ok(flags.has(needed), `the README check found no ${needed}; found ${[...flags].join(' ')}`);
  }
  const rejected = invocations.map((args) => ({ args, ...accepts(file, args) })).filter((r) => !r.ok).map((r) => `${r.args.join(' ')} (${r.why})`);
  assert.deepEqual(rejected, [], `install.sh at ${label} rejects what the README documents`);
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
