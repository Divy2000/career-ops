#!/usr/bin/env node
// P0 probes against the installed Claude CLI (two real calls, haiku, tiny).
// Runs inside a throwaway temp dir, reads the OAuth token from the Keychain
// the same way custom/immigration/run-daily.sh does, and never prints it.
// Writes a redacted JSON summary to stdout for contract.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const claudeBin = process.env.CC_CLAUDE_BIN ?? 'claude';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-'));
const token = spawnSync('security', ['find-generic-password', '-s', 'career-ops-claude-token', '-w'], { encoding: 'utf8' });
if (token.status !== 0) {
  console.error('Keychain item career-ops-claude-token not found');
  process.exit(1);
}
const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token.stdout.trim(), ANTHROPIC_API_KEY: '' };
const redact = (s) => String(s).split(env.CLAUDE_CODE_OAUTH_TOKEN).join('<redacted>');

const hookLog = path.join(dir, 'hook-log.ndjson');
const hookScript = path.join(dir, 'hook.mjs');
fs.writeFileSync(
  hookScript,
  `import fs from 'node:fs';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(hookLog)}, raw.replace(/\\n/g, ' ') + '\\n');
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const fp = String(input?.tool_input?.file_path ?? '');
  if (fp.endsWith('hookblock.txt')) { process.stderr.write('blocked by probe hook'); process.exit(2); }
  process.exit(0);
});
`,
);
const settings = JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node ${hookScript}` }] }] },
});

const sessionId = crypto.randomUUID();
const allowed = path.join(dir, 'allowed.txt');
const hookblock = path.join(dir, 'hookblock.txt');
const denied = path.join(dir, 'denied.txt');
const prompt = [
  'This is an automated probe. Use only the Write tool, never Bash, and do each step even if an earlier one failed:',
  `1. Write the file ${allowed} with content ok`,
  `2. Write the file ${hookblock} with content x`,
  `3. Write the file ${denied} with content no`,
  'Then reply with the single word done.',
].join('\n');

function run(args) {
  const r = spawnSync(claudeBin, args, { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l.slice(0, 200) }; }
  });
  return { status: r.status, stderr: redact(r.stderr).slice(-1500), events: lines };
}

const a = run([
  '-p', prompt,
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--session-id', sessionId,
  '--permission-mode', 'dontAsk',
  '--append-system-prompt', 'Probe preamble: headless control-center probe. Follow the user message literally.',
  '--allowedTools', `Edit(/${allowed})`, `Edit(/${hookblock})`,
  '--disallowedTools', 'Bash', 'Task', 'WebFetch', 'WebSearch',
  '--settings', settings,
  '--strict-mcp-config',
  '--max-turns', '8',
  '--model', 'haiku',
]);

const types = (evs) => [...new Set(evs.map((e) => (e.type === 'stream_event' ? `stream_event:${e.event?.type}` : e.type)))];
const init = a.events.find((e) => e.type === 'system' && e.subtype === 'init');
const result = a.events.find((e) => e.type === 'result');
const toolUses = a.events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
const toolResults = a.events.filter((e) => e.type === 'user').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_result'));
const hookLines = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

const b = run(['-p', 'Reply with the single word: resumed', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--model', 'haiku']);
const bInit = b.events.find((e) => e.type === 'system' && e.subtype === 'init');
const bResult = b.events.find((e) => e.type === 'result');

const summary = {
  probedAt: new Date().toISOString(),
  claudeVersion: spawnSync(claudeBin, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  probeA: {
    exitStatus: a.status,
    eventTypes: types(a.events),
    initKeys: init ? Object.keys(init).sort() : null,
    initSessionIdMatches: init?.session_id === sessionId,
    initToolsSample: init?.tools?.slice(0, 40) ?? null,
    initModel: init?.model ?? null,
    resultKeys: result ? Object.keys(result).sort() : null,
    permissionDenials: result?.permission_denials ?? null,
    usageKeys: result?.usage ? Object.keys(result.usage).sort() : null,
    toolUseNames: toolUses.map((t) => `${t.name}:${path.basename(String(t.input?.file_path ?? ''))}`),
    toolResultErrors: toolResults.map((t) => ({ is_error: t.is_error ?? false, text: String(typeof t.content === 'string' ? t.content : JSON.stringify(t.content)).slice(0, 160) })),
    files: { allowedWritten: fs.existsSync(allowed), hookblockWritten: fs.existsSync(hookblock), deniedWritten: fs.existsSync(denied) },
    hookStdinKeys: hookLines[0] ? Object.keys(hookLines[0]).sort() : null,
    hookToolInputKeys: hookLines[0]?.tool_input ? Object.keys(hookLines[0].tool_input).sort() : null,
    hookInvocations: hookLines.map((h) => `${h.tool_name}:${path.basename(String(h.tool_input?.file_path ?? ''))}`),
    stderrTail: a.stderr,
    costUsd: result?.total_cost_usd ?? null,
  },
  probeB: {
    exitStatus: b.status,
    resumedSameSession: bInit?.session_id === sessionId && bResult?.session_id === sessionId,
    resultText: String(bResult?.result ?? '').slice(0, 80),
    numTurns: bResult?.num_turns ?? null,
    costUsd: bResult?.total_cost_usd ?? null,
    stderrTail: b.stderr,
  },
};
fs.writeFileSync(path.join(dir, 'probe-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.error(`probe dir: ${dir}`);
