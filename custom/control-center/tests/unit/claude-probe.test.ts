import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

const FAKE_TOKEN = 'fake-probe-token';

/** A throwaway HOME, TMPDIR and PATH whose `security` hands out a fake Keychain token. */
function sandbox() {
  const root = tempDir('cc-claude-probe-');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const calls = path.join(root, 'calls');
  for (const d of [bin, home, tmp, calls]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'security'), `#!/bin/sh\necho ${FAKE_TOKEN}\n`, { mode: 0o755 });
  return { root, bin, home, tmp, calls };
}

function runProbe(script: string, box: ReturnType<typeof sandbox>, claudeBin: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  return spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: box.home,
      TMPDIR: box.tmp,
      PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      CC_CLAUDE_BIN: claudeBin,
      PROBE_FAKE_CALLS: box.calls,
    },
  });
}

describe('claude-probe.mjs (npm run probe:claude)', () => {
  it('gives every CLI run, --version included, a scrubbed environment with the autoupdater off', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    // Records each call's first argument and environment, one file per call.
    fs.writeFileSync(claude, '#!/bin/sh\nf=$(mktemp "$PROBE_FAKE_CALLS/call-XXXXXX")\n{ echo "ARG1=$1"; env; } > "$f"\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n', { mode: 0o755 });
    const r = runProbe('claude-probe.mjs', box, claude, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDECODE: '1', CC_PROBE_LEAK: 'x' });
    expect(r.status, r.stderr).toBe(0);
    const calls = fs.readdirSync(box.calls).map((n) => fs.readFileSync(path.join(box.calls, n), 'utf8').split('\n'));
    expect(calls.map((lines) => lines[0]).sort()).toEqual(['ARG1=--version', 'ARG1=-p', 'ARG1=-p']);
    for (const lines of calls) {
      expect(lines).toContain('DISABLE_AUTOUPDATER=1');
      expect(lines.filter((l) => /^(ANTHROPIC_BASE_URL|CLAUDECODE|CC_PROBE_LEAK|CC_CLAUDE_BIN)=/.test(l))).toEqual([]);
    }
    for (const lines of calls.filter((l) => l[0] === 'ARG1=-p')) expect(lines).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}`);
  });

  it('treats an empty or blank CC_CLAUDE_BIN as unset and runs the claude on PATH (R27-sup1-rev-01)', () => {
    for (const value of ['', '  ']) {
      const box = sandbox();
      fs.writeFileSync(path.join(box.bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n', { mode: 0o755 });
      const r = runProbe('claude-probe.mjs', box, value);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).claudeVersion, JSON.stringify(value)).toMatch(/9\.9\.9/);
    }
  });

  it('prints the summary with the spawn error instead of crashing when the CLI cannot be spawned', () => {
    const box = sandbox();
    const r = runProbe('claude-probe.mjs', box, path.join(box.bin, 'no-such-claude'));
    expect(r.stderr).not.toMatch(/TypeError/);
    expect(r.status, r.stderr).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.claudeVersion).toMatch(/ENOENT/);
    expect(summary.probeA).toMatchObject({ exitStatus: null, eventTypes: [] });
    expect(summary.probeA.stderrTail).toMatch(/ENOENT/);
    expect(summary.probeB.stderrTail).toMatch(/ENOENT/);
  });

  it('refuses a blank Keychain token before running the CLI, as probe:reads does (R28-supervisor-L2-01)', () => {
    for (const stored of ['', '   ']) {
      const box = sandbox();
      fs.writeFileSync(path.join(box.bin, 'security'), `#!/bin/sh\necho '${stored}'\n`, { mode: 0o755 });
      const claude = path.join(box.bin, 'claude');
      fs.writeFileSync(claude, '#!/bin/sh\nf=$(mktemp "$PROBE_FAKE_CALLS/call-XXXXXX")\necho "$1" > "$f"\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n', { mode: 0o755 });
      const r = runProbe('claude-probe.mjs', box, claude);
      expect(r.status, JSON.stringify(stored) + r.stdout).toBe(1);
      expect(r.stderr).toMatch(/Keychain item career-ops-claude-token not found/);
      expect(fs.readdirSync(box.calls)).toEqual([]);
      expect(fs.readdirSync(box.tmp), 'a refused run leaves no temp dir').toEqual([]);
    }
  });
});

describe('claude-probe-reads.mjs (npm run probe:reads)', () => {
  it('treats an empty or blank CC_CLAUDE_BIN as unset and runs the claude on PATH (R27-sup1-rev-01)', () => {
    for (const value of ['', '  ']) {
      const box = sandbox();
      // Answers --version and fails every other call: only the version read matters here. It must not delete itself,
      // because a bare `claude` would then resolve to the real CLI further down PATH and make network calls.
      fs.writeFileSync(path.join(box.bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 1\n', { mode: 0o755 });
      const r = runProbe('claude-probe-reads.mjs', box, value);
      expect(JSON.parse(r.stdout).version, JSON.stringify(value) + r.stderr).toBe('9.9.9');
    }
  });

  it('names the missing binary and its ENOENT instead of a null-stdout TypeError when --version cannot be spawned (R33-supervisor-X-01)', () => {
    const box = sandbox();
    const missing = path.join(box.bin, 'no-such-claude');
    const r = runProbe('claude-probe-reads.mjs', box, missing);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/TypeError/);
    expect(r.stderr).toContain(`claude not runnable at ${missing}`);
    expect(r.stderr).toMatch(/ENOENT/);
    expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
  });

  it('still removes the home and ~/.claude canaries and prints the summary when the CLI cannot be spawned', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    // Answers --version, then disappears, so every case's spawn fails with ENOENT.
    fs.writeFileSync(claude, '#!/bin/sh\nrm -f "$0"\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
    const r = runProbe('claude-probe-reads.mjs', box, claude);
    expect(r.stderr).not.toMatch(/ENOENT[\s\S]*at onErrorNT/);
    expect(r.status).toBe(1);
    const summary = JSON.parse(r.stdout);
    expect(summary.version).toBe('9.9.9');
    expect(Object.keys(summary.cases).length).toBeGreaterThan(1);
    expect(Object.values(summary.details).some((d) => /not attempted/.test(String((d as { why?: unknown }).why)))).toBe(true);
    expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude', 'projects'))).toEqual([]);
  });

  it('keeps the spawn error in each case\'s stderr.txt under --keep when the CLI cannot be spawned', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\nrm -f "$0"\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
    const r = runProbe('claude-probe-reads.mjs', box, claude, {}, ['--keep']);
    const kept = /probe dir kept: (.+)/.exec(r.stderr)?.[1];
    expect(kept, r.stderr).toBeTruthy();
    const guard = path.join(String(kept), 'guard');
    const logs = fs.readdirSync(guard).map((n) => path.join(guard, n, 'stderr.txt')).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
    fs.rmSync(String(kept), { recursive: true, force: true });
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(log).toMatch(/ENOENT/);
  });

  it('settles every case and removes the canaries when a spawn fails with EMFILE before its pipes exist and stderr.txt cannot be written', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
    // Out of descriptors: spawn reports EMFILE with no pipes and no 'close', and the error write fails the same way.
    const preload = path.join(box.root, 'emfile.mjs');
    fs.writeFileSync(
      preload,
      `import cp from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
cp.spawn = () => {
  const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null, kill: () => false });
  process.nextTick(() => child.emit('error', Object.assign(new Error('spawn claude EMFILE'), { code: 'EMFILE' })));
  return child;
};
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (String(file).endsWith('stderr.txt')) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  return realWrite(file, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const r = runProbe('claude-probe-reads.mjs', box, claude, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(r.stderr).not.toMatch(/too many open files[\s\S]*\n\s+at /);
    expect(r.status).toBe(1);
    const summary = JSON.parse(r.stdout);
    expect(Object.keys(summary.cases).length).toBeGreaterThan(1);
    expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
  });
  it('given a call that exits but whose stream.ndjson and stderr.txt cannot be written, when the probe runs, then every case settles and the canaries are removed (R31-supervisor-L1-02)', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    // Answers --version; every case call exits at once with no output, so each one settles through 'close'.
    fs.writeFileSync(claude, '#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n', { mode: 0o755 });
    // A full volume: the writes of a finished call's logs fail with ENOSPC.
    const preload = path.join(box.root, 'enospc.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => {
  if (/(stream\\.ndjson|stderr\\.txt)$/.test(String(file))) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  return realWrite(file, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const r = runProbe('claude-probe-reads.mjs', box, claude, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    expect(r.stderr).not.toMatch(/no space left on device[\s\S]*\n\s+at /);
    expect(r.status, r.stderr).toBe(1);
    const summary = JSON.parse(r.stdout);
    expect(Object.keys(summary.cases).length).toBeGreaterThan(1);
    expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude', 'projects'))).toEqual([]);
    expect(fs.readdirSync(box.tmp).filter((n) => n.startsWith('cc-reads-probe-') && !n.startsWith('cc-reads-probe-summary-'))).toEqual([]);
  });
  // The calls lead their own process groups, so a terminal hang-up reaches only the probe, which must pass it on.
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`on ${signal} mid-run stops the running CLI calls, removes every canary and the temp layout, and exits ${exitCode} (R28-supervisor-L1-01)`, async () => {
      const box = sandbox();
      const claude = path.join(box.bin, 'claude');
      // Answers --version; every case call starts a child of its own (a hook, a Bash-tool command), records both pids
      // and hangs, as a real call does for minutes.
      // The real CLI creates its project folder (named after the cwd) before any hook runs, so no hook log names it.
      fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nmkdir -p "$HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"\nsleep 60 &\n: > "${box.calls}/$!"\n: > "${box.calls}/$$"\nwait\n`, { mode: 0o755 });
      const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'claude-probe-reads.mjs')], {
        env: { ...process.env, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      const deadline = Date.now() + 20_000;
      while (fs.readdirSync(box.calls).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(fs.readdirSync(box.calls).length, stderr).toBeGreaterThan(0);
      child.kill(signal);
      const code = await exited;
      // A killed process can linger as a zombie until it is reaped, so give the stub's processes a moment to go.
      const stubAlive = () => fs.readdirSync(box.calls).filter((pid) => {
        const ps = spawnSync('ps', ['-o', 'stat=,command=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
        return ps !== '' && !ps.startsWith('Z') && (ps.includes('sleep 60') || ps.includes(claude));
      });
      const until = Date.now() + 2_000;
      let alive = stubAlive();
      while (alive.length && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
        alive = stubAlive();
      }
      for (const pid of alive) process.kill(Number(pid), 'SIGKILL');
      expect(code, stderr).toBe(exitCode);
      expect(alive).toEqual([]);
      expect(fs.readdirSync(box.home).filter((n) => n.startsWith('.cc-probe-'))).toEqual([]);
      expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
      expect(fs.readdirSync(path.join(box.home, '.claude', 'projects'))).toEqual([]);
      expect(fs.readdirSync(box.tmp).filter((n) => n.startsWith('cc-reads-probe-') && !n.startsWith('cc-reads-probe-summary-'))).toEqual([]);
    }, 40_000);
  }

  it('given a call process the first SIGKILL of its group misses, when the probe gets SIGTERM, then it cleans up only once the group is gone (R31-flake-claude-probe)', async () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    // Under load a group kill can miss a member (one forked while the kill ran) or land after it already acted: that
    // member creates its project folder after the kill was sent. Modelled here by a first group SIGKILL that misses.
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n: > "${box.calls}/$$"\nsleep 0.5\nmkdir -p "$HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"\nexec sleep 60\n`, { mode: 0o755 });
    const preload = path.join(box.root, 'kill-misses.mjs');
    fs.writeFileSync(
      preload,
      `const realKill = process.kill.bind(process);
const missed = new Set();
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL' && !missed.has(pid)) {
    missed.add(pid);
    return true;
  }
  return realKill(pid, signal);
};
`,
    );
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'claude-probe-reads.mjs')], {
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (fs.readdirSync(box.calls).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(box.calls).length, stderr).toBeGreaterThan(0);
    child.kill('SIGTERM');
    const code = await exited;
    // Long enough for a call the probe left running to reach its mkdir.
    await new Promise((r) => setTimeout(r, 1_000));
    const alive = fs.readdirSync(box.calls).filter((pid) => {
      const ps = spawnSync('ps', ['-o', 'stat=,command=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
      return ps !== '' && !ps.startsWith('Z');
    });
    for (const pid of alive) process.kill(Number(pid), 'SIGKILL');
    expect(code, stderr).toBe(143);
    expect(alive).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude', 'projects'))).toEqual([]);
    expect(fs.readdirSync(box.tmp).filter((n) => n.startsWith('cc-reads-probe-') && !n.startsWith('cc-reads-probe-summary-'))).toEqual([]);
  }, 40_000);

  /** A preload under which removing the home canary dir fails with EBUSY. */
  function homeRmFails(box: ReturnType<typeof sandbox>) {
    const preload = path.join(box.root, 'rm-fails.mjs');
    fs.writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRm = fs.rmSync;
fs.rmSync = (target, ...rest) => {
  if (String(target).includes('.cc-probe-')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  return realRm(target, ...rest);
};
syncBuiltinESMExports();
`,
    );
    return preload;
  }

  /** The cleanup steps after the failing one still ran: the summary is out and the other canaries are gone. */
  function expectRestCleaned(box: ReturnType<typeof sandbox>, stdout: string) {
    expect(JSON.parse(stdout).version).toBe('9.9.9');
    expect(fs.readdirSync(path.join(box.home, '.claude')).filter((n) => n.startsWith('cc-probe-'))).toEqual([]);
    expect(fs.readdirSync(path.join(box.home, '.claude', 'projects'))).toEqual([]);
    expect(fs.readdirSync(box.tmp).filter((n) => n.startsWith('cc-reads-probe-') && !n.startsWith('cc-reads-probe-summary-'))).toEqual([]);
  }

  it('finishes the rest of the cleanup and says which canaries may remain when a step fails at the end of a run (R28-supervisor-L1-01 review)', () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\nrm -f "$0"\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
    const r = runProbe('claude-probe-reads.mjs', box, claude, { NODE_OPTIONS: `--import=${pathToFileURL(homeRmFails(box)).href}` });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/cleanup failed: .*EBUSY/);
    expect(r.stderr).toContain(path.join(box.home, '.cc-probe-'));
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expectRestCleaned(box, r.stdout);
    fs.rmSync(box.home, { recursive: true, force: true });
  });

  it('says which canaries may remain when the cleanup after a signal fails (R28-supervisor-L1-01 review)', async () => {
    const box = sandbox();
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n: > "${box.calls}/$$"\nexec sleep 60\n`, { mode: 0o755 });
    const preload = homeRmFails(box);
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'claude-probe-reads.mjs')], {
      env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => (stdout += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (fs.readdirSync(box.calls).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGINT');
    expect(await exited, stderr).toBe(130);
    expect(stderr).toMatch(/cleanup failed: .*EBUSY/);
    expect(stderr).toContain(path.join(box.home, '.cc-probe-'));
    expect(stderr).not.toContain(FAKE_TOKEN);
    expectRestCleaned(box, stdout);
    fs.rmSync(box.home, { recursive: true, force: true });
  }, 40_000);
});

describe('the probes run the claude binary the supervisor preflight picks (R29-supervisor-L2-01)', () => {
  /** A fake claude that answers --version and records the first argument of every call. */
  const fakeClaude = (file: string, calls: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\nf=$(mktemp "${calls}/call-XXXXXX")\necho "ARG1=$1" > "$f"\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 1\n`, { mode: 0o755 });
  };
  /** Runs a probe from `cwd` with only the sandbox and the system folders on PATH, so no real claude is found. */
  const probeIn = (script: string, box: ReturnType<typeof sandbox>, cwd: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', script)], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, ...env },
    });
  const firstArgs = (calls: string) => fs.readdirSync(calls).map((n) => fs.readFileSync(path.join(calls, n), 'utf8').trim());

  for (const script of ['claude-probe.mjs', 'claude-probe-reads.mjs']) {
    it(`given CC_CLAUDE_BIN is a relative path, when ${script} runs under npm, then every call runs it from the folder npm was started in`, () => {
      const box = sandbox();
      fakeClaude(path.join(box.root, 'tools', 'claude'), box.calls);
      // npm runs the script with its cwd at the package and INIT_CWD at the folder the user typed the command in.
      const r = probeIn(script, box, PACKAGE_ROOT, { CC_CLAUDE_BIN: 'tools/claude', INIT_CWD: box.root });
      const summary = JSON.parse(r.stdout || '{}');
      expect(summary.version ?? summary.claudeVersion, r.stderr).toMatch(/9\.9\.9/);
      const args = firstArgs(box.calls);
      expect(args).toContain('ARG1=--version');
      expect(args.some((a) => a === 'ARG1=-p'), r.stdout + r.stderr).toBe(true);
    }, 60_000);

    it(`given claude is installed only in ~/.local/bin, when ${script} runs, then it finds it as the preflight does`, () => {
      const box = sandbox();
      fakeClaude(path.join(box.home, '.local', 'bin', 'claude'), box.calls);
      const r = probeIn(script, box, box.root, {});
      const summary = JSON.parse(r.stdout || '{}');
      expect(summary.version ?? summary.claudeVersion, r.stderr).toMatch(/9\.9\.9/);
      expect(firstArgs(box.calls).some((a) => a === 'ARG1=-p'), r.stdout + r.stderr).toBe(true);
    }, 60_000);
  }
});

describe('claude-probe-reads.mjs --record', () => {
  /** A copy of the probe beside its own contract.json, so a run that records cannot touch the repository's. */
  function probeCopy(box: ReturnType<typeof sandbox>) {
    const pkg = path.join(box.root, 'pkg');
    fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'server', 'core'), { recursive: true });
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'scripts', 'claude-probe-reads.mjs'), path.join(pkg, 'scripts', 'claude-probe-reads.mjs'));
    for (const dir of ['claude', 'system']) fs.symlinkSync(path.join(PACKAGE_ROOT, 'server', dir), path.join(pkg, 'server', dir));
    const contract = path.join(pkg, 'server', 'core', 'contract.json');
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'server', 'core', 'contract.json'), contract);
    return { script: path.join(pkg, 'scripts', 'claude-probe-reads.mjs'), contract };
  }

  it('given a run with --record, when a signal stops it mid-run, then contract.json is left as it was (R32-supervisor-L1-01)', async () => {
    const box = sandbox();
    const { script, contract } = probeCopy(box);
    const before = fs.readFileSync(contract, 'utf8');
    const claude = path.join(box.bin, 'claude');
    // Answers --version; every case call records its pid and hangs, as a real call does for minutes.
    fs.writeFileSync(claude, `#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\n: > "${box.calls}/$$"\nexec sleep 60\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [script, '--record'], {
      env: { ...process.env, HOME: box.home, TMPDIR: box.tmp, PATH: `${box.bin}${path.delimiter}${process.env.PATH ?? ''}`, CC_CLAUDE_BIN: claude },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (fs.readdirSync(box.calls).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(box.calls).length, stderr).toBeGreaterThan(0);
    child.kill('SIGINT');
    expect(await exited, stderr).toBe(130);
    expect(fs.readFileSync(contract, 'utf8')).toBe(before);
  }, 40_000);
});

describe('the probes read the Keychain as the preflight does (R32-supervisor-L2-03)', () => {
  /** A sandbox whose `security` runs `body`, and a claude that records every call. */
  function keychainBox(body: string) {
    const box = sandbox();
    fs.writeFileSync(path.join(box.bin, 'security'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const claude = path.join(box.bin, 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\nf=$(mktemp "$PROBE_FAKE_CALLS/call-XXXXXX")\necho "$1" > "$f"\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\nexit 0\n', { mode: 0o755 });
    return { box, claude };
  }

  for (const script of ['claude-probe.mjs', 'claude-probe-reads.mjs']) {
    it(`given a locked keychain that cannot prompt, when ${script} runs, then it says the item could not be read rather than that it is missing`, () => {
      const { box, claude } = keychainBox("echo 'User interaction is not allowed.' >&2\nexit 36");
      const r = runProbe(script, box, claude);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Could not read Keychain item career-ops-claude-token: security failed \(exit 36: User interaction is not allowed\.\)/);
      expect(r.stderr).toMatch(/security unlock-keychain/);
      expect(r.stderr).not.toMatch(/not found/);
      expect(fs.readdirSync(box.calls)).toEqual([]);
      expect(fs.readdirSync(box.tmp)).toEqual([]);
    });

    it(`given no Keychain item (security exit 44), when ${script} runs, then it says the item is not found`, () => {
      const { box, claude } = keychainBox("echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2\nexit 44");
      const r = runProbe(script, box, claude);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Keychain item career-ops-claude-token not found/);
      expect(fs.readdirSync(box.calls)).toEqual([]);
    });

    it(`given a security that waits at an unlock prompt, when ${script} runs, then it gives up after 8 s and says so`, () => {
      const { box, claude } = keychainBox('exec sleep 30');
      const started = Date.now();
      const r = runProbe(script, box, claude);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Could not read Keychain item career-ops-claude-token: security timed out after 8s/);
      expect(fs.readdirSync(box.calls)).toEqual([]);
    }, 40_000);
  }
});

describe('the probes give the CLI the environment the app gives its Claude sessions (R32-supervisor-X-02)', () => {
  for (const script of ['claude-probe.mjs', 'claude-probe-reads.mjs']) {
    it(`given a shell that exports repository and data-file overrides, when ${script} runs, then every CLI call gets them as server/system/child-env.ts leaves them`, () => {
      const box = sandbox();
      const claude = path.join(box.bin, 'claude');
      // Records each call's first argument and environment, one file per call; every case call fails at once.
      fs.writeFileSync(claude, '#!/bin/sh\nf=$(mktemp "$PROBE_FAKE_CALLS/call-XXXXXX")\n{ echo "ARG1=$1"; env; } > "$f"\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)" && exit 0\nexit 1\n', { mode: 0o755 });
      const r = runProbe(script, box, claude, { GIT_DIR: path.join(box.root, 'other-repo'), GIT_CONFIG_KEY_0: 'core.hooksPath', CAREER_OPS_PIPELINE: path.join(box.root, 'elsewhere.md') });
      const calls = fs.readdirSync(box.calls).map((n) => fs.readFileSync(path.join(box.calls, n), 'utf8').split('\n'));
      const cases = calls.filter((lines) => lines[0] === 'ARG1=-p');
      expect(cases.length, r.stdout + r.stderr).toBeGreaterThan(0);
      for (const lines of calls) {
        expect(lines.filter((l) => /^(GIT_DIR|GIT_CONFIG_KEY_0)=/.test(l))).toEqual([]);
        expect(lines).toContain('CAREER_OPS_PIPELINE=');
        expect(lines.find((l) => l.startsWith('NODE_OPTIONS='))).toMatch(/--import=file:.*local-file-guard\.mjs/);
      }
      for (const lines of cases) expect(lines).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}`);
    }, 60_000);
  }
});
