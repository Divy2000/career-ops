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
# lockfile. control-center has its own tracked lockfile and is not installed here.
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
