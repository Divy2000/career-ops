#!/usr/bin/env node
// P0 probes against the installed Claude CLI (two real calls, haiku, tiny).
// Runs inside a throwaway temp dir, reads the OAuth token from the Keychain
// the same way custom/immigration/run-daily.sh does, and never prints it.
// Writes a redacted JSON summary to stdout for contract.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { childEnv } from '../server/system/child-env.ts';
import { claudeBinFromEnv, probeInherited, readKeychainToken } from './probe-cli.mjs';
import { runGroup, stopGroups } from './probe-proc.mjs';

const claudeBin = claudeBinFromEnv();
const token = readKeychainToken();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-'));
// Same as claude-probe-reads.mjs: the environment the app gives a Claude session (server/system/child-env.ts), minus
// every CLAUDE* nested-session variable, never auto-updating past the approved version. The Keychain token is the only
// Claude or Anthropic credential the CLI gets; other variables the shell exports pass, as they do to the app's sessions.
const INHERITED = probeInherited();
const BASE_ENV = childEnv({ DISABLE_AUTOUPDATER: '1' }, INHERITED);
const env = childEnv({ DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: '' }, INHERITED);
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

// Each CLI run leads its own process group, so no signal from the terminal reaches it: a signal stops every running
// group before the probe exits with that signal's code, and no run starts after it.
const running = new Set();
let stopping = false;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    stopping = true;
    void stopGroups(running).then(() => process.exit(code));
  });
}

/** Every CLI run starts here. Once a signal is stopping the probe it never starts: the exit is under way. */
async function start(args, opts) {
  if (stopping) await new Promise(() => {});
  return runGroup(claudeBin, args, { ...opts, track: running });
}

async function run(args) {
  const r = await start(args, { cwd: dir, env, timeoutMs: 180_000 });
  // A spawn failure (ENOENT) leaves no stdout or stderr, only r.error; a timeout keeps both and sets r.error too.
  const lines = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l.slice(0, 200) }; }
  });
  return { status: r.status, stderr: redact(`${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`).slice(-1500), events: lines };
}

const a = await run([
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
  '--effort', 'medium',
]);

const versionOf = (r) => (r.error ? `unavailable: ${r.error.message}` : (r.stdout ?? '').trim());
const types = (evs) => [...new Set(evs.map((e) => (e.type === 'stream_event' ? `stream_event:${e.event?.type}` : e.type)))];
const init = a.events.find((e) => e.type === 'system' && e.subtype === 'init');
const result = a.events.find((e) => e.type === 'result');
const toolUses = a.events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
const toolResults = a.events.filter((e) => e.type === 'user').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_result'));
const hookLines = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

const b = await run(['-p', 'Reply with the single word: resumed', '--resume', sessionId, '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'medium']);
const bInit = b.events.find((e) => e.type === 'system' && e.subtype === 'init');
const bResult = b.events.find((e) => e.type === 'result');

const summary = {
  probedAt: new Date().toISOString(),
  claudeVersion: versionOf(await start(['--version'], { env: BASE_ENV, timeoutMs: 30_000 })),
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
