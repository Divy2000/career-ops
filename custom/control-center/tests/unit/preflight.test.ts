import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflight, resolveClaudeBin, claudeCandidates, versionAtLeast, KEYCHAIN_HELP, NODE_FLOOR } from '../../supervisor/preflight.js';
import { tempDir } from '../helpers/tmp.js';

// Preflight also requires an approved `claude --version`: read confinement is probed per CLI version.
const execOk = async (cmd: string) => (cmd === 'claude' ? { code: 0, stdout: '2.1.289 (Claude Code)\n' } : 0);
const approvedVersions = ['2.1.289'];
const fakeVersion = { code: 0, stdout: '0.0.0-fake (Control Center test double)\n' };

describe('preflight', () => {
  it('compares versions numerically against the Node floor', () => {
    expect(versionAtLeast('v22.6.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v26.4.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v22.5.9', NODE_FLOOR)).toBe(false);
    expect(versionAtLeast('v9.99.0', NODE_FLOOR)).toBe(false);
  });

  it('passes with a runnable claude, a Keychain item and no API key', async () => {
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec: execOk, approvedVersions });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('fails loudly when the claude binary is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'claude' ? 127 : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('CC_CLAUDE_BIN');
  });

  it('prints the setup-token instructions when the Keychain item is missing', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(KEYCHAIN_HELP);
  });

  it('skips the Keychain check under NODE_ENV=test so the fake Claude runs anywhere', async () => {
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : cmd === 'claude' ? fakeVersion : 0);
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' }, exec });
    expect(r.ok).toBe(true);
  });

  it('fails below the Node floor and warns about ANTHROPIC_API_KEY', async () => {
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v20.0.0', env: { ANTHROPIC_API_KEY: 'x' }, exec: execOk });
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
const base = { nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' } };

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
    const bin = fakeClaude(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => {}, 10000);`);
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

  it('keeps an explicit path or a name with a slash as given', () => {
    expect(resolveClaudeBin('/opt/custom/claude', { env: { PATH: '' }, home: '/h' })).toBe('/opt/custom/claude');
    expect(resolveClaudeBin('./bin/claude', { env: { PATH: '' }, home: '/h' })).toBe('./bin/claude');
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
