#!/bin/bash
# Install (or reinstall) the fork's launchd jobs for this checkout.
#   daily  08:00  custom/immigration/run-daily.sh   policy watch, scan, rank, shortlist
#   weekly Sun 03:00 custom/upstream-sync/sync.sh   merge upstream main into the fork
# /bin/bash needs Full Disk Access when the checkout or the data root lives under ~/Desktop or ~/Documents.
# Usage: install.sh [--jobs daily|all] [--reset]
#   --jobs   default all; "daily" skips the weekly sync, which only the fork maintainer needs
#   --reset  put each job back at its default time and turn it on. Without it, a job that is already installed keeps
#            the time and the on/off state set in the Control Center (Runs & Schedule); only its paths are rewritten.
set -euo pipefail
JOBS=all
RESET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jobs)
      [ "$#" -ge 2 ] || { echo "error: --jobs needs daily or all" >&2; exit 2; }
      JOBS="$2"
      shift
      ;;
    --reset) RESET=1 ;;
    *) echo "error: unknown option $1 (usage: install.sh [--jobs daily|all] [--reset])" >&2; exit 2 ;;
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
# launchd's /bin/bash reads the checkout and writes the data root (lock, day logs, launchd.out/err.log).
fda_note() { # what path
  case "$2" in "$HOME/Desktop"/* | "$HOME/Documents"/*) echo "note: the $1 $2 is under Desktop or Documents; give /bin/bash Full Disk Access (System Settings > Privacy & Security), or the jobs cannot use it." ;; esac
}
fda_note checkout "$ROOT"
fda_note "data root" "$DATA"
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
# launchd's PATH never reaches a node from nvm, fnm, volta or asdf. The pin is the node on this shell's PATH as written
# (/opt/homebrew/bin/node, an nvm version folder), which outlives an upgrade where the versioned folder it links into
# does not. It is the real binary only when that entry is an fnm per-shell link (fnm_multishells, gone with its shell),
# or does not resolve to the node that runs (a shim, a relative entry). The Control Center writes the same pin.
NODE_BIN="$(node -e '
const fs = require("node:fs");
const found = process.argv[1] || "";
const keep = found.startsWith("/") && !found.includes("fnm_multishells") && fs.realpathSync(found) === fs.realpathSync(process.execPath);
process.stdout.write(keep ? found : process.execPath);
' "$(command -v node)")"
echo "jobs use node $NODE_BIN ($("$NODE_BIN" --version))"

# The schedule of the installed plist for <label> as "hour minute weekday" (weekday may be empty), or nothing when there
# is none or it cannot be read (plutil -extract is read-only).
installed_schedule() {
  local f="$AGENTS/$1.plist" h m w
  [ -f "$f" ] || return 0
  h="$(plutil -extract StartCalendarInterval.Hour raw -o - "$f" 2>/dev/null)" || return 0
  m="$(plutil -extract StartCalendarInterval.Minute raw -o - "$f" 2>/dev/null)" || return 0
  w="$(plutil -extract StartCalendarInterval.Weekday raw -o - "$f" 2>/dev/null)" || w=""
  [[ "$h" =~ ^[0-9]+$ ]] && [[ "$m" =~ ^[0-9]+$ ]] && [[ -z "$w" || "$w" =~ ^[0-9]+$ ]] || return 0
  printf '%s %s %s' "$h" "$m" "$w"
}

# Whether launchd keeps <label> disabled (`launchctl disable`, which the Control Center's off switch uses): its line in
# `launchctl print-disabled` reads `"<label>" => disabled`, or `=> true` on older macOS (parsePrintDisabled in the
# Control Center's schedule.ts reads it the same way). The list is read whole first: grep -q on a pipe would stop
# early, launchctl would die of SIGPIPE, and under pipefail a job that is off would read as on.
label_disabled() {
  local out line
  out="$(launchctl print-disabled "gui/$(id -u)" 2>/dev/null)" || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*\"([^\"]*)\"[[:space:]]*=\>[[:space:]]*([A-Za-z]+) ]] || continue
    [ "${BASH_REMATCH[1]}" = "$1" ] || continue
    case "${BASH_REMATCH[2]}" in disabled | true) return 0 ;; *) return 1 ;; esac
  done <<<"$out"
  return 1
}

write_plist() { # label script hour minute weekday(or empty) logdir
  local label="$1" script="$2" hour="$3" minute="$4" weekday="$5" logdir="$6"
  local wd="" envxml vars="" xdata xroot tmp kept="" off=0 sched reinstall=0
  # A job that is already installed keeps the time and on/off state the user chose in the Control Center; the paths,
  # pins and logs are rewritten for this checkout and data root. --reset goes back to the defaults.
  if [ "$RESET" = 0 ] && [ -f "$AGENTS/$label.plist" ]; then
    reinstall=1
    sched="$(installed_schedule "$label")"
    if [ -n "$sched" ]; then
      read -r hour minute weekday <<<"$sched"
      kept="keeping its $(printf '%02d:%02d' "$hour" "$minute") schedule"
    fi
  fi
  xdata="$(xml_escape "$DATA")"
  xroot="$(xml_escape "$ROOT")"
  if [ "$ENV_ROOT" = 1 ]; then vars="<key>CAREER_OPS_ROOT</key><string>$xdata</string>"; fi
  if [ "$label" = com.career-ops.immigration-watch ] && [ -n "$CLAUDE_BIN" ]; then vars="$vars<key>CC_CLAUDE_BIN</key><string>$(xml_escape "$CLAUDE_BIN")</string>"; fi
  vars="$vars<key>CC_NODE_BIN</key><string>$(xml_escape "$NODE_BIN")</string>"
  envxml="<key>EnvironmentVariables</key><dict>$vars</dict>"
  [ -n "$weekday" ] && wd="<key>Weekday</key><integer>$weekday</integer>"
  # Written and linted beside the installed plist, then moved over it: a plist that fails the lint never replaces a
  # working one. The temp name does not end in .plist, so launchd never loads it at login.
  tmp="$(mktemp "$AGENTS/.$label.XXXXXX")"
  cat > "$tmp" <<PLIST
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
  if ! plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    echo "error: the plist for $label failed plutil -lint; the installed job was left as it was" >&2
    exit 1
  fi
  chmod 644 "$tmp"
  mv -f "$tmp" "$AGENTS/$label.plist"
  if [ "$reinstall" = 1 ] && label_disabled "$label"; then off=1; kept="${kept:+$kept; }left off, as set in the Control Center"; fi
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  if [ "$off" = 1 ]; then
    echo "installed $label ($kept)"
    return 0
  fi
  # Disabling is persistent and bootstrap refuses a disabled label: a fresh install, or --reset, turns the job on.
  launchctl enable "gui/$(id -u)/$label"
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "installed $label${kept:+ ($kept)}"
}

write_plist com.career-ops.immigration-watch custom/immigration/run-daily.sh 8 0 "" data/immigration/logs
if [ "$JOBS" = all ]; then
  write_plist com.career-ops.upstream-sync custom/upstream-sync/sync.sh 3 0 0 data/upstream-sync
elif [ -f "$AGENTS/com.career-ops.upstream-sync.plist" ]; then
  # The maintainer reruns this script; an installed sync job is theirs, so it is left alone.
  echo "note: the weekly sync job (com.career-ops.upstream-sync) is still installed; --jobs daily does not touch it."
  echo "      To remove it: launchctl bootout gui/$(id -u)/com.career-ops.upstream-sync; rm $(shell_quote "$AGENTS/com.career-ops.upstream-sync.plist")"
fi
