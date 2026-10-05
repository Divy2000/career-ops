// A stand-in for claude in the run-daily.sh specs (the world prepends a shebang for this node). It records the argv,
// the settings and guard policy it was given, and runs the settings' PreToolUse hook commands for the tool calls in
// FAKE_HOOK_PROBES the way Claude Code does (the command through a shell, the hook JSON on stdin), recording each exit.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  fs.appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify({ versionCall: true, disableAutoupdater: process.env.DISABLE_AUTOUPDATER ?? null })}\n`);
  // FAKE_CLAUDE_VERSIONS (a JSON list) answers successive --version calls in turn, the last one from then on.
  let version = process.env.FAKE_CLAUDE_VERSION;
  if (process.env.FAKE_CLAUDE_VERSIONS) {
    const list = JSON.parse(process.env.FAKE_CLAUDE_VERSIONS);
    const counter = `${process.env.FAKE_CLAUDE_RECORD}.versions`;
    const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(n + 1));
    version = list[Math.min(n, list.length - 1)];
  }
  if (!version) process.exit(1);
  console.log(version);
  process.exit(0);
}
const at = argv.indexOf('--settings');
const settings = at === -1 ? null : JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'));
const policyFile = process.env.CC_POLICY_FILE;
const policyBytes = policyFile && fs.existsSync(policyFile) ? fs.readFileSync(policyFile) : null;
const probes = process.env.FAKE_HOOK_PROBES ? JSON.parse(process.env.FAKE_HOOK_PROBES) : [];
const hookRuns = probes.map((p) => {
  const hooks = (settings?.hooks?.PreToolUse ?? []).filter((h) => h.matcher.split('|').includes(p.tool)).flatMap((h) => h.hooks);
  const runs = hooks.map((h) => spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: p.tool, tool_input: p.input, cwd: process.cwd(), session_id: 'daily-pass' }), encoding: 'utf8', env: process.env }));
  return { ...p, statuses: runs.map((r) => r.status), stderr: runs.map((r) => r.stderr.trim()).join('\n') };
});
fs.appendFileSync(
  process.env.FAKE_CLAUDE_RECORD,
  `${JSON.stringify({
    argv,
    cwd: process.cwd(),
    settings,
    token: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    policy: policyBytes ? JSON.parse(policyBytes.toString('utf8')) : null,
    policyShaMatches: policyBytes ? crypto.createHash('sha256').update(policyBytes).digest('hex') === process.env.CC_POLICY_SHA256 : false,
    sessionDir: process.env.CC_SESSION_DIR ?? null,
    disableAutoupdater: process.env.DISABLE_AUTOUPDATER ?? null,
    hookRuns,
  })}\n`,
);
console.log('SUMMARY: 0 policy changes, 0 company alerts');
// FAKE_CLAUDE_EXIT makes a pass (or rank call) fail the way a crashed or refused claude -p does.
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
