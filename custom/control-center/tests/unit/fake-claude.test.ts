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

/** Runs the fake CLI the way the session manager does: dontAsk, --tools, --disallowedTools and settings permissions. */
function runConfined(steps: unknown[], opts: { tools: string; disallowed?: string; allow: string[]; deny?: string[]; cwd?: string }) {
  const dir = opts.cwd ?? fs.realpathSync(tempDir('cc-fake-perm-'));
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ events: [{ type: 'system', subtype: 'init', model: 'fake-model', tools: opts.tools.split(',') }, ...steps, { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0, usage: {}, num_turns: 1, is_error: false }] }));
  const settings = path.join(dir, 'settings.json');
  // The hook allows everything here, so every refusal below comes from the permission layer.
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: opts.allow, deny: opts.deny ?? [] }, hooks: { PreToolUse: [{ matcher: 'Write|Bash|Read|WebFetch', hooks: [{ type: 'command', command: 'exit 0' }] }] } }));
  const args = [FAKE_CLAUDE, '-p', '--permission-mode', 'dontAsk', '--tools', opts.tools, ...(opts.disallowed ? ['--disallowedTools', opts.disallowed] : []), '--settings', settings, '--', 'go'];
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, CAREER_OPS_ROOT: dir } });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; permission_denials?: Array<{ tool_name: string; tool_input: Record<string, string> }>; message?: { content: Array<{ type: string; is_error?: boolean; content?: string }> } });
  const result = lines.find((l) => l.type === 'result')!;
  const errors = lines.flatMap((l) => (l.type === 'user' ? l.message!.content : [])).filter((c) => c.is_error).map((c) => c.content);
  return { dir, status: r.status, denials: result.permission_denials!.map((d) => [d.tool_name, d.tool_input.file_path ?? d.tool_input.command ?? d.tool_input.url]), errors };
}

describe('the fake Claude CLI applies the permission layer like the real one in dontAsk mode (SW-tests-11)', () => {
  it('a write needs an Edit rule for its path: one outside every rule is denied and not written', () => {
    const r = runConfined([{ __write: { path: 'output/a.txt', content: 'x' } }, { __write: { path: 'cv.md', content: 'x' } }], { tools: 'Read,Write', allow: [] });
    expect(r.denials).toEqual([['Write', path.join(r.dir, 'output', 'a.txt')], ['Write', path.join(r.dir, 'cv.md')]]);
    expect(fs.existsSync(path.join(r.dir, 'cv.md'))).toBe(false);
  });

  it('Edit(//abs/glob) rules cover Write, and the denial reads like the real dontAsk refusal', () => {
    const dir = fs.realpathSync(tempDir('cc-fake-rule-'));
    const r = runConfined([{ __write: { path: `${dir}/output/a.txt`, content: 'x' } }, { __write: { path: `${dir}/cv.md`, content: 'x' } }], { tools: 'Read,Write', allow: [`Edit(/${dir}/output/**)`] });
    expect(r.denials).toEqual([['Write', `${dir}/cv.md`]]);
    expect(fs.readFileSync(path.join(dir, 'output', 'a.txt'), 'utf8')).toBe('x');
    expect(fs.existsSync(path.join(dir, 'cv.md'))).toBe(false);
    expect(r.errors).toEqual([expect.stringMatching(/^Permission to use Write has been denied because Claude Code is running in don't ask mode/)]);
  });

  it('Bash needs a Bash(prefix:*) rule and Bash in --tools; a disallowed or unlisted tool is never available', () => {
    const steps = [{ __bash: 'node -e 0' }, { __bash: 'node -p 1' }];
    expect(runConfined(steps, { tools: 'Read,Bash', allow: ['Bash(node -e:*)'] }).denials).toEqual([['Bash', 'node -p 1']]);
    expect(runConfined(steps, { tools: 'Read', allow: ['Bash(node -e:*)', 'Bash(node -p:*)'] }).denials.map((d) => d[0])).toEqual(['Bash', 'Bash']);
    expect(runConfined(steps, { tools: 'Read,Bash', disallowed: 'Bash', allow: ['Bash(node -e:*)', 'Bash(node -p:*)'] }).denials.map((d) => d[0])).toEqual(['Bash', 'Bash']);
  });

  it('reads inside the working directory need no rule, Read deny rules win, and WebFetch needs its allow entry', () => {
    const dir = fs.realpathSync(tempDir('cc-fake-read-'));
    fs.writeFileSync(path.join(dir, 'note.md'), 'n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const outside = fs.realpathSync(tempDir('cc-fake-outside-'));
    fs.writeFileSync(path.join(outside, 'other.md'), 'o');
    const r = runConfined([{ __read: `${dir}/note.md` }, { __read: `${dir}/.env` }, { __read: `${outside}/other.md` }, { __fetch: 'https://93.184.215.14/' }], { tools: 'Read,WebFetch', allow: [], deny: [`Read(/${dir}/**/.env)`], cwd: dir });
    expect(r.denials).toEqual([['Read', `${dir}/.env`], ['Read', `${outside}/other.md`], ['WebFetch', 'https://93.184.215.14/']]);
    expect(runConfined([{ __fetch: 'https://93.184.215.14/' }], { tools: 'Read,WebFetch', allow: ['WebFetch'] }).denials).toEqual([]);
  });
});
