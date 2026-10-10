#!/bin/bash
# Weekly upstream sync for the Divy2000/career-ops fork.
#
#   1. fetch upstream (career-ops-hq/career-ops) and origin (the fork)
#   2. in a separate worktree, branch from origin/main and merge upstream/main
#   3. headless Claude (Opus 5.5, 1M context) resolves conflicts, checks that
#      custom/ still works with the new upstream code, and writes a report
#   4. this script verifies independently: no unmerged paths, upstream/main is
#      an ancestor, custom tests pass, the control center's tests and typecheck
#      pass, and the upstream suite has no NEW failures compared with origin/main
#      before the merge
#   5. push the branch, open a PR against the fork's main, merge it when green,
#      then fast-forward the live checkout
# Upstream files are never edited except to resolve merge conflicts.
#
# Scheduled by ~/Library/LaunchAgents/com.career-ops.upstream-sync.plist.
# Manual run: custom/upstream-sync/sync.sh [--no-merge]
set -uo pipefail

LIVE="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=custom/upstream-sync/lib.sh
source "$LIVE/custom/upstream-sync/lib.sh"
WT="$HOME/.career-ops-sync"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
# shellcheck source=custom/launchd/pinned-node.sh
source "$LIVE/custom/launchd/pinned-node.sh"
# Logs and reports follow career-ops' data-root contract (CAREER_OPS_ROOT /
# .career-ops-data), the same root the control center reads them from.
DATA="$(cd "$LIVE" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")"
if [ -z "$DATA" ] || [ ! -d "$DATA" ]; then
  echo "upstream-sync: cannot resolve the career-ops data root" >&2
  exit 1
fi
STATE_DIR="$DATA/data/upstream-sync"
# One run at a time: a second run (a manual one during the scheduled one) would remove the first one's worktree
# mid-suite and share its day files. The lock is keyed on the worktree, which every run uses whatever data root it
# resolves. Re-exec under a kernel lock, released when the process exits, so a crash never leaves it stale; -k keeps
# the file so every run locks the same inode, and lockf exits 75 while another run holds it. Taken before the
# CAREER_OPS_* variables are dropped below, so the re-exec'd run resolves the same data root.
if [ -z "${CC_SYNC_LOCKED:-}" ]; then
  CC_SYNC_LOCKED=1 /usr/bin/lockf -k -t 0 "$WT.lockf" /bin/bash "$0" "$@"
  rc=$?
  if [ "$rc" = 75 ]; then
    msg="another upstream sync is running (it holds $WT.lockf); not started"
    echo "upstream-sync: $msg" >&2
    mkdir -p "$STATE_DIR" && echo "=== $(date '+%Y-%m-%d %H:%M:%S') $msg" >> "$STATE_DIR/$(date +%Y-%m-%d).log"
  fi
  exit "$rc"
fi
# The log and reports go to STATE_DIR, resolved above. Everything after this runs code from the sync worktree
# (installs, both upstream suite runs, the custom and control-center checks, Claude), which must never see the
# user's data root: test-all's live archive test, for one, writes into getCareerOpsRoot()/jds.
for v in $(compgen -e CAREER_OPS_); do unset "$v"; done
TODAY="$(date +%Y-%m-%d)"
BRANCH="sync/upstream-$TODAY"
FORK="Divy2000/career-ops"
MODEL="claude-opus-5-5[1m]"
AUTO_MERGE=1
KEPT_README=0
[ "${1:-}" = "--no-merge" ] && AUTO_MERGE=0

mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/$TODAY.log"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') start"

notify() {
  osascript -e "display notification \"$1\" with title \"career-ops upstream sync\"" >/dev/null 2>&1 || true
  echo "NOTIFY: $1"
}
fail() {
  echo "!!! $1"
  notify "$1 (log: data/upstream-sync/$TODAY.log)"
  exit 1
}

cd "$LIVE" || fail "live checkout missing"
fetch_main upstream || fail "cannot fetch main from the upstream remote (see the line above)"
fetch_main origin || fail "cannot fetch main from the origin remote (see the line above)"

if git merge-base --is-ancestor upstream/main origin/main; then
  echo "fork already contains upstream/main ($(git rev-parse --short upstream/main)); nothing to do"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') done (up to date)"
  exit 0
fi
BEHIND="$(git rev-list --count origin/main..upstream/main)"
[[ "$BEHIND" =~ ^[0-9]+$ ]] || fail "could not count commits between origin/main and upstream/main"
echo "fork is $BEHIND commit(s) behind upstream/main"

if ! TOKEN="$(security find-generic-password -s career-ops-claude-token -w 2>/dev/null)"; then
  fail "Keychain item career-ops-claude-token not found"
fi

git worktree remove --force "$WT" >/dev/null 2>&1
rm -rf "$WT"
git worktree prune
git worktree add -q -B "$BRANCH" "$WT" origin/main || fail "git worktree add failed"
cd "$WT" || fail "worktree missing"
# The base the merge is compared with, fixed now: a fetch from any checkout while Claude runs moves origin/main.
BASE_REV="$(git rev-parse HEAD)" || fail "cannot read the sync worktree's base commit"
install_root_deps ignore-scripts >/dev/null 2>&1 || fail "installing root dependencies failed on origin/main"
ensure_playwright_browser || fail "cannot install Playwright's Chromium for origin/main (see the line above)"
# The tree the baseline runs on, kept in memory: after Claude the same tree is reinstalled unless the merge changed it.
BASE_DEPS_TREE="$(root_deps_tree)" || fail "cannot read the baseline's installed dependency tree"

echo "--- baseline suite on origin/main"
suite_failures "$STATE_DIR/$TODAY.baseline-failures.txt" || fail "upstream suite run was interrupted"
# Read once, before Claude runs, and compared from memory: Claude can write to STATE_DIR, so the file could be rewritten.
BASELINE_FAILURES="$(cat "$STATE_DIR/$TODAY.baseline-failures.txt")" || fail "cannot read the baseline upstream-suite failures"
printf '%s\n' "$BASELINE_FAILURES" | grep -q '^SUITE CRASHED' && fail "upstream suite crashed on origin/main before the merge; cannot compare"
echo "baseline failures: $(printf '%s' "$BASELINE_FAILURES" | grep -c . || true)"

echo "--- merging upstream/main"
CONFLICTS=""
if ! git merge --no-ff --no-edit -m "chore(sync): merge upstream main $TODAY" upstream/main; then
  CONFLICTS="$(git diff --name-only --diff-filter=U)"
  echo "conflicts:"; echo "$CONFLICTS"
  # The fork's .github/README.md always wins; a human compares upstream's copy.
  bash "$LIVE/custom/upstream-sync/keep-fork-readme.sh" "$STATE_DIR" "$TODAY"
  case $? in
    0) ;;
    10) KEPT_README=1; CONFLICTS="$(git diff --name-only --diff-filter=U)" ;;
    *) fail "keep-fork-readme.sh failed" ;;
  esac
fi
# What the merge itself produced: only what Claude changes after this, outside the conflicts, can hold the PR.
# Kept in this shell's memory: Claude can write to STATE_DIR and the worktree, so a file there could be rewritten.
MERGE_SNAPSHOT="$(merge_snapshot)" || fail "cannot record the merge result before Claude runs"

echo "--- headless Claude ($MODEL)"
REPORT="$STATE_DIR/$TODAY.report.md"
# A report from an earlier run of the same day describes another resolution: only this run's Claude may fill the PR body.
rm -f "$REPORT" || fail "cannot remove an earlier report at $REPORT"
PROMPT="$(CONFLICTS="$CONFLICTS" BASELINE="$BASELINE_FAILURES" TODAY="$TODAY" BEHIND="$BEHIND" REPORT="$REPORT" node -e '
const fs = require("fs");
let t = fs.readFileSync(process.argv[1], "utf8");
// A replacer function: a string replacement would expand $& and the like inside test output.
for (const k of ["CONFLICTS", "BASELINE", "TODAY", "BEHIND", "REPORT"]) t = t.replaceAll(`{{${k}}}`, () => process.env[k] || "(none)");
process.stdout.write(t);
' "$LIVE/custom/upstream-sync/sync-prompt.md")"
# Claude runs upstream's code and npm install scripts through Bash: SUBPROCESS_ENV_SCRUB keeps the token out of those children.
# Its reply streams to the day log as before (tee) and is kept in memory, where its closing verdict is read.
CLAUDE_OUT="$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 ANTHROPIC_API_KEY="" claude -p "$PROMPT" \
  --model "$MODEL" \
  --effort medium \
  --permission-mode dontAsk \
  --add-dir "$STATE_DIR" \
  --allowedTools "Read" "Glob" "Grep" "Edit" "Write" \
    "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" \
    "Bash(git add:*)" "Bash(git commit:*)" "Bash(git checkout --ours:*)" "Bash(git checkout --theirs:*)" \
    "Bash(git merge --continue:*)" "Bash(node:*)" "Bash(npm ci:*)" "Bash(npm install:*)" \
  --max-turns 150 \
  --output-format text | tee -a "$LOG")"
CLAUDE_RC=$?
# A run that did not finish, gave no verdict or asked for a human holds the PR (merge_blockers).
CLAUDE_HOLD="$(sync_verdict "$CLAUDE_RC" "$CLAUDE_OUT")"
echo "--- verifying"

GATE="$(verify_merge "$BRANCH")" || fail "$GATE"
clean_sync_worktree "$WT" || fail "cannot clean untracked and ignored files from the sync worktree"
refresh_root_deps "$BASE_REV" "$BASE_DEPS_TREE" || fail "reinstalling the merged root dependencies failed"
ensure_playwright_browser || fail "cannot install the merged Playwright's Chromium (see the line above)"

CHANGED_UPSTREAM="$(git diff --name-only upstream/main HEAD -- . ':(exclude)custom/**' ':(exclude).github/README.md')"
if [ -n "$CHANGED_UPSTREAM" ]; then
  echo "NOTE: files outside custom/ differ from upstream/main (expected only for conflict resolutions):"
  echo "$CHANGED_UPSTREAM"
fi
CHANGED_SINCE_MERGE="$(changed_since_snapshot "$MERGE_SNAPSHOT")" || fail "cannot compare HEAD with the merge result"
UNEXPECTED_UPSTREAM="$(unexpected_upstream "$CHANGED_SINCE_MERGE" "$CONFLICTS")"
PROTECTED_EDITS="$({ protected_paths "$CHANGED_SINCE_MERGE"; contract_gate_edits "$MERGE_SNAPSHOT"; } | LC_ALL=C sort -u)"

CUSTOM_OK=1
custom_tests "$STATE_DIR/$TODAY.custom-tests.txt" || CUSTOM_OK=0
echo "custom tests: $([ $CUSTOM_OK = 1 ] && echo pass || echo FAIL)"

CC_OK=1
control_center_checks "$STATE_DIR/$TODAY.control-center-tests.txt" || CC_OK=0
echo "control-center tests and typecheck: $([ $CC_OK = 1 ] && echo pass || echo FAIL)"

suite_failures "$STATE_DIR/$TODAY.after-failures.txt" || fail "upstream suite run was interrupted"
NEW_FAILURES="$(new_failures "$BASELINE_FAILURES" "$STATE_DIR/$TODAY.after-failures.txt")" || fail "cannot compare the upstream suite with its baseline"
echo "new upstream-suite failures: $(printf '%s' "$NEW_FAILURES" | grep -c . || true)"

git push -q --force-with-lease origin "$BRANCH" || fail "git push failed"
BODY="$STATE_DIR/$TODAY.pr-body.md"
{
  echo "Weekly merge of career-ops-hq/career-ops main ($BEHIND commits) into this fork."
  echo
  echo "- Conflicts: ${CONFLICTS:-none}"
  echo "- custom/ tests: $([ $CUSTOM_OK = 1 ] && echo pass || echo FAIL)"
  echo "- control-center tests and typecheck: $([ $CC_OK = 1 ] && echo pass || echo FAIL)"
  echo "- New failures in test-all.mjs --quick vs origin/main: ${NEW_FAILURES:-none}"
  echo "- Files outside custom/ that differ from upstream: ${CHANGED_UPSTREAM:-none}"
  echo "- Upstream files this run edited after the merge outside conflict resolution (blocks auto-merge): ${UNEXPECTED_UPSTREAM:-none}"
  echo "- Fork tests, gates, guard or README files this run edited (blocks auto-merge; check no test was weakened): ${PROTECTED_EDITS:-none}"
  if [ $KEPT_README = 1 ]; then
    echo "- .github/README.md conflicted with upstream: the fork's version was kept. Upstream's copy: data/upstream-sync/$TODAY.upstream-github-readme.md (not auto-merged; compare, then merge by hand)."
  fi
  echo
  echo "## Claude report"
  cat "$REPORT" 2>/dev/null || echo "(no report written)"
} > "$BODY"
PR_URL="$(gh pr list --repo "$FORK" --head "$BRANCH" --state open --json url -q '.[0].url')"
if [ -z "$PR_URL" ]; then
  PR_URL="$(gh pr create --repo "$FORK" --base main --head "$BRANCH" \
    --title "chore(sync): merge upstream main $TODAY" --body-file "$BODY")" || fail "gh pr create failed"
else
  gh pr edit "$PR_URL" --body-file "$BODY" >/dev/null || true
fi
echo "PR: $PR_URL"

# Every gate compared with BASE_REV: a main that moved since (another PR merged meanwhile) holds the PR, and the merge
# itself is pinned to the head commit that was tested. GitHub still merges onto whatever main is when it runs, so a
# merge made onto another main (a PR merged in the moment between) never reaches the live checkout.
MAIN_MOVED="$(main_moved "$BASE_REV")"
BLOCKERS="$(merge_blockers)"
if [ -z "$BLOCKERS" ]; then
  gh pr merge "$PR_URL" --merge --match-head-commit "$(git rev-parse HEAD)" --delete-branch >/dev/null || fail "gh pr merge failed for $PR_URL"
  echo "merged $PR_URL"
  MERGE_OID="$(gh pr view "$PR_URL" --json mergeCommit -q .mergeCommit.oid)"
  MERGED_ONTO="$(merged_onto "$MERGE_OID" "$BASE_REV")"
  [ -z "$MERGED_ONTO" ] || fail "$MERGED_ONTO; the live checkout was not updated. Test origin/main before pulling it"
  cd "$LIVE" || fail "live checkout missing"
  # Waits up to an hour for a daily job running from the live checkout (both can start together on wake).
  # Moves to the verified merge commit only: a PR merged after it was not tested by this run.
  LIVE_UPDATE="$(update_live_checkout "$DATA/data/immigration/.run-daily.lockf" 3600 "$MERGE_OID")"
  case $? in
    0) echo "$LIVE_UPDATE"; notify "Merged upstream ($BEHIND commits) and updated career-ops" ;;
    3) echo "$LIVE_UPDATE"; notify "Merged upstream, but in the live checkout ${LIVE_UPDATE#*, but }" ;;
    10) echo "live checkout not updated: $LIVE_UPDATE"; notify "Merged upstream; $LIVE_UPDATE, so it was not updated. Run: git switch main && git pull --ff-only" ;;
    *) fail "$LIVE_UPDATE" ;;
  esac
  git worktree remove --force "$WT" >/dev/null 2>&1
else
  gh pr comment "$PR_URL" --body "Not auto-merged: $BLOCKERS." >/dev/null || true
  notify "Upstream sync PR needs review: $PR_URL"
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S') done"
