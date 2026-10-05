import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approvedClaudeVersions, assertApprovedClaude, FAKE_CLAUDE_VERSION, parseClaudeVersion } from '../../server/claude/cli-version.js';
import { CONTRACT } from '../../server/core/adapter.js';
import { tempDir } from '../helpers/tmp.js';

/** A real executable standing in for claude; every run appends to `runs` so a test can count the `--version` calls. */
function fakeClaude(version: string, opts: { exit?: number } = {}): { bin: string; runs: () => number } {
  const dir = tempDir('cc-cliver-');
  const bin = path.join(dir, 'claude');
  const marker = path.join(dir, 'runs');
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log(${JSON.stringify(`${version} (Claude Code)`)});\nprocess.exit(${opts.exit ?? 0});\n`, { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0) };
}

describe('Claude CLI version gate', () => {
  it('reads the version from `claude --version` output, with or without a prerelease tag', () => {
    expect(parseClaudeVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289');
    expect(parseClaudeVersion('0.0.0-fake (Control Center test double)')).toBe('0.0.0-fake');
    expect(parseClaudeVersion('Claude Code is updating...')).toBeNull();
    expect(parseClaudeVersion('')).toBeNull();
  });

  it('approves exactly the contract list, plus the test double only under NODE_ENV=test', () => {
    expect(approvedClaudeVersions('production')).toEqual(CONTRACT.claude.approvedVersions);
    expect(approvedClaudeVersions('development')).not.toContain(FAKE_CLAUDE_VERSION);
    expect(approvedClaudeVersions('test')).toEqual([...CONTRACT.claude.approvedVersions, FAKE_CLAUDE_VERSION]);
  });

  it('given an unapproved version, refuses and names the approved list and how to approve one', async () => {
    const { bin } = fakeClaude('2.1.290');
    const err = await assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Claude Code 2.1.290 is not approved');
    expect((err as Error).message).toContain('2.1.289');
    expect((err as Error).message).toContain('npm run probe:reads');
    expect((err as Error).message).toContain('claude install 2.1.289');
  });

  it('given an approved version, resolves to it', async () => {
    const { bin } = fakeClaude('2.1.289');
    await expect(assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] })).resolves.toBe('2.1.289');
  });

  it('given a binary whose version cannot be read, refuses instead of assuming', async () => {
    await expect(assertApprovedClaude(fakeClaude('2.1.289', { exit: 3 }).bin, 'production', { approved: ['2.1.289'] })).rejects.toThrow(/could not read the Claude Code version/);
    await expect(assertApprovedClaude(fakeClaude('garbage').bin, 'production', { approved: ['garbage'] })).rejects.toThrow(/could not read the Claude Code version/);
    await expect(assertApprovedClaude(path.join(os.tmpdir(), 'cc-no-such-claude'), 'production', { approved: ['2.1.289'] })).rejects.toThrow(/could not read the Claude Code version/);
  });

  it('caches a path through a symlinked folder and .. under the file the kernel opens, so updating that file is noticed', async () => {
    const dir = tempDir('cc-cliver-link-');
    fs.mkdirSync(path.join(dir, 'real', 'bin'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real', 'bin'), path.join(dir, 'link'));
    // sh, not node: node resolves its script path on paper too, so a node fake would run the wrong file.
    const write = (file: string, version: string, pad = '') => fs.writeFileSync(file, `#!/bin/sh\necho '${version} (Claude Code)'${pad}\n`, { mode: 0o755 });
    write(path.join(dir, 'real', 'claude'), '2.1.289');
    // The file the path names on paper (path.resolve collapses link/..); it never changes.
    write(path.join(dir, 'claude'), '2.1.289');
    const bin = `${dir}/link/../claude`;
    await expect(assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] })).resolves.toBe('2.1.289');
    write(path.join(dir, 'real', 'claude'), '2.1.290', ' # updated');
    await expect(assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] })).rejects.toThrow(/Claude Code 2\.1\.290 is not approved/);
  });

  it('given a stat-cached approved binary, skips `--version` until its mtime changes, then runs it again', async () => {
    const { bin, runs } = fakeClaude('2.1.289');
    await assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] });
    await assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] });
    expect(runs()).toBe(1);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(bin, later, later);
    await assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] });
    expect(runs()).toBe(2);
  });

  it('a cached version is still checked against the current approved list', async () => {
    const { bin, runs } = fakeClaude('2.1.289');
    await assertApprovedClaude(bin, 'production', { approved: ['2.1.289'] });
    await expect(assertApprovedClaude(bin, 'production', { approved: ['2.1.291'] })).rejects.toThrow(/2\.1\.289 is not approved/);
    expect(runs()).toBe(1);
  });
});
