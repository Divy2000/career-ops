import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflight, resolveClaudeBin, claudeCandidates, versionAtLeast, KEYCHAIN_HELP, NODE_FLOOR } from '../../supervisor/preflight.js';

const execOk = async () => 0;

describe('preflight', () => {
  it('compares versions numerically against the Node floor', () => {
    expect(versionAtLeast('v22.6.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v26.4.0', NODE_FLOOR)).toBe(true);
    expect(versionAtLeast('v22.5.9', NODE_FLOOR)).toBe(false);
    expect(versionAtLeast('v9.99.0', NODE_FLOOR)).toBe(false);
  });

  it('passes with a runnable claude, a Keychain item and no API key', async () => {
    const r = await preflight({ claudeBin: 'claude', nodeVersion: 'v26.0.0', env: {}, exec: execOk });
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
    const exec = async (cmd: string) => (cmd === 'security' ? 44 : 0);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preflight-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}
const base = { nodeVersion: 'v26.0.0', env: { NODE_ENV: 'test' } };

describe('preflight claude probe', () => {
  it('warns when more than one claude binary is installed, naming the one in use', async () => {
    const r = await preflight({ ...base, claudeBin: '/a/claude', claudeCandidates: ['/a/claude', '/b/claude'], exec: async () => 0 });
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
    const bin = fakeClaude("setTimeout(() => { console.log('2.0.0 (Claude Code)'); }, 1200);");
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 5000 });
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('reports a timeout as a timeout, after retrying once', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preflight-')), 'runs');
    const bin = fakeClaude(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => {}, 10000);`);
    const r = await preflight({ ...base, claudeBin: bin, claudeTimeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not runnable at ".*claude"/);
    expect(r.errors[0]).toMatch(/timed out after 1\.5s/);
    expect(r.errors[0]).toContain('CC_CLAUDE_BIN');
    expect(fs.readFileSync(marker, 'utf8')).toBe('xx');
  });

  it('passes when the first attempt fails and the retry succeeds', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preflight-')), 'seen');
    const bin = fakeClaude(`const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.error('updating'); process.exit(3); } console.log('2.0.0');`);
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-path-'));
    const bin = touch(path.join(dir, 'bin'));
    expect(resolveClaudeBin('claude', { env: { PATH: `/nonexistent:${path.dirname(bin)}` }, home: '/h' })).toBe(bin);
  });

  it('falls back to the usual install locations when PATH has no claude', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const local = touch(path.join(home, '.local', 'bin'));
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home, candidates: ['/nonexistent/a/claude'] })).toBe(local);
  });

  it('prefers the native installer location over Homebrew and /usr/local when PATH has no claude', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const local = touch(path.join(home, '.local', 'bin'));
    const brew = touch(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-brew-')));
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home, candidates: [brew] })).toBe(local);
  });

  it('lists every distinct claude it can find, in the order it would pick them', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const local = touch(path.join(home, '.local', 'bin'));
    const brew = touch(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-brew-')));
    const onPath = touch(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-path-')));
    expect(claudeCandidates('claude', { env: { PATH: path.dirname(onPath) }, home, candidates: [brew, local] })).toEqual([onPath, local, brew]);
  });

  it('counts a symlink to the same binary once and keeps the first path listed for it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const local = touch(path.join(home, '.local', 'bin'));
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-link-'));
    const link = path.join(linkDir, 'claude');
    fs.symlinkSync(local, link);
    expect(claudeCandidates('claude', { env: { PATH: '/nonexistent' }, home, candidates: [link] })).toEqual([local]);
    expect(claudeCandidates('claude', { env: { PATH: linkDir }, home, candidates: [] })).toEqual([link]);
  });

  it('returns the bare name when nothing is found so the probe can report ENOENT', () => {
    expect(resolveClaudeBin('claude', { env: { PATH: '/nonexistent' }, home: '/nonexistent-home', candidates: [] })).toBe('claude');
  });
});
