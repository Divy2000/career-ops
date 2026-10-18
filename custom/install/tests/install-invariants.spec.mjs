// The invariants in custom/install/install.invariants.md, part 1: the ones a single function, the script's own text or
// a single headless run can show (credentials, version judgment, URL redaction, one owner per piece of state).
// Randomized cases draw from a seeded PRNG and name the seed in every failure message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { INSTALL_SH, INSTALL_DIR } from './harness.mjs';
import { fresh, md } from './install-fixtures.mjs';
import { isCredential } from '../../control-center/server/system/child-env.ts';
import { parseClaudeVersion } from '../../control-center/server/claude/confinement.mjs';
import { versionAtLeast } from '../lib.mjs';

const SCRIPT = fs.readFileSync(INSTALL_SH, 'utf8');
const MIN = /^CLAUDE_HEADLESS_MIN="([^"]+)"$/m.exec(SCRIPT)[1];

/** mulberry32: a small seeded PRNG, so a failing randomized case can be replayed from its seed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const SEEDS = (process.env.INSTALL_INVARIANT_SEEDS || '20261018,7,424242').split(',').map(Number);

/** The text of the named top-level shell functions of install.sh (one-line `f() { ...; }` or a block ending in `}`). */
function shellFunctions(...names) {
  const lines = SCRIPT.split('\n');
  return names.map((name) => {
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
    assert.notEqual(start, -1, `install.sh defines no function ${name}`);
    if (/\}\s*(#.*)?$/.test(lines[start]) && lines[start].trim() !== `${name}() {`) return lines[start];
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  }).join('\n');
}
/** Runs `body` in bash with the named install.sh functions defined; returns stdout. */
function bashWith(names, body, args = []) {
  const r = spawnSync('/bin/bash', ['-c', `${shellFunctions(...names)}\n${body}`, 'bash', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// ---------------------------------------------------------------- invariant 10: shown URLs carry no userinfo

// ---------------------------------------------------------------- invariant 6: one credential rule for Claude children

const SEGMENTS = ['TOKEN', 'TOKENS', 'KEY', 'KEYS', 'SECRET', 'PASSWORD', 'PASSPHRASE', 'CREDENTIAL', 'CREDENTIALS', 'CERT', 'CERTS', 'HEADER', 'HEADERS', 'MAX', 'OUTPUT', 'USE', 'BEDROCK', 'API', 'AUTH', 'BASE', 'URL', 'TTL', 'MS', 'HELPER', 'CLIENT'];
const SET_BY_INSTALLER = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']);

function randomCredentialEnv(seed) {
  const rand = prng(seed);
  const env = {};
  while (Object.keys(env).length < 30) {
    const parts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(rand, SEGMENTS));
    const name = `${pick(rand, ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_CODE_', 'CLAUDE_CODE_'])}${parts.join('_')}`;
    if (!SET_BY_INSTALLER.has(name)) env[name] = `v${Math.floor(rand() * 1e6)}`;
  }
  return env;
}

function headlessRun(env, { versions } = {}) {
  const { w, D } = fresh({ keychain: true });
  if (versions) fs.writeFileSync(path.join(w.fakeSrc, 'custom/control-center/server/core/contract.json'), JSON.stringify({ claude: { approvedVersions: versions } }));
  const resume = md(w, 'resume.md', '# Me\n');
  const r = w.run(['--dir', D, '--non-interactive', '--no-start', '--no-launchd', '--no-h1b-index', '--onboard', 'headless', '--resume', resume], { env });
  return { w, r };
}

test('the headless Claude inherits exactly the ANTHROPIC_*/CLAUDE_CODE_* variables child-env.ts isCredential keeps (seeded, R32-scripts-b-L2-01)', () => {
  for (const seed of SEEDS.slice(0, 2)) {
    const env = randomCredentialEnv(seed);
    const { w, r } = headlessRun(env);
    assert.ok(w.claudeArgv(), `seed ${seed}: ${r.out}`);
    const inherited = w.log().find((l) => l.startsWith('claude-inherited')).split(' ').slice(1).filter((n) => !SET_BY_INSTALLER.has(n)).sort();
    assert.deepEqual(inherited, Object.keys(env).filter((n) => !isCredential(n)).sort(), `seed ${seed}`);
  }
});

// ---------------------------------------------------------------- invariant 7: one parser and one rule for versions

// ---------------------------------------------------------------- invariants 1, 2, 5: one owner per piece of state

const code = SCRIPT.split('\n').filter((l) => !/^\s*#/.test(l));
/** The name of the top-level function each code line sits in ('' at top level). */
function ownerOf() {
  let owner = '';
  return code.map((l) => {
    const m = /^([a-z_][a-z0-9_]*)\(\) \{/.exec(l);
    if (m) owner = /\}\s*$/.test(l) && !l.endsWith('() {') ? '' : m[1];
    const here = m ? m[1] : owner;
    if (l === '}') owner = '';
    return here;
  });
}

test('DATA has one writer, set_data_root, which refuses an unconfinable root in the same call (R30-scripts-b-L2-01)', () => {
  const owners = ownerOf();
  const writers = code.map((l, i) => (/(^|[\s;])DATA=/.test(l) ? owners[i] || '<top level>' : null)).filter(Boolean);
  assert.deepEqual([...new Set(writers)], ['set_data_root'], code.filter((l) => /(^|[\s;])DATA=/.test(l)).join('\n'));
  assert.match(shellFunctions('set_data_root'), /refuse_unconfinable_root "\$DATA"/);
});

test('every temp path is made by make_temp, and one cleanup trap owns every exit, QUIT included (R31-scripts-b-L1-01, R32-scripts-b-L1-02)', () => {
  const owners = ownerOf();
  const makers = code.map((l, i) => (/\bmktemp\b/.test(l) ? owners[i] || '<top level>' : null)).filter(Boolean);
  assert.deepEqual([...new Set(makers)], ['make_temp']);
  assert.match(SCRIPT, /^trap cleanup EXIT$/m);
  for (const [sig, code] of [['HUP', 129], ['INT', 130], ['QUIT', 131], ['TERM', 143]]) assert.match(SCRIPT, new RegExp(`^trap 'exit ${code}' ${sig}$`, 'm'), sig);
  // exec keeps the PID a lock holder polls for, so the EXIT trap never runs: cleanup runs first.
  const execAt = code.findIndex((l) => /^\s*exec "\$DIR\/custom\/control-center\/bin\/cc"/.test(l));
  assert.notEqual(execAt, -1);
  assert.match(code.slice(execAt - 3, execAt).join('\n'), /cleanup/);
});

test('the invariants doc this file encodes sits next to install.sh', () => {
  assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'install.invariants.md')));
});
