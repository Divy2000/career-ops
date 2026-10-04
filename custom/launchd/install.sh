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
mkdir -p "$AGENTS" "$ROOT/data/immigration/logs"
if [ "$JOBS" = all ]; then mkdir -p "$ROOT/data/upstream-sync"; fi

write_plist() { # label script hour minute weekday(or empty) logdir
  local label="$1" script="$2" hour="$3" minute="$4" weekday="$5" logdir="$6"
  local wd=""
  [ -n "$weekday" ] && wd="<key>Weekday</key><integer>$weekday</integer>"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/$script</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$minute</integer>$wd</dict>
  <key>StandardOutPath</key><string>$ROOT/$logdir/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/$logdir/launchd.err.log</string>
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
fi
