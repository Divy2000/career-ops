import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPreflightCli } from '../../supervisor/preflight-cli.js';
import { PACKAGE_ROOT } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

function fakeClaude(body: string): string {
  const dir = tempDir('cc-pfcli-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

describe('runPreflightCli', () => {
  it('exits 1 and prints the error when CC_CLAUDE_BIN does not exist', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: '/nonexistent/claude', NODE_ENV: 'test' }, nodeVersion: 'v26.0.0' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('error: Claude CLI not runnable at "/nonexistent/claude"');
    expect(r.output).toContain('not found (ENOENT)');
  });

  it('exits 0 and says so when everything passes', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test' }, nodeVersion: 'v26.0.0' });
    expect(r.code).toBe(0);
    expect(r.output).toContain('preflight ok');
  });

  it('exits 1 below the Node floor', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test' }, nodeVersion: 'v20.0.0' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('below the floor');
  });

  it('keeps warnings in the output but exits 0', async () => {
    const r = await runPreflightCli({ env: { CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');"), NODE_ENV: 'test', ANTHROPIC_API_KEY: 'x' }, nodeVersion: 'v26.0.0' });
    expect(r.code).toBe(0);
    expect(r.output).toContain('warning: ANTHROPIC_API_KEY');
    expect(r.output).toContain('preflight ok');
  });
});

describe('npm run preflight entry point', () => {
  const tsx = path.join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx');
  // tsx keeps its IPC dir (tsx-<uid>) in the temp dir; give it one that is removed with the file.
  const tmp = tempDir('cc-pfcli-tsx-');
  const run = (env: Record<string, string>) =>
    spawnSync(tsx, [path.join(PACKAGE_ROOT, 'supervisor', 'preflight-cli.ts')], {
      env: { ...process.env, NODE_ENV: 'test', TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  it('really exits non-zero for CC_CLAUDE_BIN=/nonexistent', () => {
    const r = run({ CC_CLAUDE_BIN: '/nonexistent' });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('Claude CLI not runnable');
  });

  it('really exits 0 with a runnable claude', () => {
    const r = run({ CC_CLAUDE_BIN: fakeClaude("console.log('0.0.0-fake');") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('preflight ok');
  });

  it('is wired as the preflight npm script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.preflight).toBe('tsx supervisor/preflight-cli.ts');
  });
});
