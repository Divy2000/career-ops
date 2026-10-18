#!/usr/bin/env bash
# One entry point for the fork's quality gates. Static gates first (typecheck, eslint with the type-aware rules,
# no-em-dash, shellcheck, semgrep rule tests and scan), then the test suites (Control Center vitest, custom node tests).
# Every gate runs even when an earlier one fails, so one run reports all of them; the exit status is 1 when any failed.
#
#   custom/scripts/gates.sh            all gates
#   custom/scripts/gates.sh --static   static gates only (fast; the bug-hunt finders' pre-gate)
#
# Needs Node 22+ first on PATH, shellcheck on PATH, and semgrep on PATH or at $SEMGREP (default: the venv under
# ~/.local/share/semgrep-venv). Run from anywhere.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CC="$ROOT/custom/control-center"
SEMGREP_RULES="custom/.semgrep/career-ops.yml"

STATIC_ONLY=0
case "${1:-}" in
  "") ;;
  --static) STATIC_ONLY=1 ;;
  -h | --help)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "gates.sh: unknown argument: $1 (expected --static or nothing)" >&2
    exit 2
    ;;
esac

cd "$ROOT" || { echo "gates.sh: cannot cd to $ROOT" >&2; exit 2; }

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ]; then
  echo "gates.sh: Node 22 or newer must be first on PATH (found: $(command -v node || echo none), major $node_major)" >&2
  exit 2
fi

SEMGREP="${SEMGREP:-$(command -v semgrep || echo "$HOME/.local/share/semgrep-venv/bin/semgrep")}"

failed=()
step=0
total=5
[ "$STATIC_ONLY" = 1 ] || total=7

# run_gate <name> <command...>: prints a header, runs the command, records a failure.
run_gate() {
  local name="$1"
  shift
  step=$((step + 1))
  printf '\n==> [%d/%d] %s\n' "$step" "$total" "$name"
  local started=$SECONDS
  if "$@"; then
    printf -- '--> %s: ok (%ss)\n' "$name" "$((SECONDS - started))"
  else
    printf -- '--> %s: FAILED (%ss)\n' "$name" "$((SECONDS - started))"
    failed+=("$name")
  fi
}

typecheck() { npm --prefix "$CC" run --silent typecheck; }
eslint_gate() { (cd "$CC" && npx --no-install eslint .); }
no_em_dash() { node "$CC/scripts/no-em-dash.mjs"; }
shellcheck_gate() { "$ROOT/custom/scripts/shellcheck.sh"; }

semgrep_gate() {
  if [ ! -x "$SEMGREP" ]; then
    echo "semgrep not found (set SEMGREP or put it on PATH)" >&2
    return 1
  fi
  local flags=(--metrics=off --disable-version-check)
  local t
  # semgrep --test skips rule files in dot folders, so each rule test file is paired with the rules explicitly.
  for t in custom/.semgrep/tests/career-ops.*; do
    "$SEMGREP" --test "${flags[@]}" --config "$SEMGREP_RULES" "$t" || return 1
  done
  # --timeout 0: a per-file timeout is reported as a warning and would let a big file pass unscanned.
  "$SEMGREP" scan "${flags[@]}" --error --quiet --timeout 0 --config "$SEMGREP_RULES" --exclude custom/.semgrep/tests custom
}

vitest_gate() { (cd "$CC" && npx --no-install vitest run); }
node_tests() { node --test custom/*/tests/*.spec.mjs; }

run_gate typecheck typecheck
run_gate eslint eslint_gate
run_gate no-em-dash no_em_dash
run_gate shellcheck shellcheck_gate
run_gate semgrep semgrep_gate
if [ "$STATIC_ONLY" = 0 ]; then
  run_gate "control-center vitest" vitest_gate
  run_gate "custom node tests" node_tests
fi

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "gates: FAILED: ${failed[*]}"
  exit 1
fi
echo "gates: all passed"
