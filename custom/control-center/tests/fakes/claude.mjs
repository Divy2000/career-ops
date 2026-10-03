#!/usr/bin/env node
// Fake Claude CLI for tests. Replays stream-json scenario files, honors
// --session-id / --resume, performs scripted file writes and Bash steps and
// invokes the real guard hook from --settings with the real stdin JSON so the
// hook is exercised. Scenario selection: FAKE_CLAUDE_SCENARIO (one file) or
// FAKE_CLAUDE_SCENARIO_DIR/<mode>.json (CC_MODE set by the session manager, with
// slashes replaced by dashes), falling back to default.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('0.0.0-fake (Control Center test double)');
  process.exit(0);
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const sessionId = flag('--session-id') ?? flag('--resume') ?? crypto.randomUUID();
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
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8').replaceAll('{{REPORT_NUM}}', reportNum).replaceAll('{{DATA_ROOT}}', dataRoot));
const events = resumed && scenario.resume ? scenario.resume : scenario.events;

let settings = null;
const settingsArg = flag('--settings');
if (settingsArg) {
  settings = settingsArg.trim().startsWith('{') ? JSON.parse(settingsArg) : JSON.parse(fs.readFileSync(settingsArg, 'utf8'));
}

// Opt-in instrumentation for env tests: the CC_ names this child received, as one stderr line.
if (process.env.FAKE_CLAUDE_REPORT_ENV === '1') {
  console.error(`fake-claude-env: ${Object.keys(process.env).filter((k) => k.startsWith('CC_')).sort().join(',')}`);
}

const denials = [];

function runHook(kind, toolName, toolInput) {
  const hooks = settings?.hooks?.[kind] ?? [];
  for (const group of hooks) {
    if (group.matcher && !new RegExp(group.matcher).test(toolName)) continue;
    for (const h of group.hooks ?? []) {
      // Like the real CLI, command hooks run through a shell.
      const payload = JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: kind, tool_name: toolName, tool_input: toolInput });
      const r = spawnSync('/bin/sh', ['-c', String(h.command)], { input: payload, encoding: 'utf8', env: process.env });
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
    const [cmd, ...args] = ev.__bash.split(' ');
    const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, { encoding: 'utf8', env: process.env, cwd: process.cwd() });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: r.status !== 0, content: `exit ${r.status}\n${out}` }] } });
    continue;
  }
  if (ev.__sleep) {
    sleep(ev.__sleep);
    continue;
  }
  if (ev.type === 'result') {
    emit({ ...ev, permission_denials: [...denials, ...(ev.permission_denials ?? [])] });
    continue;
  }
  emit(ev);
}
process.exit(scenario.exitCode ?? 0);
