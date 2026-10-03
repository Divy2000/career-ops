#!/bin/bash
# Install (or reinstall) the fork's launchd jobs for this checkout.
#   daily  08:00  custom/immigration/run-daily.sh   policy watch, scan, rank, shortlist
#   weekly Sun 03:00 custom/upstream-sync/sync.sh   merge upstream main into the fork
# /bin/bash needs Full Disk Access when the checkout lives under ~/Desktop or ~/Documents.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$ROOT/data/immigration/logs" "$ROOT/data/upstream-sync"

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
write_plist com.career-ops.upstream-sync custom/upstream-sync/sync.sh 3 0 0 data/upstream-sync
