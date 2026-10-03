#!/usr/bin/env node
// Fake Claude CLI for tests. Replays stream-json scenario files, honors
// --session-id / --resume, performs scripted file writes and invokes the real
// guard hook from --settings with the real stdin JSON so the hook is exercised.
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
const scenarioPath = process.env.CC_FAKE_SCENARIO;
if (!scenarioPath) {
  console.error('fake claude: CC_FAKE_SCENARIO is not set');
  process.exit(2);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const events = argv.includes('--resume') && scenario.resume ? scenario.resume : scenario.events;

let settings = null;
const settingsArg = flag('--settings');
if (settingsArg) {
  settings = settingsArg.trim().startsWith('{') ? JSON.parse(settingsArg) : JSON.parse(fs.readFileSync(settingsArg, 'utf8'));
}

function runHook(kind, toolName, toolInput) {
  const hooks = settings?.hooks?.[kind] ?? [];
  for (const group of hooks) {
    if (group.matcher && !new RegExp(group.matcher).test(toolName)) continue;
    for (const h of group.hooks ?? []) {
      const [cmd, ...args] = String(h.command).split(' ');
      const payload = JSON.stringify({
        session_id: sessionId,
        cwd: process.cwd(),
        hook_event_name: kind,
        tool_name: toolName,
        tool_input: toolInput,
      });
      const r = spawnSync(cmd, args, { input: payload, encoding: 'utf8', env: process.env });
      if (r.status === 2) return { blocked: true, reason: r.stderr.trim() };
    }
  }
  return { blocked: false };
}

const emit = (obj) => process.stdout.write(JSON.stringify({ ...obj, session_id: sessionId }) + '\n');

for (const ev of events) {
  if (ev.__write) {
    // Scripted write: goes through the PreToolUse hook exactly like the real CLI.
    const target = path.resolve(process.cwd(), ev.__write.path);
    const input = { file_path: target, content: ev.__write.content };
    const id = `toolu_${crypto.randomBytes(6).toString('hex')}`;
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input }] } });
    const verdict = runHook('PreToolUse', 'Write', input);
    if (verdict.blocked) {
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `Blocked by hook: ${verdict.reason}` }] } });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ev.__write.content);
    runHook('PostToolUse', 'Write', input);
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `File written: ${target}` }] } });
    continue;
  }
  if (ev.__sleep) {
    const until = Date.now() + ev.__sleep;
    while (Date.now() < until) { /* busy wait keeps ordering deterministic */ }
    continue;
  }
  emit(ev);
}
process.exit(scenario.exitCode ?? 0);
