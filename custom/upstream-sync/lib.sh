# Helpers for sync.sh. Sourced, never executed: no top-level side effects and
# no shell options are set here. Kept separate so they are tested against temp
# repos (tests/sync-fetch.spec.mjs).

# fetch_main <remote>: fetch the remote's main into refs/remotes/<remote>/main
# and check that it resolves to a commit.
#
# The explicit refspec matters: a remote whose configured fetch refspec does not
# cover branches (the live checkout's upstream only fetches one tag) makes a bare
# "git fetch <remote> main" update FETCH_HEAD only, so <remote>/main would never
# exist. A failed fetch is an error even when an older ref is still around.
fetch_main() {
  local remote="$1"
  if ! git fetch -q "$remote" "+refs/heads/main:refs/remotes/$remote/main"; then
    echo "git fetch of main from remote '$remote' failed" >&2
    return 1
  fi
  if ! git rev-parse --verify --quiet "refs/remotes/$remote/main^{commit}" >/dev/null; then
    echo "remote '$remote' has no main branch that resolves to a commit after fetching" >&2
    return 1
  fi
}

# install_root_deps <ignore-scripts|run-scripts>: install the checkout's root
# dependencies (run from the repo root). Upstream ships no root package-lock.json,
# so "npm ci" only works when one is tracked; otherwise install without writing a
# lockfile. control-center has its own tracked lockfile; control_center_checks installs it.
install_root_deps() {
  local mode="$1" flags=()
  case "$mode" in
    ignore-scripts) flags=(--ignore-scripts) ;;
    run-scripts) ;;
    *) echo "install_root_deps: unknown mode '$mode'" >&2; return 2 ;;
  esac
  if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    if [ "$mode" = ignore-scripts ]; then
      npm ci --ignore-scripts --silent
    else
      npm install --silent
    fi
  else
    npm install --no-package-lock ${flags[@]+"${flags[@]}"} --silent
  fi
}

# deps_fingerprint <rev>: what decides whether the root dependencies changed
# between two revisions: the tracked lockfile's blob, else package.json's.
deps_fingerprint() {
  git rev-parse --verify --quiet "$1:package-lock.json" 2>/dev/null || git rev-parse --verify "$1:package.json"
}

# refresh_root_deps <base-rev>: after the merge, reinstall the root
# dependencies (no lifecycle scripts) when they differ from <base-rev>'s, so
# the post-merge tests run on the dependencies the merge brings, not the ones
# installed before it. Fails when a fingerprint cannot be read or the install
# fails.
refresh_root_deps() {
  local before after
  before="$(deps_fingerprint "$1")" || return 1
  after="$(deps_fingerprint HEAD)" || return 1
  [ "$before" = "$after" ] && return 0
  echo "root dependencies changed in the merge; reinstalling"
  install_root_deps ignore-scripts
}

# control_center_checks <log>: install custom/control-center from its tracked
# lockfile (no lifecycle scripts), then run its vitest suite (which holds the
# contract test against upstream's CLIs) and its typecheck, all output to <log>.
# Fails at the first failing step, and when no test ran at all.
control_center_checks() {
  local log="$1"
  {
    npm --prefix custom/control-center ci --ignore-scripts --no-audit --no-fund &&
      npm --prefix custom/control-center test &&
      npm --prefix custom/control-center run typecheck
  } > "$log" 2>&1 || return 1
  grep -qE 'Tests[[:space:]]+[1-9][0-9]* passed' "$log"
}

# custom_tests <log>: run the fork's custom/*/tests specs (from the repo root),
# all output to <log>. Fails when a test fails, and when no test passed at all.
# Node 22 prints TAP ("# pass N") when output is not a TTY and Node 23+ the spec
# reporter ("ℹ pass N"), so either summary counts.
custom_tests() {
  local log="$1"
  node --test custom/*/tests/*.spec.mjs > "$log" 2>&1 || return 1
  grep -qE '^(#|ℹ) pass [1-9]' "$log"
}

# verify_merge <branch>: the gates that stop the sync before anything is pushed.
# Prints the first one that fails and returns 1: unmerged paths, upstream/main
# not merged into HEAD, or uncommitted changes to tracked files.
verify_merge() {
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "unmerged paths remain after Claude"; return 1; fi
  if ! git merge-base --is-ancestor upstream/main HEAD; then echo "upstream/main is not merged into $1"; return 1; fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "uncommitted changes left in the sync worktree"; return 1; fi
}

# merge_snapshot: every path the merge left resolved (index stage 0), one
# "path<TAB>mode blob" line each, sorted. Taken right after the merge attempt
# and before Claude runs: auto-merged content as the merge staged it, and no
# entry for a path that still conflicts. sync.sh keeps it in a variable, never in
# a file the sync Claude could rewrite. Fails when git fails or nothing is staged.
merge_snapshot() {
  local index snap
  index="$(git ls-files -s)" || return 1
  snap="$(printf '%s\n' "$index" | awk -F'\t' '$2 != "" { split($1, m, " "); if (m[3] == "0") print $2 "\t" m[1] " " m[2] }' | LC_ALL=C sort)"
  if [ -z "$snap" ]; then echo "merge_snapshot: the index has no resolved paths" >&2; return 1; fi
  printf '%s\n' "$snap"
}

# changed_since_snapshot <snapshot>: the paths outside custom/ and
# .github/README.md whose content, mode or presence at HEAD differs from the
# merge_snapshot text <snapshot>: what this run changed after the merge. A fork
# difference from upstream kept by an earlier sync is in both, so it is not here.
# Fails closed: an empty snapshot or an unreadable HEAD is an error, never
# "nothing changed".
changed_since_snapshot() {
  local tree
  if [ -z "${1:-}" ]; then echo "changed_since_snapshot: no merge snapshot to compare with" >&2; return 1; fi
  tree="$(git ls-tree -r HEAD)" || return 1
  printf '%s\n' "$tree" | awk -F'\t' '$2 != "" { split($1, m, " "); print $2 "\t" m[1] " " m[3] }' | LC_ALL=C sort |
    LC_ALL=C comm -3 <(printf '%s\n' "$1") - | sed -e 's/^\t//' | cut -f1 |
    awk '$0 != "" && !/^custom\// && $0 != ".github/README.md"' | LC_ALL=C sort -u
}

# unexpected_upstream <changed> <conflicts>: the files (one per line) in
# <changed> that are not in <conflicts>. Upstream files may only be edited to
# resolve a merge conflict, so any of these holds the PR for a human.
unexpected_upstream() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s\n' "$2" | grep -qxF -- "$f" || printf '%s\n' "$f"
  done <<< "$1"
}

# suite_failures <file>: upstream suite failures, one stable line per failing
# test, written to <file>. A run that never prints its final "Results:" summary
# crashed; that is recorded as a failure line of its own so it can never read as
# "no failures".
suite_failures() {
  local out="$1.raw"
  node test-all.mjs --quick > "$out" 2>&1
  local code=$?
  {
    grep -E '^\s*❌' "$out" | sed -E 's/^[[:space:]]+//'
    grep -q 'Results:' "$out" || echo "SUITE CRASHED (exit $code, no Results summary; see $out)"
  } | sort -u > "$1"
}

# new_failures <baseline> <after>: the lines of <after> that are not in
# <baseline>, both as suite_failures wrote them (sorted).
new_failures() {
  comm -13 "$1" "$2"
}

# merge_blockers: why the sync PR must wait for a human, as one line of reasons
# joined by "; ", or nothing when it may auto-merge. Reads CUSTOM_OK, CC_OK,
# AUTO_MERGE and KEPT_README (an unset flag blocks), and NEW_FAILURES and
# UNEXPECTED_UPSTREAM (one entry per line).
merge_blockers() {
  local why=() out="" w
  [ "${CUSTOM_OK:-0}" = 1 ] || why+=("custom tests FAIL")
  [ "${CC_OK:-0}" = 1 ] || why+=("control-center tests and typecheck FAIL")
  [ -z "${NEW_FAILURES:-}" ] || why+=("new upstream-suite failures: ${NEW_FAILURES//$'\n'/, }")
  [ "${AUTO_MERGE:-0}" = 1 ] || why+=("run with --no-merge")
  [ "${KEPT_README:-1}" = 0 ] || why+=("fork README kept over an upstream .github/README.md (compare by hand)")
  [ -z "${UNEXPECTED_UPSTREAM:-}" ] || why+=("upstream files edited outside conflict resolution: ${UNEXPECTED_UPSTREAM//$'\n'/, }")
  for w in ${why[@]+"${why[@]}"}; do out="${out:+$out; }$w"; done
  printf '%s' "$out"
}
