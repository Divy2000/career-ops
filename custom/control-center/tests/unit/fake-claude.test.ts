import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FAKE_CLAUDE } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

/** Runs the fake CLI on one scenario with a hook that allows (exit 0) or blocks (exit 2) every tool call. */
function runFake(steps: unknown[], hookExit: 0 | 2) {
  const dir = fs.realpathSync(tempDir('cc-fake-'));
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: ['Write', 'Bash'] }, ...steps, { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0, usage: {}, num_turns: 1, is_error: false }] }));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Bash', hooks: [{ type: 'command', command: `exit ${hookExit}` }] }] } }));
  const r = spawnSync(process.execPath, [FAKE_CLAUDE, '-p', '--settings', settings, '--', 'go'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, CAREER_OPS_ROOT: dir } });
  return { dir, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the fake Claude CLI never runs a step its scenario expects the guard to deny (SW-tests-05)', () => {
  it('a guard that lets such a write or command through gets neither run, and the fake exits non-zero', () => {
    const r = runFake([{ __write: { path: 'precious.txt', content: 'overwritten' }, expectDenied: true }, { __bash: 'node -e require("fs").writeFileSync("ran.txt","x")', expectDenied: true }], 0);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/expectDenied/);
    expect(fs.existsSync(path.join(r.dir, 'precious.txt'))).toBe(false);
    expect(fs.existsSync(path.join(r.dir, 'ran.txt'))).toBe(false);
  });

  it('when the guard denies them, the scenario runs on and exits as written', () => {
    const r = runFake([{ __write: { path: 'precious.txt', content: 'overwritten' }, expectDenied: true }], 2);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(r.dir, 'precious.txt'))).toBe(false);
  });

  it('steps without the mark still run when the guard allows them', () => {
    const r = runFake([{ __write: { path: 'note.txt', content: 'written' } }], 0);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(r.dir, 'note.txt'), 'utf8')).toBe('written');
  });
});
