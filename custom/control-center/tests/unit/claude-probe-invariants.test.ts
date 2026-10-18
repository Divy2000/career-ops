// The invariants in scripts/claude-probe-reads.invariants.md, as table-driven and seeded randomized cases.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { resolveClaudeBin as preflightResolve } from '../../supervisor/preflight.js';
import { resolveClaudeBin, keychainOutcome } from '../../scripts/probe-cli.mjs';
import { recordReadProbe } from '../../scripts/probe-reads-record.mjs';

const FAKE_TOKEN = 'fake-probe-token';

/** mulberry32: a small seeded PRNG, so a failing randomized case can be replayed from its printed seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const SEED = Number(process.env.PROBE_INVARIANT_SEED ?? 0x5eed34);

/**
 * A preload under which a timer or spawnSync timeout of one of `delays` ms fires as soon as `readyDir` holds an entry
 * (the process under test has recorded its pid), so a timeout path runs in a test without racing that process's start.
 */
function timeoutsOnReady(root: string, delays: number[], readyDir: string) {
  const preload = path.join(root, `on-ready-${delays.join('-')}.mjs`);
  fs.writeFileSync(
    preload,
    `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const delays = ${JSON.stringify(delays)};
const ready = () => fs.readdirSync(${JSON.stringify(readyDir)}).length > 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (!delays.includes(ms)) return realSetTimeout(fn, ms, ...rest);
  const poll = setInterval(() => {
    if (!ready()) return;
    clearInterval(poll);
    fn(...rest);
  }, 20);
  return poll;
};
const realSpawnSync = cp.spawnSync;
cp.spawnSync = (cmd, argv, opts) => {
  if (!opts || !delays.includes(opts.timeout)) return realSpawnSync(cmd, argv, opts);
  // spawnSync blocks, so the old synchronous version check can only be bounded: long enough for the pid to appear.
  return realSpawnSync(cmd, argv, { ...opts, timeout: 3_000 });
};
syncBuiltinESMExports();
`,
  );
  return preload;
}

describe('invariant 1: the probes resolve CC_CLAUDE_BIN exactly as supervisor/preflight.ts does', () => {
  /** A fixture with some PATH dirs, a home with ~/.local/bin, and executables or plain files at chosen spots. */
  function fixture() {
    const root = tempDir('cc-probe-resolve-');
    const dirs = ['p1', 'p2', 'p3'].map((d) => path.join(root, d));
    const home = path.join(root, 'home');
    for (const d of [...dirs, path.join(home, '.local', 'bin')]) fs.mkdirSync(d, { recursive: true });
    return { root, dirs, home };
  }
  const place = (file: string, kind: 'exec' | 'plain' | 'dir') => {
    if (kind === 'dir') fs.mkdirSync(file, { recursive: true });
    else fs.writeFileSync(file, '#!/bin/sh\n', { mode: kind === 'exec' ? 0o755 : 0o644 });
  };

  it('given the edge spellings of CC_CLAUDE_BIN, when both resolve it, then they pick the same path', () => {
    const fx = fixture();
    place(path.join(fx.dirs[1] as string, 'claude'), 'exec');
    place(path.join(fx.dirs[0] as string, 'claude'), 'plain');
    place(path.join(fx.home, '.local', 'bin', 'work-claude'), 'exec');
    const table: Array<[string, Record<string, string | undefined>]> = [
      ['/abs/claude', {}],
      ['tools/claude', { INIT_CWD: fx.root }],
      ['./tools//claude', { INIT_CWD: `${fx.root}/` }],
      ['../up/claude', { INIT_CWD: fx.root }],
      ['tools/claude', { INIT_CWD: 'relative/start' }],
      ['tools/claude', {}],
      ['claude', {}],
      ['work-claude', {}],
      ['missing-claude', {}],
    ];
    for (const [bin, extra] of table) {
      const env = { PATH: fx.dirs.join(path.delimiter), ...extra };
      expect(resolveClaudeBin(bin, { env, home: fx.home }), `${bin} ${JSON.stringify(extra)}`).toBe(preflightResolve(bin, { env, home: fx.home }));
    }
  });

  it(`given random PATH layouts (seed ${SEED}), when both resolve a name, then they pick the same path`, () => {
    const rand = prng(SEED);
    for (let i = 0; i < 40; i++) {
      const fx = fixture();
      const names = ['claude', 'work-claude', 'c'];
      for (const d of [...fx.dirs, path.join(fx.home, '.local', 'bin')]) {
        for (const n of names) {
          const kind = pick(rand, ['none', 'none', 'exec', 'plain', 'dir'] as const);
          if (kind !== 'none') place(path.join(d, n), kind);
        }
      }
      const pathDirs = fx.dirs.filter(() => rand() < 0.7).map((d) => (rand() < 0.2 ? path.relative(process.cwd(), d) : d));
      const env = { PATH: [...pathDirs, ...(rand() < 0.3 ? [''] : [])].join(path.delimiter), INIT_CWD: rand() < 0.5 ? fx.root : undefined };
      const bin = pick(rand, [...names, 'sub/claude', './claude', '/x/claude']);
      expect(resolveClaudeBin(bin, { env, home: fx.home }), `seed ${SEED} iteration ${i}: ${bin} PATH=${env.PATH}`).toBe(preflightResolve(bin, { env, home: fx.home }));
    }
  });
});

describe('invariant 2: a Keychain read error is never reported as an absent item', () => {
  type Read = { status: number | null; signal?: string | null; stdout?: string; stderr?: string; error?: { code?: string; message: string } };
  const table: Array<[string, Read, 'token' | 'absent' | 'unreadable', RegExp]> = [
    ['a stored token', { status: 0, stdout: 'tok\n' }, 'token', /^$/],
    ['a blank value', { status: 0, stdout: '  \n' }, 'absent', /not found/],
    ['errSecItemNotFound', { status: 44, stdout: '', stderr: 'could not be found' }, 'absent', /not found/],
    ['a locked keychain that cannot prompt', { status: 36, stdout: '', stderr: 'User interaction is not allowed.' }, 'unreadable', /security failed \(exit 36: User interaction is not allowed\.\)/],
    ['a timeout', { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT', message: 'spawnSync security ETIMEDOUT' } }, 'unreadable', /timed out after 8s/],
    ['no security binary', { status: null, error: { code: 'ENOENT', message: 'spawnSync security ENOENT' } }, 'unreadable', /not found on PATH/],
    ['another spawn error', { status: null, error: { code: 'EACCES', message: 'spawnSync security EACCES' } }, 'unreadable', /could not be run \(spawnSync security EACCES\)/],
    ['a signal', { status: null, signal: 'SIGTERM', stdout: '' }, 'unreadable', /signal SIGTERM/],
    ['exit 44 with a spawn error', { status: 44, error: { code: 'EPIPE', message: 'EPIPE' } }, 'unreadable', /could not be run/],
  ];
  for (const [what, read, kind, message] of table) {
    it(`given ${what}, when the probe classifies the read, then it is ${kind}`, () => {
      const out = keychainOutcome(read, 8000);
      expect(out.kind).toBe(kind);
      if (kind === 'token') expect(out.token).toBe('tok');
      else expect(out.problem).toMatch(message);
      if (kind === 'unreadable') expect(out.problem).toMatch(/security unlock-keychain|not found on PATH/);
    });
  }

  it(`given random security results (seed ${SEED}), then only exit 44 or a blank exit-0 value without a spawn error is absent, and no problem names the token`, () => {
    const rand = prng(SEED);
    for (let i = 0; i < 500; i++) {
      const token = `tok-${Math.floor(rand() * 1e9)}`;
      const error = rand() < 0.3 ? { code: pick(rand, ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPIPE', undefined]), message: `spawnSync security ${token.slice(0, 3)}` } : undefined;
      const status = pick(rand, [0, 0, 44, 36, 1, 51, null]);
      const read = { status, signal: status === null ? pick(rand, ['SIGKILL', 'SIGTERM', null]) : null, stdout: pick(rand, [`${token}\n`, '', ' \n']), stderr: pick(rand, ['', 'boom']), error };
      const out = keychainOutcome(read, 8000);
      const note = `seed ${SEED} iteration ${i}: ${JSON.stringify(read)}`;
      const absent = !error && (status === 44 || (status === 0 && !read.stdout.trim()));
      expect(out.kind === 'absent', note).toBe(absent);
      expect(out.kind === 'token', note).toBe(!error && status === 0 && read.stdout.trim() !== '');
      if (out.kind !== 'token') expect(out.problem, note).not.toContain(token);
    }
  });
});

describe('invariant 9: recordReadProbe records only a complete, uninterrupted run', () => {
  const SHAPE = { flags: ['--restricted'] };
  const contractWith = (approved: string[], readProbe?: unknown) => ({ other: { keep: true }, claude: { approvedVersions: approved, ...(readProbe ? { readProbe } : {}) } });
  const run = (over: Record<string, unknown> = {}) => ({ version: '9.9.9', probedAt: '2026-10-18T00:00:00.000Z', model: 'haiku', shape: SHAPE, cases: { C0: 'fail', C1: 'pass', C2: 'info' }, info: { a: 1 }, runs: 2, only: null, stopped: false, incomplete: [], ...over });

  const refusals: Array<[string, Record<string, unknown>, unknown, RegExp]> = [
    ['a signal stopped the run', { stopped: true }, undefined, /stopped by a signal/],
    ['a call did not run to its end', { incomplete: ['c1-today (spawn failed: ENOENT)'] }, undefined, /c1-today/],
    ['--only with no record', { only: new Set(['C1']) }, undefined, /needs an existing record for 9\.9\.9/],
    ['--only with a record of another version', { only: new Set(['C1']) }, { version: '1.0.0', model: 'haiku', shape: SHAPE, cases: {} }, /needs an existing record for 9\.9\.9/],
    // R34-supervisor-L2-01: the old cases ran against another invocation shape or model, so they say nothing about this one.
    ['--only with a record of the same version but another shape', { only: new Set(['C1']) }, { version: '9.9.9', model: 'haiku', shape: { flags: ['--tools'] }, cases: { C2: 'pass' } }, /needs an existing record for 9\.9\.9 .*shape/],
    ['--only with a record of the same version but another hook timeout', { only: new Set(['C1']) }, { version: '9.9.9', model: 'haiku', shape: { ...SHAPE, hookTimeout: 60 }, cases: { C2: 'pass' } }, /needs an existing record for 9\.9\.9 .*shape/],
    ['--only with a record of the same version but another model', { only: new Set(['C1']) }, { version: '9.9.9', model: 'sonnet', shape: SHAPE, cases: { C2: 'pass' } }, /needs an existing record for 9\.9\.9 .*model/],
    ['--only with a record of the same version that names no shape', { only: new Set(['C1']) }, { version: '9.9.9', model: 'haiku', cases: { C2: 'pass' } }, /needs an existing record for 9\.9\.9 .*shape/],
  ];
  for (const [what, over, prev, reason] of refusals) {
    it(`given ${what}, when the run asks to record, then it is refused and the contract is untouched`, () => {
      const contract = contractWith([], prev);
      const before = JSON.stringify(contract);
      expect(() => recordReadProbe(contract, run(over))).toThrow(reason);
      expect(JSON.stringify(contract)).toBe(before);
    });
  }

  it('given --only and a record of the same version, model and shape with its keys in another order, when it records, then the cases merge', () => {
    const shape = { hookTimeout: 30, flags: ['--restricted'], preToolUseMatcher: 'Read' };
    const prev = { version: '9.9.9', model: 'haiku', shape: { preToolUseMatcher: 'Read', flags: ['--restricted'], hookTimeout: 30 }, cases: { C2: 'pass' }, info: {}, history: [] };
    const { contract } = recordReadProbe(contractWith([], prev), run({ shape, only: new Set(['C1']), cases: { C0: 'fail', C1: 'pass' } }));
    expect(contract.claude.readProbe.cases).toMatchObject({ C1: 'pass', C2: 'pass' });
  });

  it('given every case passes, when it records, then the version is approved and C0 passes', () => {
    const { contract, cases } = recordReadProbe(contractWith(['1.0.0']), run());
    expect(contract.claude.approvedVersions).toEqual(['1.0.0', '9.9.9']);
    expect(cases.C0).toBe('pass');
    expect(contract.claude.readProbe).toMatchObject({ version: '9.9.9', cases: { C0: 'pass', C1: 'pass', C2: 'info' }, history: [{ cases: ['C1', 'C2'], runs: 2 }] });
    expect(contract.other).toEqual({ keep: true });
  });

  it('given a failing case, when it records, then the record is written but the version is not approved', () => {
    const { contract } = recordReadProbe(contractWith([]), run({ cases: { C0: 'fail', C1: 'fail' } }));
    expect(contract.claude.approvedVersions).toEqual([]);
    expect(contract.claude.readProbe.cases).toEqual({ C0: 'fail', C1: 'fail' });
  });

  it(`given random runs and records (seed ${SEED}), then a write happens only for a complete run and approval follows the merged gate`, () => {
    const rand = prng(SEED);
    const ids = ['C1', 'C2', 'C8', 'C13', 'C19'];
    const results = ['pass', 'fail', 'info'];
    for (let i = 0; i < 400; i++) {
      const note = `seed ${SEED} iteration ${i}`;
      const prevVersion = pick(rand, [null, '9.9.9', '1.0.0']);
      const prevModel = pick(rand, ['haiku', 'haiku', 'sonnet']);
      const prevShape = pick(rand, [SHAPE, SHAPE, { flags: ['--restricted', '--tools'] }, undefined]);
      const prev = prevVersion ? { version: prevVersion, model: prevModel, ...(prevShape ? { shape: prevShape } : {}), cases: Object.fromEntries(ids.filter(() => rand() < 0.6).map((id) => [id, pick(rand, results)])), info: { old: true }, history: [{ probedAt: 'x', cases: [], runs: 1 }] } : undefined;
      const approved = rand() < 0.3 ? ['9.9.9'] : ['1.0.0'];
      const selected = ids.filter(() => rand() < 0.5);
      const only = rand() < 0.5 && selected.length ? new Set(selected) : null;
      const ran = only ? selected : ids;
      const cases = { C0: 'fail', ...Object.fromEntries(ran.map((id) => [id, pick(rand, results)])) };
      const r = run({ cases, only, stopped: rand() < 0.15, incomplete: rand() < 0.15 ? ['c9-settings (killed by SIGKILL)'] : [] });
      const contract = contractWith(approved, prev);
      const before = JSON.stringify(contract);
      const mayWrite = !r.stopped && r.incomplete.length === 0 && (!only || (prevVersion === '9.9.9' && prevModel === 'haiku' && prevShape === SHAPE));
      if (!mayWrite) {
        expect(() => recordReadProbe(contract, r), note).toThrow();
        expect(JSON.stringify(contract), note).toBe(before);
        continue;
      }
      const out = recordReadProbe(contract, r);
      const merged = { ...(only ? prev?.cases : {}), ...cases };
      const gate = Object.entries(merged).every(([id, v]) => id === 'C0' || v === 'pass' || v === 'info');
      const nowApproved = out.contract.claude.approvedVersions.includes('9.9.9');
      expect(nowApproved, note).toBe(approved.includes('9.9.9') || gate);
      expect(out.contract.claude.approvedVersions.filter((v: string) => v === '9.9.9').length, note).toBeLessThanOrEqual(1);
      expect(out.contract.claude.readProbe.cases.C0, note).toBe(nowApproved ? 'pass' : 'fail');
      for (const id of ids) if (only && !selected.includes(id) && prev?.cases[id]) expect(out.contract.claude.readProbe.cases[id], note).toBe(prev.cases[id]);
      expect(out.contract.claude.readProbe.history.length, note).toBe(only ? prev!.history.length + 1 : 1);
    }
  });
});

describe('claude-probe-reads.mjs --record end to end (invariants 6, 9, 10)', () => {
  function sandbox() {
    const root = tempDir('cc-probe-inv-');
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const tmp = path.join(root, 'tmp');
    for (const d of [bin, home, tmp]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho ${FAKE_TOKEN}\n`, { mode: 0o755 });
    // A copy of the probe and its helpers beside their own contract.json, so a recording run cannot touch the repository's.
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'server', 'core'), { recursive: true });
    for (const f of fs.readdirSync(path.join(PACKAGE_ROOT, 'scripts')).filter((n) => n === 'claude-probe-reads.mjs' || n.startsWith('probe-'))) fs.copyFileSync(path.join(PACKAGE_ROOT, 'scripts', f), path.join(pkg, 'scripts', f));
    for (const dir of ['claude', 'system']) fs.symlinkSync(path.join(PACKAGE_ROOT, 'server', dir), path.join(pkg, 'server', dir));
    const contract = path.join(pkg, 'server', 'core', 'contract.json');
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'server', 'core', 'contract.json'), contract);
    return { root, bin, home, tmp, script: path.join(pkg, 'scripts', 'claude-probe-reads.mjs'), contract };
  }
  type Box = ReturnType<typeof sandbox>;
  const record = (box: Box, claudeBody: string, extraEnv: Record<string, string> = {}) => {
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n${claudeBody}\n`, { mode: 0o755 });
    return spawnSync(process.execPath, [box.script, '--record'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ...extraEnv, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
    });
  };
  const canariesGone = (box: Box) => {
    expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
  };

  const incompleteRuns: Array<[string, string]> = [
    ['every case call fails to spawn (ENOENT)', 'rm -f "$0"\necho "9.9.9 (Claude Code)"'],
    ['every case call is killed before it exits', '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nkill -9 $$'],
  ];
  for (const [what, body] of incompleteRuns) {
    it(`given ${what}, when the probe runs with --record, then contract.json is left as it was and the run says nothing was recorded`, () => {
      const box = sandbox();
      const before = fs.readFileSync(box.contract, 'utf8');
      const r = record(box, body);
      expect(r.status, r.stderr).toBe(1);
      expect(fs.readFileSync(box.contract, 'utf8')).toBe(before);
      expect(r.stderr).toMatch(/nothing recorded/);
      expect(JSON.parse(r.stdout).version).toBe('9.9.9');
      canariesGone(box);
    }, 60_000);
  }

  it('given every case call exits on its own, when the probe runs with --record, then the failing record is written and the version is not approved', () => {
    const box = sandbox();
    const before = JSON.parse(fs.readFileSync(box.contract, 'utf8'));
    const r = record(box, '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 0');
    expect(r.status, r.stderr).toBe(1);
    const after = JSON.parse(fs.readFileSync(box.contract, 'utf8'));
    expect(after.claude.readProbe.version).toBe('9.9.9');
    expect(after.claude.readProbe.cases.C0).toBe('fail');
    expect(after.claude.approvedVersions).toEqual(before.claude.approvedVersions);
    expect(fs.readdirSync(path.dirname(box.contract))).toEqual(['contract.json']);
    canariesGone(box);
  }, 60_000);

  it('given the contract.json write fails part way (ENOSPC), when the probe records, then contract.json keeps its old bytes and no temp file is left', () => {
    const box = sandbox();
    const before = fs.readFileSync(box.contract, 'utf8');
    // A full volume: any write into server/core lands half its bytes, then fails.
    const preload = path.join(box.root, 'torn.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, data, ...rest) => {
  if (String(file).includes(${JSON.stringify(path.dirname(box.contract))})) {
    realWrite(file, String(data).slice(0, 40), ...rest);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  }
  return realWrite(file, data, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const r = record(box, '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 0', { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/ENOSPC/);
    expect(fs.readFileSync(box.contract, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(box.contract))).toEqual(['contract.json']);
    canariesGone(box);
  }, 60_000);

  it('given a case group that throws while its sibling call still runs, when the probe ends, then that call is stopped before cleanup and none outlives the probe (invariant 7)', async () => {
    const box = sandbox();
    const calls = path.join(box.root, 'calls');
    fs.mkdirSync(calls);
    // C9 starts c9-settings, then c9-control's settings file cannot be written, so the group throws with c9-settings running.
    const preload = path.join(box.root, 'c9-fails.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (String(file).endsWith('/c9-control/settings.json')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  return realWrite(file, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n: > "${calls}/$$"\nexec sleep 60\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [box.script, '--only', 'C9'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
    });
    // The call may not have recorded its pid before the probe exited; give a left-running one the time to do so.
    const until = Date.now() + 3_000;
    while (fs.readdirSync(calls).length === 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
    const alive = fs.readdirSync(calls).filter((pid) => {
      const ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
      return ps !== '' && !ps.startsWith('Z');
    });
    for (const pid of alive) process.kill(Number(pid), 'SIGKILL');
    expect(alive, r.stderr).toEqual([]);
    expect(r.status, r.stderr).toBe(1);
    const summary = JSON.parse(r.stdout);
    expect(summary.cases.C9).toBe('fail');
    expect(summary.details.C9.why).toMatch(/ENOSPC/);
    canariesGone(box);
  }, 60_000);

  it(`given random file faults and call endings (seed ${SEED}), when the probe runs, then every case settles, the summary prints and every canary is removed (invariant 5)`, () => {
    const rand = prng(SEED);
    const faults = ['stream.ndjson', 'stderr.txt', 'hook-log.ndjson'] as const;
    const endings = ['rm -f "$0"\necho "9.9.9 (Claude Code)"', '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 0', '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nkill -9 $$'];
    for (let i = 0; i < 4; i++) {
      const box = sandbox();
      const failing = faults.filter(() => rand() < 0.6);
      const ending = pick(rand, endings);
      const note = `seed ${SEED} iteration ${i}: faults ${failing.join(',') || 'none'}, ending ${JSON.stringify(ending)}`;
      const preload = path.join(box.root, 'faults.mjs');
      fs.writeFileSync(
        preload,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const failing = ${JSON.stringify(failing)};
const hit = (file) => failing.some((f) => String(file).endsWith('/' + f)) && String(file).includes('/guard/');
const fail = () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); };
for (const name of ['writeFileSync', 'readFileSync', 'existsSync']) {
  const real = fs[name];
  fs[name] = (file, ...rest) => (hit(file) && !(name === 'writeFileSync' && String(file).endsWith('hook-log.ndjson')) ? fail() : real(file, ...rest));
}
syncBuiltinESMExports();
`,
      );
      const claude = path.join(box.bin, 'claude');
      fs.writeFileSync(claude, `#!/bin/sh\n${ending}\n`, { mode: 0o755 });
      const r = spawnSync(process.execPath, [box.script, '--only', 'C1,C8,C14'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
      });
      expect(r.status, `${note}\n${r.stderr}`).toBe(1);
      expect(r.stderr, note).not.toMatch(/\n\s+at /);
      expect(Object.keys(JSON.parse(r.stdout).cases), note).toEqual(expect.arrayContaining(['C0', 'C1', 'C8', 'C14']));
      canariesGone(box);
      expect(fs.readdirSync(box.tmp).filter((n) => n.startsWith('cc-reads-probe-') && !n.startsWith('cc-reads-probe-summary-')), note).toEqual([]);
    }
  }, 60_000);

  it('given a signal that arrives while the normal end is still stopping a call, when the probe exits, then it exits with the signal code (invariant 7, FC-02)', async () => {
    const box = sandbox();
    const calls = path.join(box.root, 'calls');
    fs.mkdirSync(calls);
    // C9's group throws with c9-settings running, and every group kill misses, so the normal end waits in stopCalls.
    const preload = path.join(box.root, 'slow-end.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (String(file).endsWith('/c9-control/settings.json')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  return realWrite(file, ...rest);
};
syncBuiltinESMExports();
const realKill = process.kill.bind(process);
process.kill = (pid, signal) => (pid < 0 && signal === 'SIGKILL' ? true : realKill(pid, signal));
`,
    );
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n: > "${calls}/$$"\nexec sleep 60\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [box.script, '--only', 'C9'], {
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (fs.readdirSync(calls).length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(fs.readdirSync(calls).length, stderr).toBeGreaterThan(0);
    // The group has thrown by now (the failing write follows the spawn synchronously); the end waits up to 5 s.
    await new Promise((res) => setTimeout(res, 1_000));
    child.kill('SIGINT');
    const code = await exited;
    for (const pid of fs.readdirSync(calls)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    expect(code, stderr).toBe(130);
  }, 60_000);

  /** The pids recorded under `dir` whose process is still alive (not a zombie). */
  const aliveIn = (dir: string) =>
    fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim()).filter(Boolean).filter((pid) => {
      const ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
      return ps !== '' && !ps.startsWith('Z');
    });
  const killAll = (pids: string[]) => {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  const probeEnv = (box: Box, claude: string, preload?: string) => ({ ...process.env, ...(preload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}), HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude });
  /** A claude whose --version forks a long sleep and waits on it, recording the sleep's pid. */
  const hangingVersion = (box: Box, pids: string) => {
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 600 & echo $! > "${pids}/version-child"; wait; fi\nexit 0\n`, { mode: 0o755 });
    return claude;
  };

  it('given a call that times out while a member of its group outlives the first group kill, when the probe ends, then no member of that group is alive (invariant 11, R34-supervisor-L1-01)', () => {
    const box = sandbox();
    const pids = path.join(box.root, 'pids');
    fs.mkdirSync(pids);
    // The member was forked while the kill ran, so the first group SIGKILL reaches only the leader; the member then
    // recreates the call's project folder under ~/.claude/projects after the cleanup.
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n( sleep 1; mkdir -p "$HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"; exec sleep 60 ) </dev/null >/dev/null 2>&1 &\necho $! > "${pids}/member-$$"\nexec sleep 60\n`, { mode: 0o755 });
    const preload = timeoutsOnReady(box.root, [300_000], pids);
    fs.appendFileSync(
      preload,
      `const realKill = process.kill.bind(process);
const missed = new Set();
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL' && !missed.has(pid)) {
    missed.add(pid);
    return realKill(-pid, 'SIGKILL');
  }
  return realKill(pid, signal);
};
`,
    );
    const r = spawnSync(process.execPath, [box.script, '--only', 'C1'], { encoding: 'utf8', timeout: 30_000, env: probeEnv(box, claude, preload) });
    const alive = aliveIn(pids);
    killAll(alive);
    expect(fs.readdirSync(pids).length, r.stderr).toBeGreaterThan(0);
    expect(alive, r.stderr).toEqual([]);
    expect(r.status, r.stderr).toBe(1);
    expect(JSON.parse(r.stdout).cases).toHaveProperty('C0');
    canariesGone(box);
  }, 60_000);

  it('given a claude --version that forks and then hangs, when the version check times out, then the run stops and the forked process is gone (invariant 11, R34-supervisor-X-01)', () => {
    const box = sandbox();
    const pids = path.join(box.root, 'pids');
    fs.mkdirSync(pids);
    const claude = hangingVersion(box, pids);
    const r = spawnSync(process.execPath, [box.script], { encoding: 'utf8', timeout: 30_000, env: probeEnv(box, claude, timeoutsOnReady(box.root, [30_000], pids)) });
    const alive = aliveIn(pids);
    killAll(alive);
    expect(fs.readdirSync(pids), r.stderr).toEqual(['version-child']);
    expect(alive, r.stderr).toEqual([]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`claude not runnable at ${claude}`);
    expect(r.stderr).toMatch(/timed out/);
    canariesGone(box);
  }, 60_000);

  it('given a claude --version that forks and then hangs, when the probe gets SIGTERM, then it exits 143 at once and the forked process is gone (invariant 11)', async () => {
    const box = sandbox();
    const pids = path.join(box.root, 'pids');
    fs.mkdirSync(pids);
    const claude = hangingVersion(box, pids);
    const child = spawn(process.execPath, [box.script], { env: probeEnv(box, claude), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(pids, 'version-child')) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(fs.readdirSync(pids), stderr).toEqual(['version-child']);
    const sent = Date.now();
    child.kill('SIGTERM');
    const code = await exited;
    const alive = aliveIn(pids);
    killAll(alive);
    expect(code, stderr).toBe(143);
    expect(Date.now() - sent, stderr).toBeLessThan(10_000);
    expect(alive, stderr).toEqual([]);
    canariesGone(box);
  }, 60_000);

  /**
   * A CLI that acts out each Read and WebFetch step of its prompt the way the real one reports it: the hook payload
   * holds the tilde-expanded path and a transcript under ~/.claude/projects, and every refusal names the node binary,
   * the hook command and the expanded path.
   */
  function actingCli(box: Box, version: string) {
    const impl = path.join(box.bin, 'acting-claude.mjs');
    fs.writeFileSync(
      impl,
      `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log(${JSON.stringify(`${version} (Claude Code)`)}); process.exit(0); }
const flag = (f) => argv[argv.indexOf(f) + 1];
const prompt = flag('-p');
const sessionId = flag('--session-id');
const settingsFile = flag('--settings');
const hookCommand = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks.PreToolUse[0].hooks.at(-1).command;
const transcript = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
fs.writeFileSync(transcript, '{}\\n');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
let n = 0;
for (const [, tool, key, value] of prompt.matchAll(/Call the (Read|WebFetch) tool with (file_path|url) (\\S+)/g)) {
  const id = 'u' + n++;
  const expanded = value.replace(/^~/, os.homedir());
  fs.appendFileSync(path.join(path.dirname(settingsFile), 'hook-log.ndjson'), JSON.stringify({ tool_name: tool, tool_input: { [key]: expanded }, transcript_path: transcript }) + '\\n');
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input: { [key]: value } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'PreToolUse hook error: [' + process.execPath + ' ' + hookCommand + ']: ' + expanded + ' is outside the repo and data roots' }] } });
}
out({ type: 'result', is_error: false, permission_denials: [] });
`,
    );
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(impl)} "$@"\n`, { mode: 0o755 });
    return claude;
  }
  const runActing = (box: Box, claude: string, args: string[]) =>
    spawnSync(process.execPath, [box.script, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
    });
  const dashed = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');

  it('given cases whose payloads and results name the home, temp, checkout and node paths, when the probe records, then contract.json holds none of them (R35-supervisor-L2-01)', () => {
    const box = sandbox();
    const r = runActing(box, actingCli(box, '9.9.9'), ['--record']);
    expect(r.status, r.stderr).toBe(1);
    const probe = JSON.parse(fs.readFileSync(box.contract, 'utf8')).claude.readProbe;
    expect(probe.version, r.stderr).toBe('9.9.9');
    expect(probe.info.tildeHookPath).toMatch(/^\$HOME\/\.cc-probe-[0-9a-f]+\/h1\.txt$/);
    expect(probe.info.tildeResult).toMatch(/\$HOME\/\.cc-probe-/);
    expect(probe.info.c9ControlCalls.length).toBeGreaterThan(0);
    expect(probe.info.webFetchRaw.perUrl[0].url).toBe('file://$TMPDIR/cc-reads-probe-XXXXXX/outside/w1.txt');
    const recorded = JSON.stringify(probe);
    const real = (p: string) => fs.realpathSync(p);
    for (const p of [box.root, real(box.root), box.home, real(box.home), path.dirname(box.script), process.execPath]) {
      expect(recorded.includes(p), `${p} in ${recorded}`).toBe(false);
      expect(recorded.includes(dashed(p)), `${dashed(p)} in ${recorded}`).toBe(false);
    }
    expect(recorded).not.toMatch(/cc-reads-probe-(?!XXXXXX)/);
  }, 60_000);

  for (const flag of ['--raw-only', '--guarded-only']) {
    it(`given a record of this version, model and shape, when the probe records --only C13 ${flag}, then contract.json is left as it was (R35-supervisor-X-02)`, () => {
      const box = sandbox();
      const before = fs.readFileSync(box.contract, 'utf8');
      const r = runActing(box, actingCli(box, JSON.parse(before).claude.readProbe.version), ['--only', 'C13', flag, '--record']);
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toMatch(/nothing recorded/);
      expect(fs.readFileSync(box.contract, 'utf8')).toBe(before);
    }, 60_000);
  }
});

describe('claude-probe.mjs ends every CLI process group it starts (invariant 11)', () => {
  function box() {
    const root = tempDir('cc-probe-groups-');
    const bin = path.join(root, 'bin');
    const pids = path.join(root, 'pids');
    for (const d of [bin, pids, path.join(root, 'home'), path.join(root, 'tmp')]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho ${FAKE_TOKEN}\n`, { mode: 0o755 });
    return { root, bin, pids };
  }
  type GroupBox = ReturnType<typeof box>;
  const env = (b: GroupBox, claude: string, preload?: string) => ({ ...process.env, ...(preload ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}), HOME: path.join(b.root, 'home'), TMPDIR: path.join(b.root, 'tmp'), PATH: `${b.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude });
  const alive = (dir: string) =>
    fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim()).filter((pid) => {
      const ps = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
      return ps !== '' && !ps.startsWith('Z');
    });
  const reap = (pids: string[]) => {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  // Each forks a sleep, records its pid and waits on it: a timeout that kills only the direct child leaves the sleep.
  const hangs: Array<[string, string, number]> = [
    ['a CLI call', '[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nsleep 600 & echo $! > "$PIDS/call-$$"; wait', 180_000],
    ['claude --version', '[ "$1" = "--version" ] && { sleep 600 & echo $! > "$PIDS/version-$$"; wait; }\nexit 0', 30_000],
  ];
  for (const [what, body, timeout] of hangs) {
    it(`given ${what} that forks and then hangs, when its timeout passes, then the probe finishes and the forked process is gone`, () => {
      const b = box();
      const claude = path.join(b.bin, 'claude');
      fs.writeFileSync(claude, `#!/bin/sh\nPIDS="${b.pids}"\n${body}\n`, { mode: 0o755 });
      const r = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'claude-probe.mjs')], { encoding: 'utf8', timeout: 20_000, env: env(b, claude, timeoutsOnReady(b.root, [timeout], b.pids)) });
      const left = alive(b.pids);
      reap(left);
      expect(fs.readdirSync(b.pids).length, r.stderr).toBeGreaterThan(0);
      expect(left, r.stderr).toEqual([]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).probeA).toBeTruthy();
    }, 60_000);
  }

  it('given a CLI call that is running, when the probe gets SIGINT, then it exits 130 and the call\'s group is gone', async () => {
    const b = box();
    const claude = path.join(b.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nsleep 600 & echo $! > "${b.pids}/call-$$"\nwait\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'claude-probe.mjs')], { env: env(b, claude), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : null))));
    const deadline = Date.now() + 20_000;
    while (fs.readdirSync(b.pids).length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    expect(fs.readdirSync(b.pids).length, stderr).toBeGreaterThan(0);
    child.kill('SIGINT');
    const code = await exited;
    const left = alive(b.pids);
    reap(left);
    expect(code, stderr).toBe(130);
    expect(left, stderr).toEqual([]);
  }, 60_000);
});
