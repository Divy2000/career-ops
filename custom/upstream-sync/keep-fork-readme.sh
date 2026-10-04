#!/bin/bash
# Keep the fork's .github/README.md when the weekly upstream merge conflicts on it.
#
#   keep-fork-readme.sh <state-dir> <YYYY-MM-DD>     (run inside the merge worktree)
#
# The fork's landing page lives at .github/README.md, the one file outside
# custom/. If upstream ever ships the same path, the merge conflicts (add/add or
# modify/delete). This script keeps the fork's side (its version, or its
# deletion), saves upstream's version to <state-dir>/<date>.upstream-github-readme.md
# for a human to compare, stages the result, and finishes the merge commit when
# that was the only conflict.
#
# Exit codes: 0 nothing to do, 10 conflict resolved by keeping ours, 1 error,
# 2 usage error.
set -uo pipefail

FILE=".github/README.md"
if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo "usage: keep-fork-readme.sh <state-dir> <YYYY-MM-DD>" >&2
  exit 2
fi
STATE_DIR="$1"
TODAY="$2"

if [ -z "$(git ls-files -u -- "$FILE")" ]; then
  exit 0
fi

echo "$FILE conflicts with upstream: keeping the fork's side"
STAGES="$(git ls-files -u -- "$FILE")"
HAS_OURS=0; HAS_THEIRS=0
printf '%s\n' "$STAGES" | grep -q "^[0-9]* [0-9a-f]* 2" && HAS_OURS=1
printf '%s\n' "$STAGES" | grep -q "^[0-9]* [0-9a-f]* 3" && HAS_THEIRS=1

if [ $HAS_THEIRS = 1 ]; then
  mkdir -p "$STATE_DIR" || exit 1
  git show ":3:$FILE" > "$STATE_DIR/$TODAY.upstream-github-readme.md" || exit 1
  echo "upstream's version saved to $STATE_DIR/$TODAY.upstream-github-readme.md"
else
  echo "upstream deleted $FILE; nothing to save"
fi

if [ $HAS_OURS = 1 ]; then
  git checkout --ours -- "$FILE" || exit 1
  git add -- "$FILE" || exit 1
else
  echo "the fork deleted $FILE; keeping the deletion"
  git rm -q -f -- "$FILE" || exit 1
fi

if [ -z "$(git diff --name-only --diff-filter=U)" ] && git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  git commit -q -m "chore(sync): merge upstream main $TODAY" || exit 1
  echo "merge committed (the README was the only conflict)"
fi
exit 10
