#!/usr/bin/env node
// Fake Claude CLI for tests. Replays stream-json scenario files, honors
// --session-id / --resume, performs scripted writes, reads, fetches and Bash steps, sleeps or waits for files, and
// invokes the real guard hook from --settings with the real stdin JSON so the
// hook is exercised. A write or Bash step marked expectDenied is never performed:
// if the hook allows it, the fake reports it and exits 3. Scenario selection: FAKE_CLAUDE_SCENARIO (one file) or
// FAKE_CLAUDE_SCENARIO_DIR/<mode>.json (CC_MODE set by the session manager, with
// slashes replaced by dashes), falling back to default.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { globToRegExp, resolveReal } from '../../server/claude/guard-policy.mjs';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('0.0.0-fake (Control Center test double)');
  process.exit(0);
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

// Like the real CLI, --fork-session mints a new conversation id (reported in the init event).
const sessionId = argv.includes('--fork-session') ? crypto.randomUUID() : (flag('--session-id') ?? flag('--resume') ?? crypto.randomUUID());
const resumed = argv.includes('--resume');
const preamble = flag('--append-system-prompt') ?? '';
const reservedMatch = preamble.match(/Report number (\d+) is reserved/);
const reportNum = reservedMatch ? reservedMatch[1].padStart(3, '0') : '008';

function scenarioFile() {
  if (process.env.FAKE_CLAUDE_SCENARIO) return process.env.FAKE_CLAUDE_SCENARIO;
  const dir = process.env.FAKE_CLAUDE_SCENARIO_DIR;
  if (!dir) return null;
  const mode = (process.env.CC_MODE ?? 'default').replace(/\//g, '-');
  const candidate = path.join(dir, `${mode}.json`);
  return fs.existsSync(candidate) ? candidate : path.join(dir, 'default.json');
}

const scenarioPath = scenarioFile();
if (!scenarioPath) {
  console.error('fake claude: set FAKE_CLAUDE_SCENARIO or FAKE_CLAUDE_SCENARIO_DIR');
  process.exit(2);
}
const dataRoot = process.env.CAREER_OPS_ROOT ?? process.cwd();
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8').replaceAll('{{REPORT_NUM}}', reportNum).replaceAll('{{DATA_ROOT}}', dataRoot).replaceAll('{{HOME}}', os.homedir()));
const events = resumed && scenario.resume ? scenario.resume : scenario.events;

let settings = null;
const settingsArg = flag('--settings');
if (settingsArg) {
  settings = settingsArg.trim().startsWith('{') ? JSON.parse(settingsArg) : JSON.parse(fs.readFileSync(settingsArg, 'utf8'));
}

// Like the real CLI (2.1.288), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps credentials out of Bash and hook children.
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'];
const scrub = /^(1|true|yes|on)$/i.test(String(process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? '').trim());
const subprocessEnv = scrub ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !CREDENTIALS.includes(k))) : process.env;

// Opt-in instrumentation for env tests: the CC_ names this child received, and where the OAuth token reaches.
if (process.env.FAKE_CLAUDE_REPORT_ENV === '1') {
  console.error(`fake-claude-env: ${Object.keys(process.env).filter((k) => k.startsWith('CC_')).sort().join(',')}`);
  console.error(`fake-claude-token: self=${process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'present' : 'absent'} children=${subprocessEnv.CLAUDE_CODE_OAUTH_TOKEN ? 'present' : 'absent'}`);
}

const denials = [];

// The CLI's permission layer, as the probes recorded it (contract.json claude.probes): under --permission-mode dontAsk a
// call needs an allow rule (Edit(//abs/glob) covers Write; Bash(prefix:*); a bare WebFetch), reads inside the working
// directories need none and Read deny rules win. A built-in tool outside --tools or in --disallowedTools is never
// offered, so a scenario step that uses one is refused as well. Checked after the hook, like the real CLI.
const permissionMode = flag('--permission-mode');
const toolsFlag = flag('--tools');
const builtins = toolsFlag === undefined ? null : new Set(toolsFlag.split(',').filter(Boolean));
const disallowedTools = new Set((flag('--disallowedTools') ?? '').split(',').filter(Boolean));
const permissionRules = (kind) => (settings?.permissions?.[kind] ?? []).map((r) => /^([A-Za-z_]+)(?:\((.*)\))?$/.exec(String(r))).filter(Boolean).map((m) => ({ tool: m[1], content: m[2] }));
const workingDirs = [process.cwd(), ...(settings?.permissions?.additionalDirectories ?? [])].map((d) => resolveReal(d));
const dontAsk = (tool) => `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode.`;

function rulePathMatches(content, file) {
  const glob = content?.startsWith('//') ? content.slice(1) : content?.startsWith('~/') ? path.join(os.homedir(), content.slice(2)) : null;
  if (!glob) return false;
  const re = globToRegExp(glob);
  return [file, resolveReal(file)].some((f) => re.test(f));
}

function insideWorkingDir(file) {
  const real = resolveReal(file);
  return workingDirs.some((d) => {
    const rel = path.relative(d, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** Why the permission layer refuses this call, or null. */
function permissionDenial(tool, input) {
  if (permissionMode !== 'dontAsk') return null;
  if (disallowedTools.has(tool) || (builtins && !builtins.has(tool))) return `fake claude: ${tool} is not offered to this session (--tools / --disallowedTools)`;
  const allow = permissionRules('allow').filter((r) => r.tool === tool || (tool === 'Write' && r.tool === 'Edit'));
  if (tool === 'Read') {
    if (permissionRules('deny').some((r) => r.tool === 'Read' && rulePathMatches(r.content, input.file_path))) return dontAsk(tool);
    return insideWorkingDir(input.file_path) || allow.some((r) => rulePathMatches(r.content, input.file_path)) ? null : dontAsk(tool);
  }
  if (tool === 'Write') return allow.some((r) => rulePathMatches(r.content, input.file_path)) ? null : dontAsk(tool);
  if (tool === 'Bash') {
    const matched = allow.some((r) => r.content !== undefined && (r.content.endsWith(':*') ? input.command === r.content.slice(0, -2) || input.command.startsWith(`${r.content.slice(0, -2)} `) : input.command === r.content));
    return matched ? null : dontAsk(tool);
  }
  return allow.some((r) => r.content === undefined) ? null : dontAsk(tool);
}

/** Refuses the call the way the CLI reports a permission denial; true when it was refused. */
function refusedByPermissions(id, tool, input) {
  const why = permissionDenial(tool, input);
  if (!why) return false;
  denials.push({ tool_name: tool, tool_use_id: id, tool_input: input });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: why }] } });
  return true;
}
// Steps a scenario marks expectDenied (writes into the real checkout, a push) that the hook let through: never run.
const allowedButExpectedDenied = [];

/** A step the guard should have refused but did not: it is not run, and the fake exits non-zero at the end. */
function refuseUnexpectedlyAllowed(id, tool, input) {
  allowedButExpectedDenied.push(`${tool} ${JSON.stringify(input)}`);
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'fake claude: the guard allowed a step the scenario marks expectDenied; it was not run' }] } });
}

function runHook(kind, toolName, toolInput) {
  const hooks = settings?.hooks?.[kind] ?? [];
  for (const group of hooks) {
    if (group.matcher && !new RegExp(group.matcher).test(toolName)) continue;
    for (const h of group.hooks ?? []) {
      // Like the real CLI, command hooks run through a shell.
      const payload = JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: kind, tool_name: toolName, tool_input: toolInput });
      const r = spawnSync('/bin/sh', ['-c', String(h.command)], { input: payload, encoding: 'utf8', env: subprocessEnv });
      if (r.status === 2) return { blocked: true, reason: r.stderr.trim() };
    }
  }
  return { blocked: false };
}

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, session_id: sessionId }) + '\n');
const toolId = () => `toolu_${crypto.randomBytes(6).toString('hex')}`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

for (const ev of events) {
  if (ev.__write) {
    // Scripted write: goes through the PreToolUse hook exactly like the real CLI.
    const target = path.resolve(process.cwd(), ev.__write.path);
    const input = { file_path: target, content: ev.__write.content };
    const id = toolId();
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input }] } });
    const verdict = runHook('PreToolUse', 'Write', input);
    if (verdict.blocked) {
      denials.push({ tool_name: 'Write', tool_use_id: id, tool_input: input });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `PreToolUse:Write hook error: ${verdict.reason}` }] } });
      continue;
    }
    if (refusedByPermissions(id, 'Write', input)) continue;
    if (ev.expectDenied) {
      refuseUnexpectedlyAllowed(id, 'Write', input);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ev.__write.content);
    runHook('PostToolUse', 'Write', input);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `File written: ${target}` }] } });
    continue;
  }
  if (ev.__bash) {
    // Scripted Bash: hook first, then the real command (no shell) with the session env.
    const input = { command: ev.__bash };
    const id = toolId();
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
    const verdict = runHook('PreToolUse', 'Bash', input);
    if (verdict.blocked) {
      denials.push({ tool_name: 'Bash', tool_use_id: id, tool_input: input });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `PreToolUse:Bash hook error: ${verdict.reason}` }] } });
      continue;
    }
    if (refusedByPermissions(id, 'Bash', input)) continue;
    if (ev.expectDenied) {
      refuseUnexpectedlyAllowed(id, 'Bash', input);
      continue;
    }
    const [cmd, ...args] = ev.__bash.split(' ');
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { encoding: 'utf8', env: subprocessEnv, cwd: process.cwd() });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: r.status !== 0, content: `exit ${r.status}\n${out}` }] } });
    continue;
  }
  if (ev.__read) {
    // Scripted Read: the PreToolUse hook decides, then the file is read like the real tool would.
    const input = { file_path: path.isAbsolute(ev.__read) ? ev.__read : path.resolve(process.cwd(), ev.__read) };
    const id = toolId();
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input }] } });
    const verdict = runHook('PreToolUse', 'Read', input);
    if (verdict.blocked) {
      denials.push({ tool_name: 'Read', tool_use_id: id, tool_input: input });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `PreToolUse:Read hook error: ${verdict.reason}` }] } });
      continue;
    }
    if (refusedByPermissions(id, 'Read', input)) continue;
    let content;
    let isError = false;
    try {
      content = fs.readFileSync(input.file_path).toString('utf8').slice(0, 1500);
    } catch (err) {
      content = `<tool_use_error>${err.message}</tool_use_error>`;
      isError = true;
    }
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });
    continue;
  }
  if (ev.__fetch) {
    // Scripted WebFetch: only the hook's verdict is real; nothing is ever fetched.
    const input = { url: ev.__fetch, prompt: 'Return the page text' };
    const id = toolId();
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'WebFetch', input }] } });
    const verdict = runHook('PreToolUse', 'WebFetch', input);
    if (verdict.blocked) {
      denials.push({ tool_name: 'WebFetch', tool_use_id: id, tool_input: input });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `PreToolUse:WebFetch hook error: ${verdict.reason}` }] } });
      continue;
    }
    if (refusedByPermissions(id, 'WebFetch', input)) continue;
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '(fake) page text' }] } });
    continue;
  }
  if (ev.__sleep) {
    sleep(ev.__sleep);
    continue;
  }
  if (ev.__ignoreSigterm) {
    // A CLI slow to stop: a cancel's SIGTERM does nothing, so the run ends only at the runner's SIGKILL.
    process.on('SIGTERM', () => {});
    continue;
  }
  if (ev.__waitFor) {
    // Holds the run until another run has written its files: { dir, pattern, count, timeoutMs }. Gives up with exit 4,
    // so a test that orders two runs fails instead of checking nothing.
    const { dir, pattern, count = 1, timeoutMs = 20_000 } = ev.__waitFor;
    const re = new RegExp(pattern);
    const deadline = Date.now() + timeoutMs;
    const seen = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => re.test(n)).length : 0);
    while (seen() < count) {
      if (Date.now() > deadline) {
        console.error(`fake claude: waited ${timeoutMs} ms for ${count} file(s) matching ${pattern} in ${dir}`);
        process.exit(4);
      }
      sleep(50);
    }
    continue;
  }
  if (ev.type === 'result') {
    emit({ ...ev, permission_denials: [...denials, ...(ev.permission_denials ?? [])] });
    continue;
  }
  emit(ev);
}
if (allowedButExpectedDenied.length) {
  console.error(`fake claude: the guard allowed ${allowedButExpectedDenied.length} step(s) marked expectDenied; none was run: ${allowedButExpectedDenied.join('; ')}`);
  process.exit(3);
}
process.exit(scenario.exitCode ?? 0);
