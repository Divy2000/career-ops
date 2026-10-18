#!/usr/bin/env bash
# Runs shellcheck (info and worse, so unquoted expansions (SC2086) fail too) over every shell script under custom/: *.sh files and any file whose
# shebang names sh or bash, tracked or new but not gitignored. Runs from the repo root so `# shellcheck source=custom/...`
# directives resolve. Settings: custom/.shellcheckrc.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck not found on PATH (macOS: brew install shellcheck)" >&2
  exit 2
fi

scripts=()
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    *.sh) scripts+=("$file"); continue ;;
  esac
  first="$(head -n 1 -- "$file" | LC_ALL=C tr -d '\000')"
  if [[ "$first" =~ ^\#!.*(/|[[:space:]])(ba)?sh([[:space:]]|$) ]]; then scripts+=("$file"); fi
done < <(git ls-files -z --cached --others --exclude-standard -- custom)

if [ "${#scripts[@]}" -eq 0 ]; then
  echo "shellcheck: no shell scripts found under custom/" >&2
  exit 2
fi

shellcheck --rcfile custom/.shellcheckrc --severity=info --format=gcc -- "${scripts[@]}"
echo "shellcheck: ok (${#scripts[@]} scripts)"
