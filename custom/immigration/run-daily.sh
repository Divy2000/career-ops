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
# shellcheck source=custom/launchd/pinned-node.sh
source "$ROOT/custom/launchd/pinned-node.sh"
# User data follows career-ops' data-root contract (CAREER_OPS_ROOT / .career-ops-data).
DATA="$(cd "$ROOT" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")"
# No node, or a root that is not there (an unmounted drive): stop here, before anything is created under "/data" or a
# missing root. There is no day log yet, so the reason goes to stderr (launchd.err.log).
if [ -z "$DATA" ] || [ ! -d "$DATA" ]; then
  echo "run-daily: cannot resolve the career-ops data root (got '${DATA}'); check that node runs and that CAREER_OPS_ROOT or .career-ops-data names an existing folder" >&2
  exit 1
fi
IMM="$DATA/data/immigration"
mkdir -p "$IMM/logs"
# One run at a time: re-exec under a kernel lock (released automatically when
# the process exits, so a crash never leaves a stale lock). lockf exits 75
# when another run holds it. -k keeps the lock file so every run locks the
# same inode. CC_RUN_DAILY_LOCKED only marks the re-exec'd child.
if [ -z "${CC_RUN_DAILY_LOCKED:-}" ]; then
  CC_RUN_DAILY_LOCKED=1 /usr/bin/lockf -k -t 0 "$IMM/.run-daily.lockf" /bin/bash "$0" "$@"
  rc=$?
  # The weekly upstream sync borrows this lock to update the live checkout, and names its pid in .live-update.pid
  # while it does. It writes that pid just after it takes the lock, so a scheduled start can lose that race by a few
  # milliseconds and would skip the day: poll briefly for the marker before calling it a plain conflict. launchd fires
  # a calendar job once and never retries, so a scheduled start waits for that update (bounded) rather than losing the
  # day; a start the user asked for says what holds the lock instead.
  update_pid=""
  if [ "$rc" = 75 ]; then
    update_wait=0
    while [ "$update_wait" -lt 24 ]; do
      if [ -n "$update_pid" ] && kill -0 "$update_pid" 2>/dev/null; then break; fi
      update_pid=""
      sleep 0.05
      update_pid="$(cat "$IMM/.live-update.pid" 2>/dev/null)"
      [[ "$update_pid" =~ ^[0-9]+$ ]] || update_pid=""
      update_wait=$((update_wait + 1))
    done
  fi
  if [ "$rc" = 75 ] && [ -n "$update_pid" ] && kill -0 "$update_pid" 2>/dev/null; then
    if [ -z "${CC_RUN_DAILY_SKIP_EXIT:-}" ]; then
      CC_RUN_DAILY_LOCKED=1 /usr/bin/lockf -k -t 1800 "$IMM/.run-daily.lockf" /bin/bash "$0" "$@"
      rc=$?
    else
      echo "run-daily: skipped, because the weekly upstream sync is updating the live checkout (it holds the daily job's lock); try again in a few minutes" >&2
      case "$CC_RUN_DAILY_SKIP_EXIT" in *[!0-9]*) exit 0 ;; *) exit "$CC_RUN_DAILY_SKIP_EXIT" ;; esac
    fi
  fi
  if [ "$rc" = 75 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') another run-daily holds the lock; skipped" >> "$IMM/logs/skipped.log"
    # A start the user asked for (the Control Center sets CC_RUN_DAILY_SKIP_EXIT) must not read as a finished run:
    # say why nothing ran and exit with that code. launchd sets nothing, so its skipped start still exits 0.
    case "${CC_RUN_DAILY_SKIP_EXIT:-}" in
      '' ) exit 0 ;;
      *[!0-9]* ) exit 0 ;;
      * ) echo "run-daily: skipped, because the daily job is already running (another run holds its lock)" >&2; exit "$CC_RUN_DAILY_SKIP_EXIT" ;;
    esac
  fi
  exit "$rc"
fi
# Only the lock holder gets here: the Control Center reads this pid to tell this data root's run is alive, however
# the script was started. It goes when the run ends; a crash leaves a stale pid that no longer runs this script.
PIDFILE="$IMM/.run-daily.pid"
echo "$$" > "$PIDFILE"
# The step folders (the policy pass settings, the rank shim with the OAuth token) are removed on every way out: a
# signal (the Control Center's cancel, a launchd stop) exits through the EXIT trap. Only SIGKILL skips it.
SETTINGS_DIR=""
SHIM_DIR=""
cleanup() {
  [ -z "$SETTINGS_DIR" ] || rm -rf "$SETTINGS_DIR"
  [ -z "$SHIM_DIR" ] || rm -rf "$SHIM_DIR"
  # Last: while the pid file is there the run counts as alive.
  rm -f "$PIDFILE"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
LOG_DIR="$IMM/logs"
TODAY="$(date +%Y-%m-%d)"
RANK_LIMIT="${RANK_LIMIT:-100}"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/$TODAY.log" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') start"
cd "$ROOT"

# The subscription token goes only to the claude calls (the policy pass, and the rank through the shim), never into
# this shell's environment: scan.mjs loads third-party provider plugins into its own process, and every other step is
# upstream code that has no use for it. An inherited copy is dropped too, with every other Anthropic credential a manual
# or launchd start may carry: every ANTHROPIC_* variable, and every CLAUDE_CODE_* one with a credential name segment
# (the rule the Control Center server applies to its children).
for var in $(compgen -e); do
  case "$var" in
    ANTHROPIC_*) unset "$var" ;;
    CLAUDE_CODE_*)
      case "_${var}_" in
        *_TOKEN_* | *_KEY_* | *_SECRET_* | *_PASSWORD_* | *_PASSPHRASE_* | *_CREDENTIAL_* | *_CREDENTIALS_* | *_CERT_* | *_HEADER_* | *_HEADERS_*) unset "$var" ;;
      esac
      ;;
  esac
done
unset var
if ! CC_OAUTH_TOKEN="$(security find-generic-password -s career-ops-claude-token -w 2>/dev/null)"; then
  echo "!!! Keychain item 'career-ops-claude-token' not found. Run: claude setup-token, then security add-generic-password -U -a \"\$USER\" -s career-ops-claude-token -w"
  exit 1
fi
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
# Which binary, from where: launchd's PATH is not the shell's, so the plist pins CC_CLAUDE_BIN.
CLAUDE_FROM=PATH
if [ -n "${CC_CLAUDE_BIN:-}" ]; then CLAUDE_FROM=CC_CLAUDE_BIN; fi
echo "claude: ${CLAUDE_REAL:-none found} (from $CLAUDE_FROM), $CLAUDE_GATE"

# One AI policy pass at a time (custom/immigration/policy-claim.mjs): a Control Center session may be running one,
# or be paused waiting for a reply, with the same queued items. This job takes the claim for its pass or skips the
# pass with the reason; the items stay pending either way. $$ is this job's lock holder, the pid in .run-daily.pid.
policy_claim() {
  DATA="$DATA" OWNER="daily:$$" ACTION="$1" node --input-type=module -e '
import path from "node:path";
const { tryClaim, releaseClaim } = await import(path.resolve("custom/immigration/policy-claim.mjs"));
const { DATA, OWNER, ACTION } = process.env;
if (ACTION === "release") {
  releaseClaim(DATA, OWNER);
} else {
  const r = tryClaim(DATA, { owner: OWNER, batch: null });
  process.stdout.write(r.ok ? "ok" : r.holder.owner);
}
'
}

policy_watch() {
  local holder rc=0
  holder="$(policy_claim take)" || return 1
  if [ "$holder" != ok ]; then
    echo "policy pass skipped: another AI policy pass holds the queued items ($holder, started from the Control Center); they stay pending for it"
    return 0
  fi
  policy_pass || rc=$?
  policy_claim release || true
  return "$rc"
}

policy_pass() {
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
  prompt="$(WATCH_JSON="$watch_json" TODAY="$TODAY" IMM="$IMM" PROFILE="$DATA/config/profile.yml" node -e '
const fs = require("fs");
const t = fs.readFileSync("custom/immigration/daily-prompt.md", "utf8");
// Replacer functions: a string replacement would expand $&, $` and the like inside the feed JSON or the path.
// The profile is named by its absolute path: the pass runs in the checkout, and the data root may be elsewhere.
process.stdout.write(t.replaceAll("{{TODAY}}", () => process.env.TODAY).replaceAll("{{IMM}}", () => process.env.IMM).replaceAll("{{PROFILE}}", () => process.env.PROFILE).replace("{{WATCH_JSON}}", () => process.env.WATCH_JSON));
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
  # Straight into the global the EXIT trap removes: a signal is handled between commands, never inside this one.
  SETTINGS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-policy-pass.XXXXXX")" || return 1
  settings_dir="$SETTINGS_DIR"
  if ! policy_sha="$(ROOT="$ROOT" DATA="$DATA" IMM="$IMM" DIR="$settings_dir" node --input-type=module -e '
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const c = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
const { ROOT, DATA, IMM, DIR } = process.env;
c.assertRootsConfinable(ROOT, DATA, os.homedir());
const OUTPUTS = ["policy-changes.tsv", "company-alerts.tsv", "policy-digest.md"];
const code = new Set(c.spellings(ROOT));
const data = c.spellings(DATA);
const permissions = {
  additionalDirectories: data.some((d) => code.has(d)) ? [] : data,
  // Writes only to the three files the prompt asks for: the queue, seen ids, batches, the pidfile and the cached
  // company verdicts under data/immigration are the job state, never for the AI to change.
  allow: ["WebSearch", "WebFetch", `Read(${c.absRule(IMM)}/**)`, ...OUTPUTS.map((f) => `Edit(${c.absRule(path.join(IMM, f))})`), `Read(${c.absRule(path.join(DATA, "config", "profile.yml"))})`],
  deny: c.buildReadDenyRules([ROOT, DATA]),
};
const policy = c.writeGuardPolicy(DIR, { codeRoot: ROOT, dataRoot: DATA, sessionDir: DIR, allow: OUTPUTS.map((f) => `data/immigration/${f}`), deny: c.ALWAYS_DENIED_WRITES, bash: [], playwright: false, readDeny: c.READ_DENY, readOnlyRoots: [], allowsAgent: false, search: false });
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
  CLAUDE_CODE_OAUTH_TOKEN="$CC_OAUTH_TOKEN" ANTHROPIC_API_KEY="" "$CLAUDE_REAL" -p "$prompt" \
    --restricted \
    --tools "Read,Edit,Write,WebFetch,WebSearch" \
    --permission-mode dontAsk \
    --disallowedTools "Bash,Agent,Task,NotebookEdit,PowerShell" \
    --settings "$settings_dir/settings.json" \
    --strict-mcp-config \
    --effort medium \
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
# rank-pipeline.mjs catches a failed call and exits 0, so the shim also writes each refusal to a file
# (CC_SHIM_REFUSALS) and any refusal fails the step.
rank_top() {
  local shim_dir rc now refused failed
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
  # Straight into the global the EXIT trap removes: a signal is handled between commands, never inside this one.
  SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-rank-shim.XXXXXX")" || return 1
  shim_dir="$SHIM_DIR"
  if ! DIR="$shim_dir" node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const { shellQuote } = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
const shim = path.resolve("custom/control-center/server/claude/claude-shim.mjs");
// Not exec: each call that exits non-zero (the shim refusing it, or the real claude failing: a usage limit, no
// network) is recorded, since rank-pipeline.mjs catches every failed call and still exits 0. Its own timeout kills this
// wrapper with SIGTERM: the trap then kills the shim and the claude it runs (their own process group, set -m), records
// the failure and exits 143, so nothing is orphaned and the timed-out call still fails the step. The trap is set before
// the shim starts, and finds it by $!, so a signal at any point (before the start, or before child=$!) is handled.
const failures = shellQuote(path.join(process.env.DIR, "failures"));
fs.writeFileSync(path.join(process.env.DIR, "claude"), [
  "#!/bin/bash",
  "set -m",
  `on_term() { [ -z "$!" ] || { kill -TERM -- "-$!" 2>/dev/null; wait "$!" 2>/dev/null; }; echo 143 >> ${failures}; exit 143; }`,
  "trap on_term TERM INT",
  `CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellQuote(path.join(process.env.DIR, "token"))})" ANTHROPIC_API_KEY="" ${shellQuote(process.execPath)} ${shellQuote(shim)} "$@" &`,
  "child=$!",
  "wait \"$child\"",
  "rc=$?",
  `[ "$rc" -eq 0 ] || echo "$rc" >> ${failures}`,
  "exit \"$rc\"",
  "",
].join("\n"), { mode: 0o755 });
'; then
    rm -rf "$shim_dir"
    return 1
  fi
  # The token is read by the wrapper above for the shim alone (0600, in the step's private folder, removed after), so
  # upstream rank-pipeline.mjs never holds it in its environment.
  (umask 077 && printf '%s' "$CC_OAUTH_TOKEN" > "$shim_dir/token") || { rm -rf "$shim_dir"; return 1; }
  rc=0
  PATH="$shim_dir:$PATH" CC_CLAUDE_BIN="$CLAUDE_REAL" CC_CLAUDE_EXPECT="$CLAUDE_GATE" CC_SHIM_REFUSALS="$shim_dir/refusals" node rank-pipeline.mjs --cli claude --limit "$RANK_LIMIT" --model sonnet || rc=$?
  refused=0
  if [ -s "$shim_dir/refusals" ]; then
    refused="$(grep -c '' "$shim_dir/refusals")"
    echo "claude-shim refused $refused rank call(s); the rank step fails"
    rc=1
  fi
  # Calls that failed for another reason than a shim refusal (a refused call exits non-zero too).
  if [ -s "$shim_dir/failures" ]; then
    failed=$(( $(grep -c '' "$shim_dir/failures") - refused ))
    if [ "$failed" -gt 0 ]; then
      echo "$failed rank call(s) failed (claude exited $(sort -un "$shim_dir/failures" | paste -sd ',' -)); the rank step fails"
      rc=1
    fi
  fi
  rm -rf "$shim_dir"
  return "$rc"
}

step "rank top $RANK_LIMIT" rank_top
step "sponsorship shortlist" node custom/pipeline/shortlist.mjs

echo "=== $(date '+%Y-%m-%d %H:%M:%S') done (failed=$FAILED)"
exit "$FAILED"
