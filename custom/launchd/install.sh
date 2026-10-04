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

write_plist() { # label script hour minute weekday(or empty) logdir
  local label="$1" script="$2" hour="$3" minute="$4" weekday="$5" logdir="$6"
  local wd="" envxml="" xdata xroot
  xdata="$(xml_escape "$DATA")"
  xroot="$(xml_escape "$ROOT")"
  if [ "$ENV_ROOT" = 1 ]; then envxml="<key>EnvironmentVariables</key><dict><key>CAREER_OPS_ROOT</key><string>$xdata</string></dict>"; fi
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
