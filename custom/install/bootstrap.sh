#!/usr/bin/env bash
# Convenience entry for the fork installer: clones a pinned tag of Divy2000/career-ops, then runs
# custom/install/install.sh from that clone with your arguments. Read it before you run it; the safest
# route is `git clone` plus `bash custom/install/install.sh` yourself.
# The whole body is one function called on the last line, so a truncated download executes nothing.
set -euo pipefail

main() {
  # The comparable form of a repository URL (the same rule as normalizeRepoUrl in lib.mjs; node may not be installed yet).
  norm_repo() {
    printf '%s' "$1" | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e 's#^git@([^:]+):#\1/#' -e 's#^[a-zA-Z+]+://##' \
      -e 's#^[^@/]+@##' -e 's#/+$##' -e 's#\.git$##' | tr '[:upper:]' '[:lower:]'
  }

  local repo="${CAREER_OPS_REPO_URL:-https://github.com/Divy2000/career-ops.git}"
  local ref="${CAREER_OPS_INSTALL_REF:-fork-install-v3}"
  local tty_dev="${CAREER_OPS_INSTALL_TTY:-/dev/tty}"
  local dir="$HOME/career-ops" args=("$@") i answer=""

  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "--dir" ] && [ $((i + 1)) -lt ${#args[@]} ]; then dir="${args[$((i + 1))]}"; fi
  done

  # An existing checkout's own installer runs instead of a fresh clone: checked before the confirm, so the gate never
  # describes a run of another repository's files (or of none).
  local existing=0 origin
  if [ -e "$dir/.git" ]; then
    existing=1
    origin="$(git -C "$dir" remote get-url origin 2>/dev/null)" || origin=""
    if [ "$(norm_repo "$origin")" != "$(norm_repo "$repo")" ]; then
      echo "error: origin of $dir is ${origin:-unset}, not the fork $repo. Pick another --dir, or fix the remote." >&2
      return 1
    fi
    if [ ! -f "$dir/custom/install/install.sh" ]; then
      echo "error: the existing checkout at $dir has no custom/install/install.sh. Pick another --dir, or update it to $ref." >&2
      return 1
    fi
  fi

  echo "career-ops (H-1B-aware fork) bootstrap"
  echo "  repository: $repo"
  echo "  pinned tag: $ref"
  if [ "$existing" = 1 ]; then
    echo "  use:        the existing checkout at $dir and its own installer (checked out: $(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)), not the pinned tag"
  else
    echo "  clone into: $dir"
  fi
  echo "  then run:   custom/install/install.sh ${args[*]:-}"
  echo "Nothing has been downloaded yet. The installer asks before each system change."

  if ! { : <"$tty_dev"; } 2>/dev/null; then
    echo "error: this needs a terminal to confirm. Download the script, read it, and run it yourself, or: git clone $repo && bash career-ops/custom/install/install.sh" >&2
    return 1
  fi
  printf 'Continue? [y/N] ' >&2
  IFS= read -r answer <"$tty_dev" || answer=""
  case "$answer" in
    [yY] | [yY][eE][sS]) ;;
    *) echo "Aborted. Nothing was downloaded." >&2; return 1 ;;
  esac

  if [ "$existing" = 1 ]; then
    echo "Using the existing checkout at $dir."
  else
    git clone --branch "$ref" "$repo" "$dir"
  fi
  exec bash "$dir/custom/install/install.sh" ${args[@]+"${args[@]}"} <"$tty_dev"
}

main "$@"
