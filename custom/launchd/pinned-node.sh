# Sourced by the launchd jobs (custom/immigration/run-daily.sh, custom/upstream-sync/sync.sh) right after they set
# PATH. install.sh pins the node it ran as CC_NODE_BIN: launchd's PATH never reaches a node from nvm, fnm, volta or
# asdf, and can reach an older one first. Its folder goes first on PATH, so the job, its npm and every child run on it.
# A pin that is gone (that version was uninstalled) leaves PATH alone and says how to pin again.
if [ -n "${CC_NODE_BIN:-}" ]; then
  if [ -f "$CC_NODE_BIN" ] && [ -x "$CC_NODE_BIN" ]; then
    export PATH="$(dirname "$CC_NODE_BIN"):$PATH"
  else
    echo "warning: CC_NODE_BIN $CC_NODE_BIN is not an executable; using the node on PATH. To pin one again, rerun custom/launchd/install.sh" >&2
  fi
fi
