#!/bin/bash
# Install (or reinstall) the fork's launchd jobs for this checkout.
#   daily  08:00  custom/immigration/run-daily.sh   policy watch, scan, rank, shortlist
#   weekly Sun 03:00 custom/upstream-sync/sync.sh   merge upstream main into the fork
# /bin/bash needs Full Disk Access when the checkout lives under ~/Desktop or ~/Documents.
# Usage: install.sh [--jobs daily|all]   (default all; "daily" skips the weekly sync, which only the fork maintainer needs)
set -euo pipefail
JOBS=all
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jobs)
      [ "$#" -ge 2 ] || { echo "error: --jobs needs daily or all" >&2; exit 2; }
      JOBS="$2"
      shift
      ;;
    *) echo "error: unknown option $1 (usage: install.sh [--jobs daily|all])" >&2; exit 2 ;;
  esac
  shift
done
case "$JOBS" in daily | all) ;; *) echo "error: --jobs must be daily or all (got $JOBS)" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
# The data root, resolved exactly as the jobs resolve it (CAREER_OPS_ROOT, else the .career-ops-data marker, else the checkout).
# It fixes the launchd log paths now. It is written into the plist only when it came from the environment, which launchd
# would not otherwise see; a marker is read by the job itself at run time, so changing the marker later still works.
# The launchd log paths (StandardOutPath/StandardErrorPath) are fixed in the plist now: after moving the marker, rerun this
# script to point them at the new root.
DATA="$(cd "$ROOT" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")"
mkdir -p "$AGENTS" "$DATA/data/immigration/logs"
if [ "$JOBS" = all ]; then mkdir -p "$DATA/data/upstream-sync"; fi
trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }
ENV_ROOT=0
if [ -n "$(trim "${CAREER_OPS_ROOT:-}")" ] || [ -n "$(trim "${CAREER_OPS_DATA_DIR:-}")" ]; then ENV_ROOT=1; fi
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# The claude the daily job runs, pinned as CC_CLAUDE_BIN: launchd's own PATH could reach another install first (an old
# one in /usr/local/bin, say), and the job would then skip its Claude steps every day. CC_CLAUDE_BIN (absolute) wins,
# else the first claude on this shell's PATH, else ~/.local/bin/claude (the native installer). PATH is walked in order
# and relative entries (an empty one included) are skipped, not taken as the end of the search, the way the app's
# claudeCandidates picks. It is checked against the approved versions now, so a mismatch is reported here and not only
# in tomorrow's log.
CLAUDE_BIN=""
if [ -n "${CC_CLAUDE_BIN:-}" ]; then
  case "$CC_CLAUDE_BIN" in /*) CLAUDE_BIN="$CC_CLAUDE_BIN" ;; *) echo "error: CC_CLAUDE_BIN must be an absolute path (got $CC_CLAUDE_BIN)" >&2; exit 2 ;; esac
else
  rest="$PATH:"
  while [ -n "$rest" ]; do
    dir="${rest%%:*}"
    rest="${rest#*:}"
    case "$dir" in /*) ;; *) continue ;; esac
    if [ -f "${dir%/}/claude" ] && [ -x "${dir%/}/claude" ]; then CLAUDE_BIN="${dir%/}/claude"; break; fi
  done
  if [ -z "$CLAUDE_BIN" ] && [ -f "$HOME/.local/bin/claude" ] && [ -x "$HOME/.local/bin/claude" ]; then CLAUDE_BIN="$HOME/.local/bin/claude"; fi
fi
if [ -n "$CLAUDE_BIN" ]; then
  if CLAUDE_CHECK="$(cd "$ROOT" && CLAUDE_BIN="$CLAUDE_BIN" node --input-type=module -e '
import path from "node:path";
const { claudeVersionGate } = await import(path.resolve("custom/control-center/server/claude/confinement.mjs"));
try {
  const gate = claudeVersionGate(process.env.CLAUDE_BIN);
  process.stdout.write(gate.problem ? `warning: ${gate.problem}; the daily job skips its policy pass and rank until it is` : `Claude Code ${gate.version}`);
} catch (err) {
  process.stdout.write(`warning: ${err.message}; the daily job fails its policy pass and rank until it can be read`);
}
' 2>&1)"; then :; else CLAUDE_CHECK="warning: could not check the Claude Code version of $CLAUDE_BIN"; fi
  case "$CLAUDE_CHECK" in
    warning:*) echo "$CLAUDE_CHECK" >&2 ;;
    *) echo "daily job uses claude $CLAUDE_BIN ($CLAUDE_CHECK)" ;;
  esac
else
  echo "warning: no claude found on PATH or in ~/.local/bin; the daily job looks it up on launchd's PATH at run time. To pin one: CC_CLAUDE_BIN=/path/to/claude $(shell_quote "$0")" >&2
fi

# The node both jobs run on, pinned as CC_NODE_BIN (custom/launchd/pinned-node.sh puts it first on the job's PATH):
# launchd's PATH never reaches a node from nvm, fnm, volta or asdf. Its real path, so an fnm per-shell link is not pinned.
NODE_BIN="$(node -p process.execPath)"
echo "jobs use node $NODE_BIN ($("$NODE_BIN" --version))"

write_plist() { # label script hour minute weekday(or empty) logdir
  local label="$1" script="$2" hour="$3" minute="$4" weekday="$5" logdir="$6"
  local wd="" envxml vars="" xdata xroot
  xdata="$(xml_escape "$DATA")"
  xroot="$(xml_escape "$ROOT")"
  if [ "$ENV_ROOT" = 1 ]; then vars="<key>CAREER_OPS_ROOT</key><string>$xdata</string>"; fi
  if [ "$label" = com.career-ops.immigration-watch ] && [ -n "$CLAUDE_BIN" ]; then vars="$vars<key>CC_CLAUDE_BIN</key><string>$(xml_escape "$CLAUDE_BIN")</string>"; fi
  vars="$vars<key>CC_NODE_BIN</key><string>$(xml_escape "$NODE_BIN")</string>"
  envxml="<key>EnvironmentVariables</key><dict>$vars</dict>"
  [ -n "$weekday" ] && wd="<key>Weekday</key><integer>$weekday</integer>"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$xroot/$script</string></array>
  <key>WorkingDirectory</key><string>$xroot</string>
  $envxml
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$minute</integer>$wd</dict>
  <key>StandardOutPath</key><string>$xdata/$logdir/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$xdata/$logdir/launchd.err.log</string>
</dict>
</plist>
PLIST
  plutil -lint "$AGENTS/$label.plist" >/dev/null
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  # Disabling the job in the Control Center is persistent and bootstrap refuses a disabled label: reinstalling re-enables it.
  launchctl enable "gui/$(id -u)/$label"
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "installed $label"
}

write_plist com.career-ops.immigration-watch custom/immigration/run-daily.sh 8 0 "" data/immigration/logs
if [ "$JOBS" = all ]; then
  write_plist com.career-ops.upstream-sync custom/upstream-sync/sync.sh 3 0 0 data/upstream-sync
elif [ -f "$AGENTS/com.career-ops.upstream-sync.plist" ]; then
  # The maintainer reruns this script; an installed sync job is theirs, so it is left alone.
  echo "note: the weekly sync job (com.career-ops.upstream-sync) is still installed; --jobs daily does not touch it."
  echo "      To remove it: launchctl bootout gui/$(id -u)/com.career-ops.upstream-sync; rm $(shell_quote "$AGENTS/com.career-ops.upstream-sync.plist")"
fi
