import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
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
});

describe('claude-probe-reads.mjs (npm run probe:reads)', () => {
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
});
