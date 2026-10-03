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

policy_watch() {
  local watch_json prompt batch
  watch_json="$(node custom/immigration/watch.mjs)" || return 1
  echo "$watch_json"
  # One immutable batch file per run: only what THIS run gave the AI is acked.
  mkdir -p "$IMM/batches"
  batch="$IMM/batches/$(date +%Y%m%dT%H%M%S)-$$.json"
  printf '%s' "$watch_json" > "$batch"
  prompt="$(WATCH_JSON="$watch_json" TODAY="$TODAY" IMM="$IMM" node -e '
const fs = require("fs");
const t = fs.readFileSync("custom/immigration/daily-prompt.md", "utf8");
process.stdout.write(t.replaceAll("{{TODAY}}", process.env.TODAY).replaceAll("{{IMM}}", process.env.IMM).replace("{{WATCH_JSON}}", process.env.WATCH_JSON));
')" || return 1
  # Absolute path rule (leading //) so the AI writes where watch.mjs reads,
  # even when the data root is outside the checkout.
  claude -p "$prompt" \
    --permission-mode dontAsk \
    --add-dir "$IMM" \
    --allowedTools "WebSearch" "WebFetch" "Read" "Edit(/$IMM/**)" \
    --max-turns 40 \
    --output-format text || return 1
  # Only a successful pass acknowledges the batch; failures retry tomorrow.
  node custom/immigration/watch.mjs --ack "$batch"
}

step "policy watch" policy_watch
step "portal scan" node scan.mjs --quiet
step "prioritize pipeline" node custom/pipeline/prioritize.mjs
step "rank top $RANK_LIMIT" node rank-pipeline.mjs --limit "$RANK_LIMIT" --model sonnet
step "sponsorship shortlist" node custom/pipeline/shortlist.mjs

echo "=== $(date '+%Y-%m-%d %H:%M:%S') done (failed=$FAILED)"
exit "$FAILED"
