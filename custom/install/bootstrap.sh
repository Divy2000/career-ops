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

  # A repository URL as shown: an https://user:token@host URL loses its userinfo, which can hold a credential (the same
  # rule as redact_url in install.sh). The userinfo runs to the last @ before the first / (a raw @ in a password
  # included). Only what is printed is redacted; git clone gets the URL as given.
  redact_url() { printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@#\1#'; }

  # A --dir value as install.sh's abspath reads it (~ and ~/ are home, a relative path is under the current folder), so
  # both scripts name one checkout even when the shell left a quoted ~ alone.
  abspath() {
    local p="$1"
    # shellcheck disable=SC2088 # the patterns match a literal "~" argument; nothing is meant to expand
    case "$p" in
      "~") p="$HOME" ;;
      "~/"*) p="$HOME/${p#"~/"}" ;;
    esac
    case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
    while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
    printf '%s' "$p"
  }

  local repo="${CAREER_OPS_REPO_URL:-https://github.com/Divy2000/career-ops.git}"
  local ref="${CAREER_OPS_INSTALL_REF:-fork-install-v3}"
  local tty_dev="${CAREER_OPS_INSTALL_TTY:-/dev/tty}"
  local dir="$HOME/career-ops" args=("$@") i answer=""

  for ((i = 0; i < ${#args[@]}; i++)); do
    [ "${args[$i]}" = "--dir" ] || continue
    # Refused as install.sh's value_of refuses it, before anything is cloned.
    if [ $((i + 1)) -ge ${#args[@]} ] || [ -z "${args[$((i + 1))]}" ] || [ "${args[$((i + 1))]#--}" != "${args[$((i + 1))]}" ]; then
      printf 'error: --dir needs a value\nRun install.sh --help for the options.\n' >&2
      return 2
    fi
    dir="$(abspath "${args[$((i + 1))]}")"
    args[$((i + 1))]="$dir"
  done

  # An existing checkout's own installer runs instead of a fresh clone: checked before the confirm, so the gate never
  # describes a run of another repository's files (or of none).
  local existing=0 origin
  if [ -e "$dir/.git" ]; then
    existing=1
    origin="$(git -C "$dir" remote get-url origin 2>/dev/null)" || origin=""
    if [ "$(norm_repo "$origin")" != "$(norm_repo "$repo")" ]; then
      echo "error: origin of $dir is $(redact_url "${origin:-unset}"), not the fork $(redact_url "$repo"). Pick another --dir, or fix the remote." >&2
      return 1
    fi
    if [ ! -f "$dir/custom/install/install.sh" ]; then
      echo "error: the existing checkout at $dir has no custom/install/install.sh. Pick another --dir, or update it to $ref." >&2
      return 1
    fi
  fi

  echo "career-ops (H-1B-aware fork) bootstrap"
  echo "  repository: $(redact_url "$repo")"
  echo "  pinned tag: $ref"
  if [ "$existing" = 1 ]; then
    echo "  use:        the existing checkout at $dir and its own installer (checked out: $(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)), not the pinned tag"
  else
    echo "  clone into: $dir"
  fi
  echo "  then run:   custom/install/install.sh ${args[*]:-}"
  echo "Nothing has been downloaded yet. The installer asks before each system change."

  if ! { : <"$tty_dev"; } 2>/dev/null; then
    echo "error: this needs a terminal to confirm. Download the script, read it, and run it yourself, or: git clone $(redact_url "$repo") && bash career-ops/custom/install/install.sh" >&2
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
