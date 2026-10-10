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
# between two revisions: the tracked lockfile's blob, else a hash of only the
# package.json fields that decide how dependencies resolve (peerDependenciesMeta
# included: it makes a peer optional), as JSON with sorted keys. Upstream's
# release bot bumps "version" every release and PRs edit
# scripts or engines; none of that changes what npm installs. Fails when
# package.json is missing or not JSON.
deps_fingerprint() {
  local pkg fields
  if git rev-parse --verify --quiet "$1:package-lock.json" 2>/dev/null; then return 0; fi
  pkg="$(git show "$1:package.json")" || return 1
  fields="$(printf '%s' "$pkg" | node -e '
let text = "";
process.stdin.on("data", (d) => (text += d)).on("end", () => {
  const pkg = JSON.parse(text);
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  const keys = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "overrides", "bundleDependencies", "bundledDependencies", "workspaces"];
  process.stdout.write(JSON.stringify(keys.map((k) => [k, sorted(pkg[k] ?? null)])));
});
')" || return 1
  printf '%s' "$fields" | git hash-object --stdin
}

# root_deps_tree: the root dependency tree npm installed, as npm recorded it
# in node_modules/.package-lock.json. sync.sh keeps it in memory from the
# baseline install, before Claude runs. Fails when there is none.
root_deps_tree() {
  if [ ! -s node_modules/.package-lock.json ]; then echo "root_deps_tree: no node_modules/.package-lock.json" >&2; return 1; fi
  cat node_modules/.package-lock.json
}

# clean_sync_worktree <worktree>: delete every untracked and ignored file in
# the sync worktree (git clean -ffdx), so nothing Claude left there (a project
# .npmrc, a stray spec the custom-tests glob would pick up, a patched
# node_modules) steers the reinstall or the tests. Nothing in the worktree
# needs keeping: the logs, reports and state live in STATE_DIR outside it, the
# baseline dependency tree and merge snapshot are in sync.sh's memory, and both
# node_modules are installed again right after. Refuses unless the current
# directory is the top of <worktree>, so it never runs in the live checkout.
clean_sync_worktree() {
  local top want
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  want="$(cd "$1" 2>/dev/null && pwd -P)" || { echo "clean_sync_worktree: no worktree at $1" >&2; return 1; }
  if [ "$(cd "$top" && pwd -P)" != "$want" ]; then
    echo "clean_sync_worktree: $top is not the sync worktree $1; nothing cleaned" >&2
    return 1
  fi
  git clean -ffdxq
}

# refresh_root_deps <base-rev> <base-tree>: after Claude, delete the root
# node_modules and install again (no lifecycle scripts). Claude may run npm and
# write inside the gitignored node_modules, so the post-merge tests only run on
# a tree installed after it exited. When the merge left the root dependencies
# as at <base-rev>, the tree installed is exactly <base-tree> (root_deps_tree
# from the baseline install), through a temporary lockfile and npm ci: upstream
# tracks no root lockfile, and a fresh resolve could pick newer versions than
# the baseline ran with and blame that drift on the merge. Only a merge that
# changed them resolves fresh. A tracked lockfile is always installed with
# npm ci. Fails when any step fails, or when the tree is needed and empty.
refresh_root_deps() {
  local before after rc=0
  rm -rf node_modules || return 1
  if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    echo "reinstalling the root dependencies from the tracked lockfile"
    npm ci --ignore-scripts --silent
    return
  fi
  before="$(deps_fingerprint "$1")" || return 1
  after="$(deps_fingerprint HEAD)" || return 1
  if [ "$before" != "$after" ]; then
    echo "root dependencies changed in the merge; resolving them fresh"
    install_root_deps ignore-scripts
    return
  fi
  if [ -z "${2:-}" ]; then echo "refresh_root_deps: no baseline dependency tree to reinstall" >&2; return 1; fi
  echo "root dependencies unchanged by the merge; reinstalling the baseline's exact tree"
  printf '%s\n' "$2" > package-lock.json || return 1
  npm ci --ignore-scripts --silent || rc=$?
  rm -f package-lock.json
  return "$rc"
}

# ensure_playwright_browser: install the Chromium that the installed Playwright
# expects, the one thing the root postinstall (`npx playwright install
# chromium`) does that the sync's --ignore-scripts installs skip. Nothing else's
# lifecycle scripts run: this is Playwright's own CLI, the same package code the
# PDF specs run anyway, and it downloads only when that revision is missing
# from the shared browser cache. No-op without Playwright installed; fails when
# the browser cannot be installed, so a Playwright bump never reads as failing
# PDF tests that the merge caused.
ensure_playwright_browser() {
  local version
  [ -f node_modules/playwright/package.json ] || return 0
  version="$(node -p 'require("./node_modules/playwright/package.json").version')" || return 1
  if ! npx --no-install playwright install chromium; then
    echo "ensure_playwright_browser: cannot install Chromium for Playwright $version" >&2
    return 1
  fi
}

# control_center_checks <log>: install custom/control-center from its tracked
# lockfile with npm ci, which deletes any node_modules Claude left (no
# lifecycle scripts), then run its vitest suite (which holds the contract test
# against upstream's CLIs) and its typecheck, all output to <log>.
# Fails at the first failing step, and when no test ran at all. Colors are off
# whatever the caller exports, since escapes would split the summary grepped.
control_center_checks() {
  local log="$1"
  (
    unset FORCE_COLOR
    export NO_COLOR=1
    npm --prefix custom/control-center ci --ignore-scripts --no-audit --no-fund &&
      npm --prefix custom/control-center test &&
      npm --prefix custom/control-center run typecheck
  ) > "$log" 2>&1 || return 1
  grep -qE 'Tests[[:space:]]+[1-9][0-9]* passed' "$log"
}

# custom_tests <log>: run the fork's custom/*/tests specs (from the repo root),
# all output to <log>. Fails when a test fails, and when no test passed at all.
# Node 22 prints TAP ("# pass N") when output is not a TTY and Node 23+ the spec
# reporter ("ℹ pass N"), so either summary counts.
custom_tests() {
  local log="$1" words=() kept=() w next="" reporter=""
  # A reporter chosen in the caller's NODE_OPTIONS other than spec or tap (dot, junit...), or a destination sending the
  # report elsewhere, prints neither summary below: those flags are dropped, everything else is kept. Only the first
  # spec or tap reporter stays, since node --test refuses several reporters without a destination for each.
  read -ra words <<<"${NODE_OPTIONS:-}"
  for w in ${words[@]+"${words[@]}"}; do
    if [ -n "$next" ]; then
      if [ "$next" = reporter ] && [ -z "$reporter" ]; then case "$w" in spec | tap) reporter="--test-reporter=$w" ;; esac; fi
      next=""
      continue
    fi
    case "$w" in
      --test-reporter=spec | --test-reporter=tap) [ -n "$reporter" ] || reporter="$w" ;;
      --test-reporter=* | --test-reporter-destination=*) ;;
      --test-reporter) next=reporter ;;
      --test-reporter-destination) next=destination ;;
      *) kept+=("$w") ;;
    esac
  done
  [ -z "$reporter" ] || kept+=("$reporter")
  # FORCE_COLOR (even empty) would color the summary and split the line grepped below.
  (unset FORCE_COLOR && NODE_OPTIONS="${kept[*]-}" node --test custom/*/tests/*.spec.mjs) > "$log" 2>&1 || return 1
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

# changed_since_snapshot <snapshot>: every path whose content, mode or
# presence at HEAD differs from the merge_snapshot text <snapshot>: what this
# run changed after the merge. A fork difference from upstream kept by an
# earlier sync is in both, so it is not here. unexpected_upstream and
# protected_paths each take their share of it. Fails closed: an empty snapshot
# or an unreadable HEAD is an error, never "nothing changed".
changed_since_snapshot() {
  local tree
  if [ -z "${1:-}" ]; then echo "changed_since_snapshot: no merge snapshot to compare with" >&2; return 1; fi
  tree="$(git ls-tree -r HEAD)" || return 1
  printf '%s\n' "$tree" | awk -F'\t' '$2 != "" { split($1, m, " "); print $2 "\t" m[1] " " m[3] }' | LC_ALL=C sort |
    LC_ALL=C comm -3 <(printf '%s\n' "$1") - | sed -e 's/^\t//' | cut -f1 |
    awk '$0 != ""' | LC_ALL=C sort -u
}

# unexpected_upstream <changed> <conflicts>: the upstream files (one per line,
# outside custom/ and .github/README.md) in <changed> that are not in
# <conflicts>. Upstream files may only be edited to
# resolve a merge conflict, so any of these holds the PR for a human.
unexpected_upstream() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in custom/* | .github/README.md) continue ;; esac
    printf '%s\n' "$2" | grep -qxF -- "$f" || printf '%s\n' "$f"
  done <<< "$1"
}

# suite_failures <file>: upstream suite failures, one stable line per failing
# test, written to <file>. A run that never prints its final "Results:" summary
# crashed; that is recorded as a failure line of its own so it can never read as
# "no failures".
suite_failures() {
  # A list from an earlier run of the same day must never be read as this one's.
  rm -f "$1"
  local out="$1.raw"
  node test-all.mjs --quick > "$out" 2>&1
  local code=$?
  # Only test-all's own closing line counts as a summary: a failing child suite's stdout, echoed into its failure
  # message, carries an indented "Results:" of its own. test-all runs each node:test suite as a child and reports a
  # failing one as "❌ <suite> — node:test suite failed (exit N)", echoing only the last 12 lines of its output, which
  # often name no test. So each such suite is run again here (rerun_failing_tests) and every failing test is recorded
  # under it, the same way for the baseline and the merged tree, so a new failure in an already-red suite shows. The
  # "plus failures in a discovered node:test suite" suffix comes from process.exitCode, which any imported module can
  # set: with no failing node:test suite listed it is a crash, recorded with this run's path so it never matches a
  # baseline. A non-zero exit with no failure at all is a crash too.
  local named="" suite names
  while IFS= read -r suite; do
    [ -n "$suite" ] || continue
    names="$(rerun_failing_tests "$suite")"
    local rerun_rc=$?
    case "$rerun_rc" in
      129 | 130 | 143)
        # The re-run was interrupted by a hangup, Ctrl-C or a stop (launchd stopping the job): say so, write no list,
        # and send the same signal to this shell; if that signal is ignored, return it, and sync.sh's
        # `|| fail "upstream suite run was interrupted"` ends the run.
        echo "!!! upstream suite run interrupted"
        if declare -F notify >/dev/null; then notify "upstream suite run interrupted"; fi
        kill -s "$(kill -l "$rerun_rc")" $$
        return "$rerun_rc"
        ;;
      0) ;;
      *)
        # The wrapper itself crashed (killed, out of memory): unique to this run, so it holds the PR.
        named="${named:+$named$'\n'}❌ $suite — node:test suite failed, re-run crashed (exit $rerun_rc; see $out)"
        continue
        ;;
    esac
    if printf '%s\n' "$names" | grep -qxF '::rerun timed out::'; then
      # A slow suite may hide a new failure behind its baseline: unique to this run, so it holds the PR.
      named="${named:+$named$'\n'}❌ $suite — node:test suite failed, re-run timed out (see $out)"
    elif [ -n "$names" ]; then
      named="${named:+$named$'\n'}$(printf '%s\n' "$names" | sed "s|^|❌ $suite — node:test ✖ |")"
    else
      # Fixed, not tied to this run: a known-red suite that finished naming no test (it does not load) must not
      # hold every sync. A suite that is new in the merged run is still caught by its own "❌ ... suite failed" line.
      named="${named:+$named$'\n'}❌ $suite — node:test suite failed, no test named on re-run"
    fi
  done < <(sed -nE 's/^[[:space:]]*❌ (.*) — node:test suite failed \(exit [^)]*\)$/\1/p' "$out" | LC_ALL=C sort -u)
  {
    grep -E '^\s*❌' "$out" | sed -E 's/^[[:space:]]+//'
    [ -z "$named" ] || printf '%s\n' "$named"
    if ! grep -qE '^📊 Results: [0-9]+ passed' "$out"; then
      echo "SUITE CRASHED (exit $code, no Results summary; see $out)"
    elif grep -qE '^📊 Results: .* plus failures in a discovered node:test suite' "$out" &&
      ! grep -qE '^[[:space:]]*❌ .* — node:test suite failed \(exit [^)]*\)$' "$out"; then
      echo "SUITE CRASHED (exit $code, test-all reports node:test failures but lists no failing node:test suite; see $out)"
    elif [ "$code" != 0 ] && ! grep -qE '^\s*❌' "$out"; then
      echo "SUITE CRASHED (exit $code, but no failing test listed; see $out)"
    fi
  } | sort -u > "$1"
}

# rerun_failing_tests <suite>: the names of the failing tests in one node:test
# suite, run again from the current directory with the TAP reporter (every
# `not ok N - name`, nested ones included, numbers and directives dropped),
# sorted. Bounded by SUITE_RERUN_TIMEOUT_MS (default 120000): the run is
# started in its own process group and the whole group is killed at the
# deadline (or when this process is interrupted), so the per-file test process
# never outlives it. Prints the line "::rerun timed out::" when the deadline
# hit; nothing when the run finished naming no failing test (a suite that does
# not load reports only its file) or could not start.
rerun_failing_tests() {
  SUITE="$1" node -e '
const { spawn } = require("child_process");
const path = require("path");
const suite = process.env.SUITE;
const TIMED_OUT = "::rerun timed out::";
const env = { ...process.env, NODE_OPTIONS: (process.env.NODE_OPTIONS || "").replace(/--test-reporter(-destination)?[= ]\S+/g, "") };
delete env.SUITE;
let child = null;
let out = "";
let timedOut = false;
const killGroup = () => { if (child) try { process.kill(-child.pid, "SIGKILL"); } catch {} };
// Set before the run starts, so no signal can arrive while the detached group exists without them. The group is
// detached from the sync, so an interrupted sync (Ctrl-C, launchd stopping the job) takes it down here; this process
// then dies of the same signal, or exits 128 + its number when that signal is ignored (nohup, a background job).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    const status = 128 + require("os").constants.signals[sig];
    if (!child) process.exit(status);
    killGroup();
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
    process.exit(status);
  });
}
child = spawn(process.execPath, ["--test", "--test-reporter=tap", suite], { env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
child.stdout.setEncoding("utf8").on("data", (d) => { out += d; });
const timer = setTimeout(() => {
  timedOut = true;
  killGroup();
}, Number(process.env.SUITE_RERUN_TIMEOUT_MS || 120000));
child.on("error", () => { clearTimeout(timer); process.exit(0); });
child.on("close", () => {
  clearTimeout(timer);
  // A run that ended on its own can still leave a stray process in its group.
  killGroup();
  if (timedOut) {
    process.stdout.write(TIMED_OUT + "\n");
    process.exit(0);
  }
  const names = new Set();
  for (const line of out.split("\n")) {
    const m = /^\s*not ok \d+ - (.*?)(?: # .*)?$/.exec(line);
    // A suite that does not load is reported as one failing "test" named after its file: that names no test.
    if (m && m[1] !== suite && m[1] !== path.resolve(suite)) names.add(m[1]);
  }
  process.stdout.write([...names].sort().map((n) => n + "\n").join(""));
});
' 2>/dev/null | LC_ALL=C sort -u
  local rc=("${PIPESTATUS[@]}")
  return "${rc[0]}"
}

# new_failures <baseline-text> <after-file>: the lines of <after-file> that are
# not in <baseline-text>, both as suite_failures wrote them (sorted). The
# baseline is text that sync.sh read before Claude ran, never a file Claude
# could rewrite. Fails closed: an unreadable <after-file> is an error, not
# "no new failures".
new_failures() {
  if [ ! -r "$2" ]; then echo "new_failures: cannot read $2" >&2; return 1; fi
  comm -13 <(printf '%s\n' "$1" | sed '/^$/d') "$2"
}

# protected_paths <changed>: the paths (one per line) in <changed> that the
# sync must never change on its own: the fork's tests and test helpers, the
# sync's own gates, the guard and the other paths Dev Chat may not write
# (DEVCHAT_DENIED_WRITES in custom/control-center/server/claude/modes.ts, kept
# in step by sync-gates.spec), everything under server/core but contract.json
# (the guard reads the contract through adapter.ts; contract.json itself is
# section-gated by contract_gate_edits), and the fork README. The sync Claude may fix
# other fork code under custom/; those fixes are judged by the protected tests,
# so an edit to a test, a gate or the guard holds the PR for a human.
protected_paths() {
  local f
  while IFS= read -r f; do
    case "$f" in
      # Section-gated by contract_gate_edits instead: its clis, exports and writers follow upstream.
      custom/control-center/server/core/contract.json) ;;
      custom/control-center/server/claude/* | custom/control-center/supervisor/* | \
        custom/control-center/server/core/* | \
        custom/control-center/package.json | custom/control-center/package-lock.json | \
        custom/control-center/vite.config.* | custom/control-center/vitest.config.* | custom/control-center/playwright.config.* | \
        custom/control-center/eslint.config.* | custom/control-center/tsconfig*.json | \
        custom/control-center/tests/* | custom/control-center/scripts/* | \
        custom/immigration/run-daily.sh | custom/immigration/daily-prompt.md | \
        custom/*/tests/* | custom/*.spec.* | custom/*.test.* | \
        custom/test-support/* | custom/install/* | custom/upstream-sync/* | custom/launchd/* | \
        .github/README.md)
        printf '%s\n' "$f" ;;
    esac
  done <<< "$1"
}

# contract_gate_edits <snapshot>: custom/control-center/server/core/contract.json
# when this run changed its confinement gate data: the `claude` section (the
# Claude Code versions approved to run unattended, the flags the confinement
# relies on) or `playwrightMcp` (whether apply sessions get Playwright). The
# other sections follow upstream's CLIs and exports, which the sync Claude may
# update. Compared with the merge snapshot (merge_snapshot text <snapshot>); a
# file added, removed or not parseable on either side counts as changed.
contract_gate_edits() {
  local f=custom/control-center/server/core/contract.json before after same
  before="$(printf '%s\n' "$1" | awk -F'\t' -v f="$f" '$1 == f { split($2, m, " "); print m[2] }')"
  after="$(git rev-parse --verify --quiet "HEAD:$f")"
  [ "$before" = "$after" ] && return 0
  if [ -n "$before" ] && [ -n "$after" ] && same="$(node -e '
const { execFileSync } = require("child_process");
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const gate = (sha) => { const c = JSON.parse(execFileSync("git", ["cat-file", "blob", sha], { encoding: "utf8" })); return JSON.stringify(sorted([c.claude ?? null, c.playwrightMcp ?? null])); };
process.stdout.write(gate(process.argv[1]) === gate(process.argv[2]) ? "same" : "changed");
' "$before" "$after" 2>/dev/null)" && [ "$same" = same ]; then
    return 0
  fi
  printf '%s\n' "$f"
}

# sync_verdict <claude-exit> <claude-output>: why the sync Claude's own run
# holds the PR, or nothing. The prompt asks it to end with `SYNC: ok` or
# `SYNC: needs-human <reason>`; the last such line counts. A non-zero exit, no
# verdict line, or an unknown one holds the PR too.
sync_verdict() {
  local verdict
  if [ "$1" != 0 ]; then printf 'the sync Claude exited %s' "$1"; return 0; fi
  verdict="$(printf '%s\n' "$2" | grep -E '^SYNC: ' | tail -n 1 | sed -E 's/[[:space:]]+$//')"
  case "$verdict" in
    'SYNC: ok') ;;
    'SYNC: needs-human '?*) printf 'the sync Claude asked for a human: %s' "${verdict#SYNC: needs-human }" ;;
    '') printf 'the sync Claude gave no SYNC verdict' ;;
    *) printf 'the sync Claude gave an unknown verdict: %s' "$verdict" ;;
  esac
}

# main_moved <base-rev>: why the sync PR must not merge because the fork's main
# is no longer <base-rev>, the commit every gate compared with, or nothing.
# Fetches origin's main first: GitHub would merge the branch into whatever main
# is now, a combination nothing tested. A failed fetch holds the PR too.
main_moved() {
  local now
  if ! fetch_main origin; then
    printf 'cannot confirm origin/main is still the commit the sync tested (the fetch failed)'
    return 0
  fi
  now="$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}')"
  [ -n "$1" ] && [ "$now" = "$1" ] && return 0
  printf 'origin/main moved during the sync (tested %s, now %s); re-run the sync' "${1:0:12}" "${now:0:12}"
}

# merged_onto <merge-commit> <base-rev>: after gh pr merge, why the merge must
# not reach the live checkout, or nothing. GitHub merges onto whatever main is at
# that moment, so a PR merged between main_moved and the merge leaves a merge
# commit whose first parent is not <base-rev>: a combination nothing tested. A
# merge commit that cannot be read or found on origin/main counts the same.
merged_onto() {
  local parent
  if [ -z "$1" ]; then printf 'cannot read the merge commit of the sync PR'; return 0; fi
  if ! fetch_main origin; then printf 'cannot fetch origin/main to check the merge'; return 0; fi
  if ! git merge-base --is-ancestor "$1" refs/remotes/origin/main 2>/dev/null ||
    ! parent="$(git rev-parse --verify --quiet "$1^1")"; then
    printf 'the merge commit %s of the sync PR is not on origin/main' "${1:0:12}"
    return 0
  fi
  [ "$parent" = "$2" ] || printf 'the sync PR was merged onto %s, not the tested %s' "${parent:0:12}" "${2:0:12}"
}

# merge_blockers: why the sync PR must wait for a human, as one line of reasons
# joined by "; ", or nothing when it may auto-merge. Reads CUSTOM_OK, CC_OK,
# AUTO_MERGE and KEPT_README (an unset flag blocks), NEW_FAILURES and
# UNEXPECTED_UPSTREAM and PROTECTED_EDITS (one entry per line), CLAUDE_HOLD (sync_verdict's
# reason; unset blocks, since the verdict was never read) and MAIN_MOVED (main_moved's
# reason; unset blocks, since origin/main was never checked).
merge_blockers() {
  local why=() out="" w
  [ "${CUSTOM_OK:-0}" = 1 ] || why+=("custom tests FAIL")
  [ "${CC_OK:-0}" = 1 ] || why+=("control-center tests and typecheck FAIL")
  [ -z "${NEW_FAILURES:-}" ] || why+=("new upstream-suite failures: ${NEW_FAILURES//$'\n'/, }")
  [ "${AUTO_MERGE:-0}" = 1 ] || why+=("run with --no-merge")
  [ "${KEPT_README:-1}" = 0 ] || why+=("fork README kept over an upstream .github/README.md (compare by hand)")
  [ -z "${UNEXPECTED_UPSTREAM:-}" ] || why+=("upstream files edited outside conflict resolution: ${UNEXPECTED_UPSTREAM//$'\n'/, }")
  [ -z "${PROTECTED_EDITS:-}" ] || why+=("fork tests, gates or guard files edited by the sync (review by hand): ${PROTECTED_EDITS//$'\n'/, }")
  if [ -z "${CLAUDE_HOLD+set}" ]; then why+=("the sync Claude verdict was never read"); elif [ -n "$CLAUDE_HOLD" ]; then why+=("$CLAUDE_HOLD"); fi
  if [ -z "${MAIN_MOVED+set}" ]; then why+=("whether origin/main moved during the sync was never checked"); elif [ -n "$MAIN_MOVED" ]; then why+=("$MAIN_MOVED"); fi
  for w in ${why[@]+"${why[@]}"}; do out="${out:+$out; }$w"; done
  printf '%s' "$out"
}

# update_live_checkout <daily-lock> <wait-seconds> <commit>: after the sync PR
# merged, bring the live checkout (the current directory) up to <commit>, the
# sync PR's verified merge commit (never a later origin/main, which this run did
# not test): fetch, then fast-forward only when it is on main with no tracked
# local changes. Then reinstall what the merge changed, as a user's own install would:
# the root dependencies (lifecycle scripts included) when deps_fingerprint
# changed, and the Control Center's (npm ci) when its tracked lockfile changed,
# since bin/cc only checks that its node_modules exists. All of it runs holding
# <daily-lock>, the lock run-daily.sh holds for its whole run, so scripts and
# node_modules never change under a running daily job; it waits up to
# <wait-seconds> for that run to end. Prints one line saying what happened.
# Returns 0 when updated, 3 when updated but an install failed, 10 when left
# alone (not on main, local changes, or the daily job still running), 1 when
# the arguments, the fetch, the fingerprint or the fast-forward failed.
update_live_checkout() {
  local deps_before cc_before failed="" rc
  if [ -z "${CC_LIVE_UPDATE_LOCKED:-}" ]; then
    if [ -z "${1:-}" ] || ! [[ "${2:-}" =~ ^[0-9]+$ ]] || [ -z "${3:-}" ]; then
      echo "update_live_checkout: needs the daily job's lock file, a wait in seconds and the commit to move to"
      return 1
    fi
    mkdir -p "$(dirname "$1")" || { echo "cannot create the folder of the daily job's lock $1"; return 1; }
    # -k keeps the file, as run-daily.sh does, so both lock the same inode; lockf exits 75 when the wait runs out.
    CC_LIVE_UPDATE_LOCKED=1 /usr/bin/lockf -k -t "$2" "$1" /bin/bash -c 'source "$1" && update_live_checkout "" "" "$2"' update_live_checkout "${BASH_SOURCE[0]}" "$3"
    rc=$?
    if [ "$rc" = 75 ]; then echo "the daily job is still running"; return 10; fi
    return "$rc"
  fi
  fetch_main origin || { echo "cannot refresh origin/main after the merge"; return 1; }
  if [ "$(git rev-parse --abbrev-ref HEAD)" != main ]; then echo "the live checkout is not on main"; return 10; fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "the live checkout has local changes"; return 10; fi
  deps_before="$(deps_fingerprint HEAD)" || { echo "cannot read the live checkout's dependency files"; return 1; }
  cc_before="$(git rev-parse --verify --quiet HEAD:custom/control-center/package-lock.json)"
  git merge -q --ff-only "$3" || { echo "live checkout could not fast-forward"; return 1; }
  if [ "$deps_before" != "$(deps_fingerprint HEAD)" ] && ! install_root_deps run-scripts >/dev/null 2>&1; then
    failed="npm install"
  fi
  if [ "$cc_before" != "$(git rev-parse --verify --quiet HEAD:custom/control-center/package-lock.json)" ] &&
    ! npm --prefix custom/control-center ci >/dev/null 2>&1; then
    failed="${failed:+$failed and }npm --prefix custom/control-center ci"
  fi
  if [ -n "$failed" ]; then
    echo "live checkout now at $(git rev-parse --short HEAD), but $failed failed; run it by hand"
    return 3
  fi
  echo "live checkout now at $(git rev-parse --short HEAD)"
}
