import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { preflight, resolveClaudeBin, claudeCandidates, testHost, versionAtLeast, KEYCHAIN_HELP, NODE_FLOOR } from '../../supervisor/preflight.js';
import { tempDir } from '../helpers/tmp.js';
import { configFromEnv } from '../../server/config.js';

// Preflight also requires an approved `claude --version`: read confinement is probed per CLI version.
const execOk = async (cmd: string) => (cmd === 'claude' ? { code: 0, stdout: '2.1.289 (Claude Code)\n' } : 0);
const approvedVersions = ['2.1.289'];
const fakeVersion = { code: 0, stdout: '0.0.0-fake (Control Center test double)\n' };
/** The host these checks assume, never this machine's: macOS and no managed settings (Linux or an MDM profile would fail them). */
const host = () => ({ platform: 'darwin' as const, managedSettings: { dir: tempDir('cc-managed-'), plists: [] } });

describe('preflight', () => {
  it('compares versions numerically against the Node floor', () => {
    // Requirement change: the floor is the lowest Node every dependency accepts, 22.22.2 (it was 22.6.0).
    expect(versionAtLeast('v22.22.2', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v26.4.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v22.22.1', NODE_FLOOR)).toBe(false);
    expect(versionAtLeast('v22.6.0', NODE_FLOOR)).toBe(false);
    expect(versionAtLeast('v9.99.0', NODE_FLOOR)).toBe(false);
  });

  it('passes with a runnable claude, a Keychain item and no API key', async () => {
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec: execOk, approvedVersions });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('fails loudly when the claude binary is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'claude' ? 127 : 0);
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('CC_CLAUDE_BIN');
  });

  it('prints the setup-token instructions when the Keychain item is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : 0);
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(KEYCHAIN_HELP);
  });

  it('skips the Keychain check under NODE_ENV=test so the fake Claude runs anywhere', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : cmd === 'claude' ? fakeVersion : 0);
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' }, exec });
    expect(r.ok).toBe(true);
  });

  it('fails below the Node floor and warns about ANTHROPIC_API_KEY', async () => {
    const r = await preflight({ ...host(), claudeBin: 'claude', nodeVersion: 'v20.0.0', env: { ANTHROPIC_API_KEY: 'x' }, exec: execOk });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('below the floor');
    expect(r.warnings[0]).toContain('ANTHROPIC_API_KEY');
  });
});

/** A real executable standing in for claude, so the probe's spawn, timeout and retry paths run for real. */
function fakeClaude(body: string): string {
  const dir = tempDir('cc-preflight-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}
const base = { nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' }, ...host() };

describe('test-only host pins (SW3-tests-23)', () => {
  it('under NODE_ENV=test, pin the platform and a managed-settings folder with no MDM profile', () => {
    expect(testHost({ NODE_ENV: 'test', CC_FAKE_PLATFORM: 'darwin', CC_FAKE_MANAGED_SETTINGS_DIR: '/tmp/managed' })).toEqual({ platform: 'darwin', managedSettings: { dir: '/tmp/managed', plists: [] } });
    expect(testHost({ NODE_ENV: 'test' })).toEqual({});
  });

  it('outside tests they are ignored, so a real launch always checks the real host', () => {
    for (const NODE_ENV of [undefined, 'development', 'production']) {
      expect(testHost({ NODE_ENV, CC_FAKE_PLATFORM: 'darwin', CC_FAKE_MANAGED_SETTINGS_DIR: '/tmp/managed' }), String(NODE_ENV)).toEqual({});
    }
  });
});

describe('preflight claude probe', () => {
  it('warns when more than one claude binary is installed, naming the one in use', async () => {
    const r = await preflight({ ...base, claudeBin: '/a/claude', claudeCandidates: ['/a/claude', '/b/claude'], exec: async (cmd) => (cmd === '/a/claude' ? fakeVersion : 0) });
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('/a/claude');
    expect(r.warnings[0]).toContain('/b/claude');
    expect(r.warnings[0]).toContain('CC_CLAUDE_BIN');
  });

  it('does not warn for a single claude binary', async () => {
    const r = await preflight({ ...base, claudeBin: '/a/claude', claudeCandidates: ['/a/claude'], exec: async () => 0 });
    expect(r.warnings).toEqual([]);
  });

  it('waits for a slow cold start instead of failing at the old 8 second limit', async () => {
    const bin = fakeClaude("setTimeout(() => { console.log('0.0.0-fake (Claude Code)'); }, 1200);");
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 5000 });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('reports a timeout as a timeout, after retrying once', async () => {
    const marker = path.join(tempDir('cc-preflight-'), 'runs');
    // Each attempt must start well inside the 1.5 s timeout to record itself. A node fake can take longer than that to
    // boot on a loaded machine, and the first run of any new executable waits on the OS check of it, so this is a
    // shell fake that has run once (with `warm`) before the probe times it.
    const bin = path.join(tempDir('cc-preflight-'), 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = warm ] && exit 0\nprintf x >> '${marker}'\nexec sleep 10\n`, { mode: 0o755 });
    expect(spawnSync(bin, ['warm']).status).toBe(0);
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not runnable at ".*claude"/);
    expect(r.errors[0]).toMatch(/timed out after 1\.5s/);
    expect(r.errors[0]).toContain('CC_CLAUDE_BIN');
    expect(fs.readFileSync(marker, 'utf8')).toBe('xx');
  });

  it('passes when the first attempt fails and the retry succeeds', async () => {
    const marker = path.join(tempDir('cc-preflight-'), 'seen');
    const bin = fakeClaude(`const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('updating'); process.exit(3); } console.log('0.0.0-fake');`);
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 5000 });
    expect(r.ok).toBe(true);
  });

  it('includes the exit code and the stderr tail when the binary keeps failing', async () => {
    const bin = fakeClaude("console.error('first line'); console.error('self-update failed: EACCES'); process.exit(7);");
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('exit code 7');
    expect(r.errors[0]).toContain('self-update failed: EACCES');
  });

  it('asks claude --version with the autoupdater off, so starting the app can never update the CLI past the approved version (SW2-tests-05)', async () => {
    const marker = path.join(tempDir('cc-preflight-env-'), 'env');
    const bin = fakeClaude(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.env.DISABLE_AUTOUPDATER)); console.log('0.0.0-fake');`);
    const saved = process.env.DISABLE_AUTOUPDATER;
    delete process.env.DISABLE_AUTOUPDATER;
    try {
      expect((await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 5000 })).ok).toBe(true);
    } finally {
      if (saved !== undefined) process.env.DISABLE_AUTOUPDATER = saved;
    }
    expect(fs.readFileSync(marker, 'utf8')).toBe('1');
  });

  it('says the binary was not found for ENOENT', async () => {
    const r = await preflight({ ...base, claudeBin: path.join(os.tmpdir(), 'cc-no-such-claude'), claudeTimeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('not found (ENOENT)');
  });
});

describe('resolveClaudeBin', () => {
  const touch = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    return bin;
  };

  it('keeps an absolute path as given', () => {
    expect(resolveClaudeBin('/opt/custom/claude', { env: { PATH: '' }, home: '/h' })).toBe('/opt/custom/claude');
  });

  it('makes a relative path with a slash absolute, against the folder bin/cc was started from (npm sets INIT_CWD), else the cwd', () => {
    expect(resolveClaudeBin('./bin/claude', { env: { PATH: '', INIT_CWD: '/work/here' }, home: '/h' })).toBe('/work/here/bin/claude');
    expect(resolveClaudeBin('tools/claude', { env: { PATH: '', INIT_CWD: '/work/here' }, home: '/h' })).toBe('/work/here/tools/claude');
    expect(resolveClaudeBin('./bin/claude', { env: { PATH: '' }, home: '/h' })).toBe(path.resolve('bin/claude'));
  });

  // realpathSync.native asks the OS; plain fs.realpathSync collapses `..` on paper first, like path.resolve.
  describe('through a symlinked folder (link -> real/bin, claude at real/claude), as the kernel and install.sh read it', () => {
    const layout = () => {
      const dir = tempDir('cc-symlink-');
      fs.mkdirSync(path.join(dir, 'real', 'bin'), { recursive: true });
      const real = touch(path.join(dir, 'real'));
      fs.symlinkSync(path.join(dir, 'real', 'bin'), path.join(dir, 'link'));
      return { dir, real: fs.realpathSync.native(real) };
    };

    it('keeps an absolute path with .. verbatim, so it opens the file the shell would', () => {
      const { dir, real } = layout();
      const given = `${dir}/link/../claude`;
      const resolved = resolveClaudeBin(given, { env: { PATH: '' }, home: '/h' });
      expect(resolved).toBe(given);
      expect(fs.realpathSync.native(resolved)).toBe(real);
    });

    it('joins a relative path with .. to the start folder as text, without collapsing the ..', () => {
      const { dir, real } = layout();
      const resolved = resolveClaudeBin('link/../claude', { env: { PATH: '', INIT_CWD: dir }, home: '/h' });
      expect(resolved).toBe(`${dir}/link/../claude`);
      expect(fs.realpathSync.native(resolved)).toBe(real);
    });

    it('configFromEnv pins the same file for sessions, the daily plist and Run the daily job now', () => {
      const { dir, real } = layout();
      for (const [k, v] of Object.entries({ CC_DATA_ROOT: '/d', CC_GUARD_DIR: '/g', CC_TOKEN: 't', CC_SESSION_SECRET: 's' })) vi.stubEnv(k, v);
      try {
        expect(fs.realpathSync.native(configFromEnv({ CC_PUBLIC_PORT: '4999', CC_CLAUDE_BIN: `${dir}/link/../claude` }).claudeBin)).toBe(real);
        expect(fs.realpathSync.native(configFromEnv({ CC_PUBLIC_PORT: '4999', CC_CLAUDE_BIN: 'link/../claude', INIT_CWD: dir }).claudeBin)).toBe(real);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('finds claude on PATH and returns an absolute path', () => {
    const dir = tempDir('cc-path-');
    const bin = touch(path.join(dir, 'bin'));
    expect(resolveClaudeBin('claude', { env: { PATH: `/nonexistent:${path.dirname(bin)}` }, home: '/h' })).toBe(bin);
  });

  it('falls back to the usual install locations when PATH has no claude', () => {
    const home = tempDir('cc-home-');
    const local = touch(path.join(home, '.local', 'bin'));
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home, candidates: ['/nonexistent/a/claude'] })).toBe(local);
  });

  it('prefers the native installer location over Homebrew and /usr/local when PATH has no claude', () => {
    const home = tempDir('cc-home-');
    const local = touch(path.join(home, '.local', 'bin'));
    const brew = touch(tempDir('cc-brew-'));
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home, candidates: [brew] })).toBe(local);
  });

  it('lists every distinct claude it can find, in the order it would pick them', () => {
    const home = tempDir('cc-home-');
    const local = touch(path.join(home, '.local', 'bin'));
    const brew = touch(tempDir('cc-brew-'));
    const onPath = touch(tempDir('cc-path-'));
    expect(claudeCandidates('claude', { env: { PATH: path.dirname(onPath) }, home, candidates: [brew, local] })).toEqual([onPath, local, brew]);
  });

  it('counts a symlink to the same binary once and keeps the first path listed for it', () => {
    const home = tempDir('cc-home-');
    const local = touch(path.join(home, '.local', 'bin'));
    const linkDir = tempDir('cc-link-');
    const link = path.join(linkDir, 'claude');
    fs.symlinkSync(local, link);
    expect(claudeCandidates('claude', { env: { PATH: '/nonexistent' }, home, candidates: [link] })).toEqual([local]);
    expect(claudeCandidates('claude', { env: { PATH: linkDir }, home, candidates: [] })).toEqual([link]);
  });

  it('returns the bare name when nothing is found so the probe can report ENOENT', () => {
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home: '/nonexistent-home', candidates: [] })).toBe('claude');
  });
});

describe('preflight read-confinement gates', () => {
  const tmp = tempDir;
  const emptyManaged = () => ({ dir: tmp('cc-managed-'), plists: [] });
  const versionExec = (stdout: string) => async (cmd: string) => (cmd === 'claude' ? { code: 0, stdout } : 0);
  const ok = { claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, platform: 'darwin' as const, approvedVersions: ['2.1.289'] };

  it('given an approved claude on macOS with no managed settings, passes', async () => {
    const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)\n'), managedSettings: emptyManaged() });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('given claude --version returns 2.1.290, warns that sessions are refused and names the approved list, but the app still starts', async () => {
    const r = await preflight({ ...ok, exec: versionExec('2.1.290 (Claude Code)\n'), managedSettings: emptyManaged() });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Claude Code 2.1.290 is not approved');
    expect(r.warnings[0]).toContain('approved: 2.1.289');
    expect(r.warnings[0]).toContain('npm run probe:reads');
    expect(r.warnings[0]).toMatch(/sessions are refused until/i);
  });

  it('given a claude whose version cannot be read, errors instead of assuming it is approved', async () => {
    const r = await preflight({ ...ok, exec: versionExec('Claude Code is updating...'), managedSettings: emptyManaged() });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('could not read the Claude Code version');
  });

  it('given platform linux, errors: the Control Center runs on macOS only', async () => {
    const r = await preflight({ ...ok, platform: 'linux', exec: versionExec('2.1.289 (Claude Code)'), managedSettings: emptyManaged() });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /macOS/.test(e) && /linux/.test(e))).toBe(true);
  });

  for (const [name, doc] of [
    ['allowManagedHooksOnly', { allowManagedHooksOnly: true }],
    ['allowManagedPermissionRulesOnly', { allowManagedPermissionRulesOnly: true }],
    ['disableAllHooks', { disableAllHooks: true }],
    ['permissions.allow', { permissions: { allow: ['Read(//**)'] } }],
    ['permissions.additionalDirectories', { permissions: { additionalDirectories: ['/'] } }],
  ] as const) {
    it(`given a managed-settings file that sets ${name}, errors and names the file and the key`, async () => {
      const dir = tmp('cc-managed-');
      fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify(doc));
      const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir, plists: [] } });
      expect(r.ok).toBe(false);
      expect(r.errors.join('\n')).toContain(path.join(dir, 'managed-settings.json'));
      expect(r.errors.join('\n')).toContain(name);
    });
  }

  it('given restrictive-only managed settings (deny rules, hooks allowed), passes', async () => {
    const dir = tmp('cc-managed-');
    fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: false, disableAllHooks: false, permissions: { deny: ['Read(~/.ssh/**)'], allow: [], additionalDirectories: [] } }));
    const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir, plists: [] } });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('checks every drop-in under managed-settings.d, skipping hidden and non-JSON files', async () => {
    const dir = tmp('cc-managed-');
    fs.mkdirSync(path.join(dir, 'managed-settings.d'));
    fs.writeFileSync(path.join(dir, 'managed-settings.d', '10-ok.json'), JSON.stringify({ permissions: { deny: ['Read(~/.aws/**)'] } }));
    fs.writeFileSync(path.join(dir, 'managed-settings.d', '.hidden.json'), JSON.stringify({ disableAllHooks: true }));
    fs.writeFileSync(path.join(dir, 'managed-settings.d', 'notes.txt'), 'disableAllHooks');
    expect((await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir, plists: [] } })).ok).toBe(true);
    fs.writeFileSync(path.join(dir, 'managed-settings.d', '20-hooks.json'), JSON.stringify({ disableAllHooks: true }));
    const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir, plists: [] } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('20-hooks.json');
  });

  it('given a managed-settings file it cannot parse, fails closed', async () => {
    const dir = tmp('cc-managed-');
    fs.writeFileSync(path.join(dir, 'managed-settings.json'), '{ not json');
    const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir, plists: [] } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/could not read managed settings/);
  });

  it('checks a managed preferences plist (MDM profile) through plutil', async () => {
    const dir = tmp('cc-managed-');
    const plist = path.join(dir, 'com.anthropic.claudecode.plist');
    fs.writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>allowManagedHooksOnly</key><true/></dict></plist>\n');
    const r = await preflight({ ...ok, exec: versionExec('2.1.289 (Claude Code)'), managedSettings: { dir: path.join(dir, 'absent'), plists: [plist, path.join(dir, 'missing.plist')] } });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain(plist);
    expect(r.errors.join('\n')).toContain('allowManagedHooksOnly');
  });
});
