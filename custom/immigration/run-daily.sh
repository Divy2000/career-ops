#!/bin/bash
# Daily career-ops run (scheduled by ~/Library/LaunchAgents/com.career-ops.immigration-watch.plist):
#   1. immigration-policy watch (official sources + headless Claude news pass)
#   2. portal scan (zero tokens; only jobs not seen before)
#   3. prioritize pending rows (today's new jobs, fresh postings, backend/AI first)
#   4. rank the top rows with headless Claude (bounded by RANK_LIMIT)
#   5. sponsorship-aware shortlist -> data/shortlist.md (zero tokens)
# A failing step is logged and the remaining steps still run.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# User data follows career-ops' data-root contract (CAREER_OPS_ROOT / .career-ops-data).
DATA="$(cd "$ROOT" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")"
IMM="$DATA/data/immigration"
mkdir -p "$IMM/logs"
# One run at a time: re-exec under a kernel lock (released automatically when
# the process exits, so a crash never leaves a stale lock). lockf exits 75
# when another run holds it. -k keeps the lock file so every run locks the
# same inode. CC_RUN_DAILY_LOCKED only marks the re-exec'd child.
if [ -z "${CC_RUN_DAILY_LOCKED:-}" ]; then
  CC_RUN_DAILY_LOCKED=1 /usr/bin/lockf -k -t 0 "$IMM/.run-daily.lockf" /bin/bash "$0" "$@"
  rc=$?
  if [ "$rc" = 75 ]; then echo "$(date '+%Y-%m-%d %H:%M:%S') another run-daily holds the lock; skipped" >> "$IMM/logs/skipped.log"; exit 0; fi
  exit "$rc"
fi
LOG_DIR="$IMM/logs"
TODAY="$(date +%Y-%m-%d)"
RANK_LIMIT="${RANK_LIMIT:-100}"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/$TODAY.log" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') start"
cd "$ROOT"

if ! CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s career-ops-claude-token -w 2>/dev/null)"; then
  echo "ERROR: Keychain item 'career-ops-claude-token' not found. Run: claude setup-token, then security add-generic-password -U -a \"\$USER\" -s career-ops-claude-token -w"
  exit 1
fi
export CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_API_KEY=""
FAILED=0

step() {
  local name="$1"; shift
  echo "--- $(date '+%H:%M:%S') $name"
  if ! "$@"; then
    echo "!!! step failed: $name"
    FAILED=1
  fi
}

# Every Claude call of this job (the policy pass, and the rank through claude-shim.mjs) runs only
# on a Claude Code whose confinement was probed (contract.json claude.approvedVersions), asked with
# the autoupdater off: another version can change what the confinement flags and rules do.
# claude_check prints the binary's identity (real path @ version) for an approved version (exit 0),
# the reason for another version (exit 3) or why the version cannot be read (exit 1). CLAUDE_GATE_RC
# is that exit for the whole job: 3 skips the Claude steps, 1 fails them. Each spawn checks again
# that the binary is still CLAUDE_GATE. CC_CLAUDE_BIN chooses the binary (tests use a fake).
CLAUDE_REAL="${CC_CLAUDE_BIN:-$(command -v claude || true)}"
claude_check() {
  CLAUDE_BIN="$CLAUDE_REAL" node --input-type=module -e '
import path from "node:path";
const { claudeVersionGate } = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
let gate;
try {
  gate = claudeVersionGate(process.env.CLAUDE_BIN || "claude");
} catch (err) {
  process.stdout.write(`${err.message}; the Claude steps need an approved Claude Code`);
  process.exit(1);
}
if (gate.problem) {
  process.stdout.write(gate.problem);
  process.exit(3);
}
process.stdout.write(gate.identity);
' 2>&1
}
CLAUDE_GATE_RC=0
CLAUDE_GATE="$(claude_check)" || CLAUDE_GATE_RC=$?

policy_watch() {
  local watch_json prompt batch settings_dir policy_sha rc now
  watch_json="$(node custom/immigration/watch.mjs)" || return 1
  echo "$watch_json"
  # Only an approved Claude Code runs the pass (see claude_gate). An unapproved one skips the pass
  # without failing the job: the digest says why, and the official items stay pending for the next
  # run. A version that cannot be read fails the step.
  if [ "$CLAUDE_GATE_RC" -eq 3 ]; then
    echo "policy pass skipped: $CLAUDE_GATE"
    REASON="$CLAUDE_GATE" TODAY="$TODAY" FILE="$IMM/policy-digest.md" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const { noteSkippedPass } = await import(path.resolve("custom/immigration/lib.mjs"));
const { REASON, TODAY, FILE } = process.env;
const before = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
const after = noteSkippedPass(before, TODAY, `${REASON}. The official items stay pending for the next run.`);
if (after !== before) {
  fs.writeFileSync(`${FILE}.tmp-${process.pid}`, after);
  fs.renameSync(`${FILE}.tmp-${process.pid}`, FILE);
}
' || return 1
    return 0
  fi
  if [ "$CLAUDE_GATE_RC" -ne 0 ]; then
    echo "$CLAUDE_GATE"
    return 1
  fi
  # One immutable batch file per run: only what THIS run gave the AI is acked.
  mkdir -p "$IMM/batches"
  batch="$IMM/batches/$(date +%Y%m%dT%H%M%S)-$$.json"
  printf '%s' "$watch_json" > "$batch"
  prompt="$(WATCH_JSON="$watch_json" TODAY="$TODAY" IMM="$IMM" node -e '
const fs = require("fs");
const t = fs.readFileSync("custom/immigration/daily-prompt.md", "utf8");
// Replacer functions: a string replacement would expand $&, $` and the like inside the feed JSON or the path.
process.stdout.write(t.replaceAll("{{TODAY}}", () => process.env.TODAY).replaceAll("{{IMM}}", () => process.env.IMM).replace("{{WATCH_JSON}}", () => process.env.WATCH_JSON));
')" || return 1
  # The pass reads untrusted web pages, so it runs confined like a Control Center session
  # (custom/control-center README section 4): --restricted keeps Read inside the checkout and the
  # data root, the settings file (outside both, removed after the pass) denies the home credential
  # stores and the secret files in them, and the only writes allowed are under $IMM, by absolute
  # path rule (leading //) so the AI writes where watch.mjs reads. A data root that is the home
  # directory, or contains it, is refused. The session guard hook runs on every tool call with a
  # policy pinned by its sha256: WebFetch only to public addresses (never loopback, private or the
  # cloud metadata address), reads inside the roots and never of secret files, writes only under
  # data/immigration/.
  settings_dir="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-policy-pass.XXXXXX")" || return 1
  if ! policy_sha="$(ROOT="$ROOT" DATA="$DATA" IMM="$IMM" DIR="$settings_dir" node --input-type=module -e '
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const c = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
const { ROOT, DATA, IMM, DIR } = process.env;
c.assertRootsConfinable(ROOT, DATA, os.homedir());
const code = new Set(c.spellings(ROOT));
const data = c.spellings(DATA);
const permissions = {
  additionalDirectories: data.some((d) => code.has(d)) ? [] : data,
  allow: ["WebSearch", "WebFetch", `Read(${c.absRule(IMM)}/**)`, `Edit(${c.absRule(IMM)}/**)`, `Read(${c.absRule(path.join(DATA, "config", "profile.yml"))})`],
  deny: c.buildReadDenyRules([ROOT, DATA]),
};
const policy = c.writeGuardPolicy(DIR, { codeRoot: ROOT, dataRoot: DATA, sessionDir: DIR, allow: ["data/immigration/**"], deny: c.ALWAYS_DENIED_WRITES, bash: [], playwright: false, readDeny: c.READ_DENY, readOnlyRoots: [], allowsAgent: false, search: false });
fs.writeFileSync(path.join(DIR, "settings.json"), JSON.stringify({ permissions, hooks: c.guardHooks() }, null, 2));
process.stdout.write(policy.sha256);
')"; then
    rm -rf "$settings_dir"
    return 1
  fi
  # The binary checked at the start must still be the one that runs: an update in between is refused.
  if ! now="$(claude_check)" || [ "$now" != "$CLAUDE_GATE" ]; then
    echo "Claude Code changed since the job checked it ($CLAUDE_GATE, now $now); the pass is not run"
    rm -rf "$settings_dir"
    return 1
  fi
  rc=0
  DISABLE_AUTOUPDATER=1 CC_POLICY_FILE="$settings_dir/policy.json" CC_POLICY_SHA256="$policy_sha" CC_SESSION_DIR="$settings_dir" \
  "$CLAUDE_REAL" -p "$prompt" \
    --restricted \
    --tools "Read,Edit,Write,WebFetch,WebSearch" \
    --permission-mode dontAsk \
    --disallowedTools "Bash,Agent,Task,NotebookEdit,PowerShell" \
    --settings "$settings_dir/settings.json" \
    --strict-mcp-config \
    --max-turns 40 \
    --output-format text || rc=$?
  rm -rf "$settings_dir"
  [ "$rc" -eq 0 ] || return 1
  # Only a successful pass acknowledges the batch; failures retry tomorrow.
  node custom/immigration/watch.mjs --ack "$batch"
}

step "policy watch" policy_watch
step "portal scan" node scan.mjs --quiet
step "prioritize pipeline" node custom/pipeline/prioritize.mjs
# rank-pipeline.mjs (upstream) runs `claude -p` on untrusted posting text. It runs with --cli claude
# (whatever CAREER_OPS_RANK_CLI says) and a wrapper for claude-shim.mjs first on PATH, so that call
# gets no tools, no MCP servers and dontAsk on the approved binary; the folder is removed after.
# The shim checks again before every call that the binary is still CLAUDE_GATE (CC_CLAUDE_EXPECT).
rank_top() {
  local shim_dir rc now
  if [ "$CLAUDE_GATE_RC" -eq 3 ]; then
    echo "rank skipped: $CLAUDE_GATE"
    return 0
  fi
  if [ "$CLAUDE_GATE_RC" -ne 0 ]; then
    echo "$CLAUDE_GATE"
    return 1
  fi
  if ! now="$(claude_check)" || [ "$now" != "$CLAUDE_GATE" ]; then
    echo "Claude Code changed since the job checked it ($CLAUDE_GATE, now $now); the rank is not run"
    return 1
  fi
  shim_dir="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-rank-shim.XXXXXX")" || return 1
  if ! DIR="$shim_dir" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const { shellQuote } = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
const shim = path.resolve("custom/control-center/server/claude/claude-shim.mjs");
fs.writeFileSync(path.join(process.env.DIR, "claude"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(shim)} "$@"\n`, { mode: 0o755 });
'; then
    rm -rf "$shim_dir"
    return 1
  fi
  rc=0
  PATH="$shim_dir:$PATH" CC_CLAUDE_BIN="$CLAUDE_REAL" CC_CLAUDE_EXPECT="$CLAUDE_GATE" node rank-pipeline.mjs --cli claude --limit "$RANK_LIMIT" --model sonnet || rc=$?
  rm -rf "$shim_dir"
  return "$rc"
}

step "rank top $RANK_LIMIT" rank_top
step "sponsorship shortlist" node custom/pipeline/shortlist.mjs

echo "=== $(date '+%Y-%m-%d %H:%M:%S') done (failed=$FAILED)"
exit "$FAILED"
