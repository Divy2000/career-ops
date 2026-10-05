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

# Upstream suite failures, one stable line per failing test, written to $1.
# A run that never prints its final "Results:" summary crashed; that is
# recorded as a failure line of its own so it can never read as "no failures".
suite_failures() {
  local out="$1.raw"
  node test-all.mjs --quick > "$out" 2>&1
  local code=$?
  {
    grep -E '^\s*❌' "$out" | sed -E 's/^[[:space:]]+//'
    grep -q 'Results:' "$out" || echo "SUITE CRASHED (exit $code, no Results summary; see $out)"
  } | sort -u > "$1"
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
install_root_deps ignore-scripts >/dev/null 2>&1 || fail "installing root dependencies failed on origin/main"

echo "--- baseline suite on origin/main"
suite_failures "$STATE_DIR/$TODAY.baseline-failures.txt"
grep -q '^SUITE CRASHED' "$STATE_DIR/$TODAY.baseline-failures.txt" && fail "upstream suite crashed on origin/main before the merge; cannot compare"
echo "baseline failures: $(wc -l < "$STATE_DIR/$TODAY.baseline-failures.txt" | tr -d ' ')"

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

echo "--- headless Claude ($MODEL)"
PROMPT="$(CONFLICTS="$CONFLICTS" BASELINE="$(cat "$STATE_DIR/$TODAY.baseline-failures.txt")" TODAY="$TODAY" BEHIND="$BEHIND" REPORT="$STATE_DIR/$TODAY.report.md" node -e '
const fs = require("fs");
let t = fs.readFileSync(process.argv[1], "utf8");
// A replacer function: a string replacement would expand $& and the like inside test output.
for (const k of ["CONFLICTS", "BASELINE", "TODAY", "BEHIND", "REPORT"]) t = t.replaceAll(`{{${k}}}`, () => process.env[k] || "(none)");
process.stdout.write(t);
' "$LIVE/custom/upstream-sync/sync-prompt.md")"
# Claude runs upstream's code and npm install scripts through Bash: SUBPROCESS_ENV_SCRUB keeps the token out of those children.
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 ANTHROPIC_API_KEY="" claude -p "$PROMPT" \
  --model "$MODEL" \
  --permission-mode dontAsk \
  --add-dir "$STATE_DIR" \
  --allowedTools "Read" "Glob" "Grep" "Edit" "Write" \
    "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" \
    "Bash(git add:*)" "Bash(git commit:*)" "Bash(git checkout --ours:*)" "Bash(git checkout --theirs:*)" \
    "Bash(git merge --continue:*)" "Bash(node:*)" "Bash(npm ci:*)" "Bash(npm install:*)" \
  --max-turns 150 \
  --output-format text
echo "--- verifying"

[ -z "$(git diff --name-only --diff-filter=U)" ] || fail "unmerged paths remain after Claude"
git merge-base --is-ancestor upstream/main HEAD || fail "upstream/main is not merged into $BRANCH"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "uncommitted changes left in the sync worktree"

CHANGED_UPSTREAM="$(git diff --name-only upstream/main HEAD -- . ':(exclude)custom/**' ':(exclude).github/README.md')"
if [ -n "$CHANGED_UPSTREAM" ]; then
  echo "NOTE: files outside custom/ differ from upstream/main (expected only for conflict resolutions):"
  echo "$CHANGED_UPSTREAM"
fi

CUSTOM_OK=1
custom_tests "$STATE_DIR/$TODAY.custom-tests.txt" || CUSTOM_OK=0
echo "custom tests: $([ $CUSTOM_OK = 1 ] && echo pass || echo FAIL)"

CC_OK=1
control_center_checks "$STATE_DIR/$TODAY.control-center-tests.txt" || CC_OK=0
echo "control-center tests and typecheck: $([ $CC_OK = 1 ] && echo pass || echo FAIL)"

suite_failures "$STATE_DIR/$TODAY.after-failures.txt"
NEW_FAILURES="$(comm -13 "$STATE_DIR/$TODAY.baseline-failures.txt" "$STATE_DIR/$TODAY.after-failures.txt")"
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
  if [ $KEPT_README = 1 ]; then
    echo "- .github/README.md conflicted with upstream: the fork's version was kept. Upstream's copy: data/upstream-sync/$TODAY.upstream-github-readme.md (not auto-merged; compare, then merge by hand)."
  fi
  echo
  echo "## Claude report"
  cat "$STATE_DIR/$TODAY.report.md" 2>/dev/null || echo "(no report written)"
} > "$BODY"
PR_URL="$(gh pr list --repo "$FORK" --head "$BRANCH" --state open --json url -q '.[0].url')"
if [ -z "$PR_URL" ]; then
  PR_URL="$(gh pr create --repo "$FORK" --base main --head "$BRANCH" \
    --title "chore(sync): merge upstream main $TODAY" --body-file "$BODY")" || fail "gh pr create failed"
else
  gh pr edit "$PR_URL" --body-file "$BODY" >/dev/null || true
fi
echo "PR: $PR_URL"

if [ $CUSTOM_OK = 1 ] && [ $CC_OK = 1 ] && [ -z "$NEW_FAILURES" ] && [ $AUTO_MERGE = 1 ] && [ $KEPT_README = 0 ]; then
  gh pr merge "$PR_URL" --merge --delete-branch >/dev/null || fail "gh pr merge failed for $PR_URL"
  echo "merged $PR_URL"
  cd "$LIVE" || fail "live checkout missing"
  fetch_main origin || fail "cannot refresh origin/main after the merge"
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] && [ -z "$(git status --porcelain --untracked-files=no)" ]; then
    DEPS_BEFORE="$(deps_fingerprint HEAD)" || fail "cannot read the live checkout's dependency files"
    git merge -q --ff-only origin/main || fail "live checkout could not fast-forward"
    if [ "$DEPS_BEFORE" != "$(deps_fingerprint HEAD)" ]; then
      install_root_deps run-scripts >/dev/null 2>&1 || notify "Merged upstream, but npm install failed in the live checkout; run it by hand"
    fi
    echo "live checkout now at $(git rev-parse --short HEAD)"
    notify "Merged upstream ($BEHIND commits) and updated career-ops"
  else
    notify "Merged upstream; live checkout has local changes, run: git pull --ff-only"
  fi
  git worktree remove --force "$WT" >/dev/null 2>&1
else
  gh pr comment "$PR_URL" --body "Not auto-merged: custom tests $([ $CUSTOM_OK = 1 ] && echo pass || echo FAIL); control-center tests and typecheck $([ $CC_OK = 1 ] && echo pass || echo FAIL); new suite failures: ${NEW_FAILURES:-none}; fork README kept over an upstream .github/README.md: $([ $KEPT_README = 1 ] && echo yes || echo no)." >/dev/null || true
  notify "Upstream sync PR needs review: $PR_URL"
fi
echo "=== $(date '+%Y-%m-%d %H:%M:%S') done"
