#!/usr/bin/env bash
# Installer for the H-1B-aware career-ops fork (Divy2000/career-ops). The recommended install is the
# Claude Code prompt in .github/README.md (any resume format); this script is the second option and
# takes the resume as Markdown. Idempotent: every step checks first and skips what is already done.
# Written for the bash 3.2 that macOS ships.
set -eEuo pipefail
trap 'echo "install.sh: unexpected failure at line $LINENO (see the install log)" >&2' ERR
# The temp files and folder in use right now, each cleared once removed. A run stopped part-way (Ctrl-C at the Keychain
# read, the daily-lock wait or the validator clone; a closed terminal) exits through the EXIT trap, which removes them.
KEYCHAIN_ERR_FILE="" LOCK_READY="" LOCK_ERRS="" PROJECTS_SCRATCH=""
remove_temp_paths() {
  rm -rf -- ${KEYCHAIN_ERR_FILE:+"$KEYCHAIN_ERR_FILE"} ${LOCK_READY:+"$LOCK_READY"} ${LOCK_ERRS:+"$LOCK_ERRS"} ${PROJECTS_SCRATCH:+"$PROJECTS_SCRATCH"} 2>/dev/null || true
}
trap remove_temp_paths EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FORK_URL="${CAREER_OPS_REPO_URL:-https://github.com/Divy2000/career-ops.git}"
UPSTREAM_URL="https://github.com/career-ops-hq/career-ops.git"
# The Node versions the Control Center supports (NODE_RANGE in supervisor/preflight.ts; a test there checks these copies).
NODE_RANGE="^22.22.2 || ^24.15.0 || >=26.0.0"
NODE_SUPPORTED="22.22.2+, 24.15+ or 26+"
KEYCHAIN_SERVICE="career-ops-claude-token"
# Headless onboarding needs CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (2.1.288) and --restricted, first probed by the
# Control Center on 2.1.289. The floor names what an older CLI lacks; headless_claude_gate then requires a version the
# contract approves, as newer ones are unprobed.
CLAUDE_HEADLESS_MIN="2.1.289"
# The terminal the installer talks to. Overridable so tests can feed answers from a file.
TTY_DEV="${CAREER_OPS_INSTALL_TTY:-/dev/tty}"

usage() {
  cat <<'HELP'
career-ops (H-1B-aware fork) installer

The recommended install is the Claude Code prompt in .github/README.md: it accepts your resume and
project documents in any format. This script is the second option and takes Markdown only.

Usage: custom/install/install.sh [options]

Options:
  --yes, -y                 Do not ask for confirmation; take the default answer
  --non-interactive         Never prompt or read the terminal; unfinished steps become pending actions
  --dir <path>              Checkout location (default: the checkout this script is in, else ~/career-ops)
  --data-root <path>        Keep personal data outside the checkout (writes the gitignored .career-ops-data marker)
  --ref <tag>               Check out this tag or branch of the fork
  --no-launchd              Do not install the daily 8am launchd job
  --with-upstream-sync      Also install the weekly upstream sync job (fork maintainer only)
  --no-start                Do not start the Control Center at the end
  --no-h1b-index            Do not download the H-1B sponsor index (about 8 MiB)
  --resume <file.md>        Your resume as Markdown (.md or .markdown); copied to documents/cv/, seeds cv.md when absent
  --docs <a.md> [b.md ...]  Project docs as Markdown; values run until the next --flag; copied to documents/projects/
  --replace-cv              Allow replacing an existing, different cv.md with --resume (the old one is backed up first)
  --projects <file>         Your projects library (.md) or a projects JSON (AutoJobApply or JSON Resume); validated,
                            copied to documents/projects/, creates article-digest.md when absent (never replaces it)
  --onboard <mode>          interactive | headless | none
                            default: interactive when a terminal and claude are available, else none (prints the command)
  --install-missing         Offer to brew install missing prerequisites (asks y/N each time, never with --yes)
  --core-only               Skip the macOS-only parts (Keychain, launchd, Control Center); for Linux
  --dry-run                 Show what would happen and change nothing
  --help, -h                Show this help

Only Markdown (.md, .markdown; resume up to 1 MiB, each doc up to 2 MiB, at most 20 docs, 10 MiB in all)
is accepted here. For PDF, DOCX and other formats use option 1 (Claude Code prompt).

Exit codes: 0 done, 1 failure, 2 usage error, 3 done with pending actions
HELP
}

# ---------------------------------------------------------------- state and output

ASSUME_YES=0
NON_INTERACTIVE=0
DIR_ARG=""
DATA_ROOT_ARG=""
REF=""
NO_LAUNCHD=0
WITH_UPSTREAM_SYNC=0
NO_START=0
NO_H1B=0
RESUME=""
DOCS=()
PROJECTS=""
PROJECTS_CHECKED=0
REPLACE_CV=0
ONBOARD_MODE=""
INSTALL_MISSING=0
CORE_ONLY=0
DRY_RUN=0

PENDING=()
LOG_FILE=""
LOG_BUF=""
VALIDATED=0
MAC_FEATURES=0
CLAUDE_BIN=""
PREFLIGHT_FAILED=0
# Set when the Control Center was running at the dependency step, so its npm ci was skipped.
CC_DEPS_DEFERRED=0
CC_DEFER_BLOCKED=0
TTY_OK=0
PROMPT_OK=0
CV_COPY=""
CV_APPLIED=1
DOC_COPIES=()

_log() {
  if [ -n "$LOG_FILE" ]; then printf '%s\n' "$*" >> "$LOG_FILE"; else LOG_BUF="$LOG_BUF$*"$'\n'; fi
}
say() { printf '%s\n' "$*"; _log "$*"; }
warn() { printf '%s\n' "$*" >&2; _log "$*"; }
die() { warn "error: $2"; exit "$1"; }
dry() { say "  [dry run] would $*"; }
step() { say ""; say "== $* =="; }
pending() { PENDING+=("$*"); }

usage_error() {
  printf 'error: %s\nRun install.sh --help for the options.\n' "$1" >&2
  exit 2
}

# Runs a command, shows its output and appends it to the log. Callers use it inside `if`.
run_logged() {
  local rc=0
  if [ -n "$LOG_FILE" ]; then
    "$@" 2>&1 | tee -a "$LOG_FILE" || rc="${PIPESTATUS[0]}"
  else
    "$@" || rc=$?
  fi
  return "$rc"
}

# The place macOS privacy controls keep launchd's /bin/bash out of without Full Disk Access, for the real path of
# <dir> (a symlink into one counts): Desktop, Documents, Downloads, iCloud Drive, a File Provider cloud folder, or a
# volume other than the boot one (removable and network volumes are protected). Nothing for anywhere else.
# install/install.sh and launchd/install.sh carry the same function; install.spec and launchd.spec cover both.
fda_place() {
  local real home
  real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  home="$(cd "$HOME" 2>/dev/null && pwd -P)" || home="$HOME"
  case "$real/" in
    "$home/Desktop/"*) echo Desktop ;;
    "$home/Documents/"*) echo Documents ;;
    "$home/Downloads/"*) echo Downloads ;;
    "$home/Library/Mobile Documents/"*) echo "iCloud Drive" ;;
    "$home/Library/CloudStorage/"*) echo "a cloud storage folder" ;;
    /Volumes/*) real="${real#/Volumes/}"; echo "the volume ${real%%/*}" ;;
  esac
}

# lexical_path <absolute-path>: the path with empty, . and .. parts folded, without touching the filesystem.
lexical_path() {
  local part parts out=()
  IFS=/ read -ra parts <<< "$1"
  for part in ${parts[@]+"${parts[@]}"}; do
    case "$part" in
      '' | .) ;;
      ..) if [ "${#out[@]}" -gt 0 ]; then unset 'out[${#out[@]}-1]'; fi ;;
      *) out+=("$part") ;;
    esac
  done
  if [ "${#out[@]}" -eq 0 ]; then printf '/'; else printf '/%s' "${out[@]}"; fi
}

# physical_path <absolute-path> [depth]: the path as the kernel would resolve it, even before it exists: its deepest
# existing folder with symlinks resolved (a dangling one followed to its target), then the rest folded lexically.
physical_path() {
  local p="$1" head tail="" target depth="${2:-0}"
  # Trailing slashes off first, or the last part would be read as empty and the path as its parent.
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  head="$(dirname "$p")"
  while [ ! -d "$head" ]; do
    # Bounded, so a dangling symlink loop ends.
    if [ -L "$head" ] && [ "$depth" -lt 40 ]; then
      target="$(readlink "$head")"
      case "$target" in /*) ;; *) target="$(dirname "$head")/$target" ;; esac
      physical_path "$target$tail/${p##*/}" $((depth + 1))
      return
    fi
    tail="/${head##*/}$tail"
    head="$(dirname "$head")"
  done
  lexical_path "$(cd -P "$head" && pwd -P)$tail/${p##*/}"
}

# The confinement refuses a data root that is the filesystem root or is (or contains) the home directory: a session
# could read every file under it (assertRootsConfinable in custom/control-center/server/claude/confinement.mjs). Both
# paths are resolved the way it resolves them (fs.realpathSync.native, which also fixes the letter case on a
# case-insensitive volume), with pwd -P when node is not there yet. A root that does not exist yet is resolved as the
# kernel will once it is created (physical_path, so ~/new/.. is home), then its deepest existing folder as above.
# Exits 1.
real_path() {
  if command -v node >/dev/null 2>&1 &&
    node -e 'process.stdout.write(require("fs").realpathSync.native(process.argv[1]))' "$1" 2>/dev/null; then
    return 0
  fi
  if [ -d "$1" ]; then
    (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
    return
  fi
  local head tail=""
  head="$(physical_path "$1")"
  while [ ! -d "$head" ]; do
    tail="/${head##*/}$tail"
    head="$(dirname "$head")"
  done
  lexical_path "$(real_path "$head")$tail"
}
refuse_unconfinable_root() { # path
  local real home
  real="$(real_path "$1")"
  home="$(real_path "$HOME")"
  if [ "$real" = / ]; then
    echo "error: the data root $1 is the filesystem root; sessions and the daily job would refuse it. Choose a dedicated folder (for example ~/career-ops-data) with --data-root or CAREER_OPS_ROOT." >&2
    exit 1
  fi
  case "$home/" in
    "$real/"*)
      echo "error: the data root $1 is your home directory or contains it; sessions and the daily job would refuse it. Choose a dedicated folder (for example ~/career-ops-data) with --data-root or CAREER_OPS_ROOT." >&2
      exit 1
      ;;
  esac
}

ask() { # ask "question" y|n  -> 0 when the answer is yes; EOF or Enter takes the default
  local question="$1" default="$2" hint ans=""
  if [ "$default" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '%s %s ' "$question" "$hint" >&2
  IFS= read -r ans <&3 || ans=""
  printf '\n' >&2
  case "$ans" in
    [yY] | [yY][eE][sS]) return 0 ;;
    [nN] | [nN][oO]) return 1 ;;
  esac
  [ "$default" = y ]
}

abspath() {
  local p="$1"
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#"~/"}" ;;
  esac
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  printf '%s' "$p"
}

shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# A remote URL as shown and logged: an https://user:token@host URL loses its userinfo, which can hold a credential.
redact_url() { printf '%s' "$1" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\1#'; }

# ---------------------------------------------------------------- arguments

value_of() { # value_of <flag> <next arg or nothing>
  if [ "$#" -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then usage_error "$1 needs a value"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help | -h) usage; exit 0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dir) value_of "$@"; DIR_ARG="$2"; shift ;;
    --data-root) value_of "$@"; DATA_ROOT_ARG="$2"; shift ;;
    --ref) value_of "$@"; REF="$2"; shift ;;
    --no-launchd) NO_LAUNCHD=1 ;;
    --with-upstream-sync) WITH_UPSTREAM_SYNC=1 ;;
    --no-start) NO_START=1 ;;
    --no-h1b-index) NO_H1B=1 ;;
    --resume) value_of "$@"; RESUME="$2"; shift ;;
    --docs)
      shift
      count=0
      while [ "$#" -gt 0 ]; do
        case "$1" in -*) break ;; esac
        DOCS+=("$1")
        count=$((count + 1))
        shift
      done
      [ "$count" -gt 0 ] || usage_error "--docs needs at least one Markdown file"
      continue
      ;;
    --replace-cv) REPLACE_CV=1 ;;
    --projects) value_of "$@"; PROJECTS="$2"; shift ;;
    --onboard)
      value_of "$@"
      case "$2" in
        interactive | headless | none) ONBOARD_MODE="$2" ;;
        *) usage_error "--onboard must be interactive, headless or none (got $2)" ;;
      esac
      shift
      ;;
    --install-missing) INSTALL_MISSING=1 ;;
    --core-only) CORE_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) usage_error "unknown option $1" ;;
  esac
  shift
done

if [ -n "$DIR_ARG" ]; then
  DIR="$(abspath "$DIR_ARG")"
elif [ -f "$SCRIPT_ROOT/doctor.mjs" ] && [ -e "$SCRIPT_ROOT/.git" ]; then
  DIR="$SCRIPT_ROOT"
else
  DIR="$HOME/career-ops"
fi
if [ -n "$DATA_ROOT_ARG" ]; then DATA_REQ="$(abspath "$DATA_ROOT_ARG")"; else DATA_REQ="$DIR"; fi
if [ -n "$PROJECTS" ]; then PROJECTS="$(abspath "$PROJECTS")"; fi
DATA="$DATA_REQ"
QDIR="$(shell_quote "$DIR")" # for printed commands: the directory may contain spaces

# The terminal: fd 3 reads answers, fd 4 receives what interactive tools print. Never opened with --non-interactive.
if [ "$NON_INTERACTIVE" = 0 ] && { : <"$TTY_DEV" >>"$TTY_DEV"; } 2>/dev/null; then
  exec 3<"$TTY_DEV" 4>>"$TTY_DEV"
  TTY_OK=1
  if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then PROMPT_OK=1; fi
fi

# ---------------------------------------------------------------- helpers

lib() { node "$SCRIPT_DIR/cli.mjs" "$@"; }
# Headless onboarding hands the session the OAuth token, so it runs only on a Claude Code whose confinement flags
# (--restricted, SUBPROCESS_ENV_SCRUB) were probed: the versions the checkout's contract approves
# (claude.approvedVersions), the list the Control Center and the daily job gate on. Prints one line of fields split by
# the unit separator (\x1f, which read never collapses as it does tabs), "state detail list identity newest": state is approved, unapproved or error; detail is the
# found version, or why the version or contract cannot be read; approved list is "none yet" for an empty list and
# "unknown" for an unreadable contract; identity is the approved binary's real path@version ("-" otherwise); newest is
# the newest approved version that meets CLAUDE_HEADLESS_MIN, empty when none does. Only stdout counts, so a node warning cannot turn "approved" into a
# refusal. Always exits 0, as bash 3.2 fires the ERR trap on a failing command substitution.
headless_claude_gate() {
  CONFINEMENT="$DIR/custom/control-center/server/claude/confinement.mjs" INSTALL_LIB="$SCRIPT_DIR/lib.mjs" \
    HEADLESS_MIN="$CLAUDE_HEADLESS_MIN" CLAUDE_BIN="$CLAUDE_BIN" node --input-type=module -e '
const line = (...fields) => process.stdout.write(fields.map((f) => String(f).replace(/[\x1f\n]+/g, " ")).join("\x1f"));
const reason = (err) => String(err?.message ?? err).split("\n")[0];
let approved, newest, gate;
try {
  const { versionAtLeast } = await import(process.env.INSTALL_LIB);
  const { claudeVersionGate, contractApprovedVersions } = await import(process.env.CONFINEMENT);
  approved = contractApprovedVersions();
  // Semver order on x.y.z, then a release above its own pre-releases (2.1.296-beta.1 < 2.1.296).
  newest = approved.filter((v) => versionAtLeast(v, process.env.HEADLESS_MIN)).reduce((best, v) => (best && versionAtLeast(best, v) ? best : v), "");
  try {
    gate = claudeVersionGate(process.env.CLAUDE_BIN, approved);
  } catch (err) {
    line("error", reason(err), approved.length ? approved.join(", ") : "none yet", "-", newest);
    process.exit(0);
  }
} catch (err) {
  line("error", reason(err), "unknown", "-", "");
  process.exit(0);
}
line(gate.problem ? "unapproved" : "approved", gate.version, approved.length ? approved.join(", ") : "none yet", gate.problem ? "-" : gate.identity, newest);
' 2>/dev/null || printf 'error\037node could not run the version gate\037unknown\037-\037'
}
# Unsets every inherited ANTHROPIC_* variable (keys, tokens, custom headers, and the endpoint they are sent to) and every
# CLAUDE_CODE_* one with a credential name segment: the rule sync.sh, run-daily.sh and the Control Center's isCredential
# apply. Called in the headless subshell, so the Claude that gets the Keychain token sees no other credential.
strip_claude_credentials() {
  local var
  for var in $(compgen -e); do
    case "$var" in
      ANTHROPIC_*) unset "$var" ;;
      CLAUDE_CODE_*)
        case "_${var}_" in
          *_TOKEN_* | *_KEY_* | *_SECRET_* | *_PASSWORD_* | *_PASSPHRASE_* | *_CREDENTIAL_* | *_CREDENTIALS_* | *_CERT_* | *_HEADER_* | *_HEADERS_*) unset "$var" ;;
        esac
        ;;
    esac
  done
}
seed() { node "$SCRIPT_DIR/seed.mjs" "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }

find_claude() {
  local d
  if have claude; then command -v claude; return 0; fi
  local IFS=:
  for d in ${CAREER_OPS_CLAUDE_FALLBACK_DIRS:-$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin}; do
    if [ -x "$d/claude" ]; then printf '%s\n' "$d/claude"; return 0; fi
  done
  return 1
}

# keychain_check: looks the item up without reading the secret, bounded as every Keychain read is, and sets
# KEYCHAIN_RC (0 present, 44 missing, anything else unreadable) and KEYCHAIN_WHY (the tail of security's stderr).
keychain_check() {
  local rc=0
  KEYCHAIN_WHY=""
  KEYCHAIN_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/career-ops-install-keychain.XXXXXX" 2>/dev/null)" || KEYCHAIN_ERR_FILE=""
  bounded "$KEYCHAIN_TIMEOUT" security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>"${KEYCHAIN_ERR_FILE:-/dev/null}" || rc=$?
  if [ -n "$KEYCHAIN_ERR_FILE" ]; then
    KEYCHAIN_WHY="$(tail -c 200 "$KEYCHAIN_ERR_FILE" | tr '\n' ' ' | sed 's/ *$//')"
    rm -f "$KEYCHAIN_ERR_FILE"
    KEYCHAIN_ERR_FILE=""
  fi
  KEYCHAIN_RC=$rc
}

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }

# bounded <seconds> <command...>: runs the command and kills it when the alarm fires, exiting 124 as timeout(1) does
# (stock macOS has none), the daily job's and the weekly sync's Keychain wait. The command stays in this process group.
bounded() {
  /usr/bin/perl -MPOSIX=WNOHANG -e '
    my $limit = shift;
    my $pid = fork;
    die "cannot start $ARGV[0]: $!\n" unless defined $pid;
    if ($pid == 0) {
      exec { $ARGV[0] } @ARGV;
      print STDERR "$ARGV[0]: $!\n";
      exit($!{ENOENT} ? 127 : 126);
    }
    sub status { ($? & 127) ? 128 + ($? & 127) : $? >> 8 }
    # The alarm can land just after the main waitpid reaped the command: only one still running is a timeout.
    $SIG{ALRM} = sub {
      my $reaped = $?;
      my $r = waitpid $pid, WNOHANG;
      if ($r == 0) { kill "KILL", $pid; waitpid $pid, 0; exit 124 }
      exit status() if $r == $pid;
      $? = $reaped;
    };
    alarm $limit;
    waitpid $pid, 0;
    alarm 0;
    exit status();
  ' "$@"
}

# keychain_read_token: reads the secret as the Control Center, the daily job and the weekly sync read it (bounded,
# trimmed) and sets KEYCHAIN_TOKEN, KEYCHAIN_RC (an empty token counts as 44, missing) and KEYCHAIN_WHY.
keychain_read_token() {
  local rc=0
  KEYCHAIN_WHY=""
  KEYCHAIN_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/career-ops-install-keychain.XXXXXX" 2>/dev/null)" || KEYCHAIN_ERR_FILE=""
  # The || stays inside $(...) too, where the ERR trap would otherwise report the failed read as a crash.
  KEYCHAIN_TOKEN="$(bounded "$KEYCHAIN_TIMEOUT" security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>"${KEYCHAIN_ERR_FILE:-/dev/null}" || exit "$?")" || rc=$?
  KEYCHAIN_TOKEN="$(trim "$KEYCHAIN_TOKEN")"
  if [ -n "$KEYCHAIN_ERR_FILE" ]; then
    KEYCHAIN_WHY="$(tail -c 200 "$KEYCHAIN_ERR_FILE" | tr '\n' ' ' | sed 's/ *$//')"
    rm -f "$KEYCHAIN_ERR_FILE"
    KEYCHAIN_ERR_FILE=""
  fi
  if [ "$rc" = 0 ] && [ -z "$KEYCHAIN_TOKEN" ]; then rc=44; fi
  if [ "$rc" != 0 ]; then KEYCHAIN_TOKEN=""; fi
  KEYCHAIN_RC=$rc
}

# keychain_problem <exit> <stderr> <retry>: why a Keychain read that failed did, worded as the weekly sync words it.
# Only exit 44 (errSecItemNotFound) means the item is missing; any other failure leaves a stored token that is fine.
keychain_problem() {
  local why="${2:+: $2}" read="Could not read Keychain item $KEYCHAIN_SERVICE"
  case "$1" in
    44) printf '%s' "Keychain item $KEYCHAIN_SERVICE not found. Run: claude setup-token, then security add-generic-password -U -a \"\$USER\" -s $KEYCHAIN_SERVICE -w" ;;
    124) printf '%s' "$read: security did not answer within $KEYCHAIN_TIMEOUT s. The login keychain is probably locked and waiting at an unlock prompt nobody answered. Unlock it with: security unlock-keychain, then $3." ;;
    127) printf '%s' "$read: the security command was not found on PATH (it ships with macOS in /usr/bin)." ;;
    126) printf '%s' "$read: the security command could not be run (exit 126$why); check that /usr/bin/security is the one first on PATH." ;;
    # errSecAuthFailed: Deny at the Keychain prompt, or the item's access control refuses security.
    51) printf '%s' "$read: security failed (exit 51$why). Access to it was denied: answer Always Allow when the Keychain prompt appears, or add /usr/bin/security to the item's access control in Keychain Access, then $3." ;;
    # errSecInteractionNotAllowed: locked, with no way to prompt.
    36) printf '%s' "$read: security failed (exit 36$why). The login keychain is probably locked or cannot prompt (for example over SSH or before login). Unlock it with: security unlock-keychain, then $3." ;;
    *) printf '%s' "$read: security failed (exit $1$why)." ;;
  esac
}

# Whether the Control Center is already running on this data root, read from its
# supervisor.lock (the file the supervisor keeps via acquireInstanceLock). Running
# means the lock names a PID that is alive and that started when the lock says it
# did: a live PID that started at another time is a reused PID, not the Control
# Center. A missing or stale lock, or a damaged one past its 5 s grace, is not
# running; one that cannot be read is. npm ci deletes
# node_modules, so a re-run must not reinstall under a running instance (its
# blue/green reload would race the deletion), and the finish must not start a
# second instance that would refuse the lock.
# A Control Center from this checkout may run on another data root than this run's: the checkout itself (before
# --data-root moves the data out) or the root the installed daily job names. It is running if any of them is, where
# on those other roots only a lock naming a live process counts: the supervisor will not start there.
# CC_LOCK_BLOCKED names this root's lock when it counts only because it cannot be read: nothing may be running then.
CC_LOCK_BLOCKED=""
cc_running() {
  local root seen=" $DATA " rc
  CC_LOCK_BLOCKED=""
  if cc_lock_live "$DATA/data/control-center/supervisor.lock"; then return 0; else rc=$?; fi
  while IFS= read -r root; do
    case "$seen" in *" $root "*) continue ;; esac
    seen="$seen$root "
    if cc_lock_live "$root/data/control-center/supervisor.lock" other; then return 0; fi
  done < <(printf '%s\n' "$DIR"; installed_job_root own)
  if [ "$rc" = 2 ]; then CC_LOCK_BLOCKED="$DATA/data/control-center/supervisor.lock"; return 0; fi
  return 1
}

cc_lock_live() {
  node -e '
const fs = require("fs");
const { execFileSync } = require("child_process");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
// "other": a root this run would not start the Control Center on, where only a live process counts as running.
const other = process.argv[2] === "other";
let text;
try { text = fs.readFileSync(process.argv[1], "utf8"); }
catch (e) {
  if (other) process.exit(1);
  // No lock is not running. A lock that cannot be read counts as running (exit 2), since acquireInstanceLock throws
  // on it rather than replacing it, and so does a dangling symlink in its place, which the supervisor cannot take either.
  let entry = e.code !== "ENOENT";
  if (!entry) try { fs.lstatSync(process.argv[1]); entry = true; } catch { /* nothing there */ }
  process.exit(entry ? 2 : 1);
}
let pid = 0, start = null;
try {
  const l = JSON.parse(text);
  if (Number.isInteger(l.pid) && l.pid > 0 && Number.isInteger(l.port)) {
    pid = l.pid;
    start = typeof l.start === "number" && Number.isFinite(l.start) ? l.start : null;
  }
} catch { /* damaged content, judged below */ }
// A lock parseHolder in supervisor/instance-lock.ts rejects (no positive integer pid, no integer port) is damaged:
// the supervisor leaves one younger than UNREADABLE_LOCK_GRACE_MS (5 s) alone and refuses to start, so that counts
// as running, and replaces an older one, so that does not.
if (!pid) {
  if (other) process.exit(1);
  let young = false;
  try { young = Date.now() - fs.statSync(process.argv[1]).mtimeMs < 5000; } catch { /* gone: not running */ }
  process.exit(young ? 0 : 1);
}
// When the PID started, read like processStartTime in supervisor/instance-lock.ts: ps first, since it reads
// the process of another user too (kill(pid, 0) is refused with EPERM there, which says nothing about reuse). Only
// when ps cannot answer does the kernel decide: "unknown" when the PID runs, null when it does not.
const runs = () => { try { process.kill(pid, 0); return "unknown"; } catch (e) { return e.code === "ESRCH" ? null : "unknown"; } };
let live;
try {
  const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: { LC_ALL: "C", TZ: "UTC" } }).trim();
  const m = LSTART.exec(out);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  live = m && month !== -1 ? Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) / 1000 : runs();
} catch (e) {
  live = e.status === 1 && !e.signal && !String(e.stdout || "").trim() ? null : runs();
}
// Running unless the PID is gone, or runs a process that started at another time than the lock says (a reused PID).
// With no start recorded, or one that cannot be read, the PID alone decides, as acquireInstanceLock does.
process.exit(live !== null && (start === null || live === "unknown" || live === start) ? 0 : 1);
' "$1" "${2:-}"
}

# The data root the installed daily job writes its launchd logs under (<root>/data/immigration/logs), which differs
# from this run's when that install had CAREER_OPS_ROOT exported or this run moves the data root with --data-root.
# Prints nothing without an installed job or plutil. With "own", also nothing when that job runs from another checkout
# (its WorkingDirectory): the label is per user, and another checkout's Control Center never shares this one's files.
installed_job_root() {
  local plist="$HOME/Library/LaunchAgents/com.career-ops.immigration-watch.plist" out wd
  if [ "${1:-}" = own ]; then
    wd="$(plutil -extract WorkingDirectory raw -o - "$plist" 2>/dev/null || true)"
    if [ -z "$wd" ] || ! [ "$wd" -ef "$DIR" ]; then return 0; fi
  fi
  # The || stays inside $(...), where the ERR trap would see it.
  out="$(plutil -extract StandardOutPath raw -o - "$plist" 2>/dev/null || true)"
  case "$out" in */data/immigration/logs/launchd.out.log) printf '%s\n' "${out%/data/immigration/logs/launchd.out.log}" ;; esac
}

# The daily job's lock: run-daily.sh holds <data root>/data/immigration/.run-daily.lockf for its whole run. A re-run
# takes it, as the weekly sync's update_live_checkout does, around what changes the code or dependencies that job runs
# (the pull, the installs, the launchd reinstall), and names its holder in .live-update.pid beside it, so a daily start
# that finds the lock held waits for the installer instead of skipping the day. Seconds to wait for a running job.
DAILY_WAIT="${CAREER_OPS_INSTALL_DAILY_WAIT:-120}"
[[ "$DAILY_WAIT" =~ ^[0-9]+$ ]] || DAILY_WAIT=120
DAILY_HOLDERS=()
DAILY_LOCKFS=()
# The lock that daily_lock_take could not take, for the caller's message.
DAILY_LOCK_FAILED=""

# The lock folders a daily job may be running under: this run's data root, and the installed job's when it runs this
# checkout. Another checkout's job runs that checkout's code, which nothing here changes, as cc_running treats it.
daily_lock_dirs() {
  local root
  printf '%s\n' "$DATA/data/immigration"
  root="$(installed_job_root own)"
  if [ -n "$root" ]; then printf '%s\n' "$root/data/immigration"; fi
}

# daily_lock_take: returns 0 holding every daily lock, skipping a folder no job has run in yet (run-daily.sh creates
# it before it locks); 75 when a job still holds one after DAILY_WAIT seconds; another nonzero code when lockf failed
# otherwise, after showing its error. Either failure releases what it took and names the lock in DAILY_LOCK_FAILED.
# Decided by lockf, not MAC_FEATURES: a --core-only re-run on a Mac an earlier full install scheduled the job on still
# needs it. Each holder also ends when this installer exits, so a failure that never reaches daily_lock_release leaves
# no lock behind.
daily_lock_take() {
  local dir seen=" " id rc
  DAILY_LOCK_FAILED=""
  if [ ! -x /usr/bin/lockf ] || [ "$DRY_RUN" = 1 ]; then return 0; fi
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    # One folder reached by two spellings is locked once: a second lock on it would wait on the first.
    id="$(stat -f '%d:%i' "$dir")"
    case "$seen" in *" $id "*) continue ;; esac
    seen="$seen$id "
    rc=0
    daily_lock_take_one "$dir/.run-daily.lockf" || rc=$?
    if [ "$rc" != 0 ]; then
      DAILY_LOCK_FAILED="$dir/.run-daily.lockf"
      daily_lock_release
      return "$rc"
    fi
  done <<<"$(daily_lock_dirs)"
}

daily_lock_take_one() {
  local lock="$1" lockf_pid rc=0 polls=0 line
  LOCK_READY="$(mktemp "${TMPDIR:-/tmp}/career-ops-install-lock.XXXXXX")"
  LOCK_ERRS="$(mktemp "${TMPDIR:-/tmp}/career-ops-install-lock.XXXXXX")"
  # -k keeps the file, as run-daily.sh does, so both lock the same inode; lockf exits 75 when the wait runs out.
  /usr/bin/lockf -k -t "$DAILY_WAIT" "$lock" /bin/bash -c 'trap "rm -f \"\$1\"" EXIT; echo "$$" > "$1"; echo "$$" > "$2"; while kill -0 "$3" 2>/dev/null; do sleep 0.2; done' \
    daily-lock "${lock%/*}/.live-update.pid" "$LOCK_READY" "$$" </dev/null >/dev/null 2>"$LOCK_ERRS" 3<&- 4>&- &
  lockf_pid=$!
  until [ -s "$LOCK_READY" ]; do
    if ! kill -0 "$lockf_pid" 2>/dev/null; then
      wait "$lockf_pid" || rc=$?
      if [ "$rc" = 0 ]; then rc=1; fi
      # A timeout is the caller's to explain; any other failure shows lockf's own reason (an unreadable lock file).
      if [ "$rc" != 75 ]; then
        while IFS= read -r line || [ -n "$line" ]; do warn "$line"; done < "$LOCK_ERRS"
      fi
      rm -f "$LOCK_READY" "$LOCK_ERRS"
      LOCK_READY="" LOCK_ERRS=""
      return "$rc"
    fi
    polls=$((polls + 1))
    if [ "$polls" = 10 ]; then say "  The daily job is running; waiting up to ${DAILY_WAIT}s for it to finish."; fi
    sleep 0.1
  done
  DAILY_HOLDERS+=("$(cat "$LOCK_READY")")
  DAILY_LOCKFS+=("$lockf_pid")
  rm -f "$LOCK_READY" "$LOCK_ERRS"
  LOCK_READY="" LOCK_ERRS=""
}

daily_lock_release() {
  local pid
  for pid in ${DAILY_HOLDERS[@]+"${DAILY_HOLDERS[@]}"}; do kill "$pid" 2>/dev/null || true; done
  for pid in ${DAILY_LOCKFS[@]+"${DAILY_LOCKFS[@]}"}; do wait "$pid" 2>/dev/null || true; done
  DAILY_HOLDERS=()
  DAILY_LOCKFS=()
}

# CAREER_OPS_ROOT, else CAREER_OPS_DATA_DIR, each trimmed like path-resolver.mjs does; empty when neither is set.
env_data_root() {
  local v
  v="$(trim "${CAREER_OPS_ROOT:-}")"
  if [ -z "$v" ]; then v="$(trim "${CAREER_OPS_DATA_DIR:-}")"; fi
  case "$v" in "" | /*) printf '%s' "$v" ;; *) printf '%s' "$DIR/$v" ;; esac
}

# The data root the tools will actually use: the environment first, then the checkout's .career-ops-data marker (read by
# path-resolver.mjs itself), else the requested --data-root or the checkout.
effective_data_root() {
  local env_root
  env_root="$(env_data_root)"
  if [ -n "$env_root" ]; then
    printf '%s' "$env_root"
  elif [ -f "$DIR/.career-ops-data" ] && [ -f "$DIR/path-resolver.mjs" ] && have node; then
    (cd "$DIR" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")
  else
    printf '%s' "$DATA_REQ"
  fi
}

# --data-root must be the root the tools will use. Checked before anything is created, so no directory or log appears
# in the other root. The environment half needs no node: without it, paths are compared as written (trailing slashes
# ignored); with node, symlinks and relative spellings are resolved first.
check_data_root_conflict() {
  [ -n "$DATA_ROOT_ARG" ] || return 0
  local eff want
  if [ -f "$DIR/.career-ops-data" ] && [ -z "$(env_data_root)" ] && [ -z "$(trim "$(cat "$DIR/.career-ops-data")")" ]; then
    die 1 "$DIR/.career-ops-data is empty. Remove it or write the data root into it, then re-run."
  fi
  eff="$(effective_data_root)"
  if have node; then
    if lib same-path "$eff" "$DATA_REQ"; then return 0; fi
  else
    want="$DATA_REQ"
    while [ "${#eff}" -gt 1 ] && [ "${eff%/}" != "$eff" ]; do eff="${eff%/}"; done
    if [ "$eff" = "$want" ]; then return 0; fi
  fi
  if [ -n "$(env_data_root)" ]; then
    die 1 "CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR in your environment makes the data root $eff, not the requested $DATA_REQ. Unset it and re-run."
  fi
  die 1 "$DIR/.career-ops-data already points at $eff, not the requested $DATA_REQ. Remove the marker or drop --data-root."
}

validate_inputs() {
  [ "$VALIDATED" = 1 ] && return 0
  if [ -z "$RESUME" ] && [ "${#DOCS[@]}" -eq 0 ] && [ -z "$PROJECTS" ]; then VALIDATED=1; return 0; fi
  have node || return 0 # checked again once the prerequisites are in place
  DATA="$(effective_data_root)"
  local vargs=() rc=0
  if [ -n "$RESUME" ]; then vargs+=(--resume "$RESUME"); fi
  if [ "${#DOCS[@]}" -gt 0 ]; then vargs+=(--docs "${DOCS[@]}"); fi
  if [ -n "$PROJECTS" ]; then vargs+=(--projects "$PROJECTS"); fi
  vargs+=(--cv "$DATA/cv.md")
  node "$SCRIPT_DIR/validate-md.mjs" "${vargs[@]}" >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf 'No changes were made. Fix the input above, or use option 1 (Claude Code prompt) for other formats.\n' >&2
    if [ "$rc" -eq 2 ]; then exit 2; fi
    exit 1
  fi
  VALIDATED=1
}

# The projects parser (custom/projects/lib.mjs): next to this script in a checkout, else in an existing
# target checkout. A standalone copy of custom/install has neither before the clone. Prints nothing then;
# it always succeeds, because the ERR trap would report a nonzero status from inside $(...).
projects_lib() {
  local c
  for c in "$SCRIPT_DIR/../projects/lib.mjs" "$DIR/custom/projects/lib.mjs"; do
    if [ -f "$c" ]; then printf '%s' "$c"; return 0; fi
  done
}

PROJECTS_NO_CHANGE="No changes were made to the checkout or the user layer."

# Validates --projects before anything is cloned or written. `local` only uses a parser already on
# disk; `fetch` (once git is known to be there, after "Proceed?") may shallow-clone the fork into a
# throwaway temp dir for its parser, and stops the install if that fails.
check_projects() {
  local mode="$1" lib="" rc=0
  [ -n "$PROJECTS" ] || return 0
  [ "$PROJECTS_CHECKED" = 1 ] && return 0
  have node || return 0 # checked again once the prerequisites are in place
  if [ ! -f "$PROJECTS" ]; then
    printf 'error: --projects file not found: %s\n%s\n' "$PROJECTS" "$PROJECTS_NO_CHANGE" >&2
    exit 2
  fi
  lib="$(projects_lib)"
  if [ -z "$lib" ]; then
    if [ "$mode" != fetch ] || ! have git; then return 0; fi
    PROJECTS_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-validator.XXXXXX")"
    if git clone --quiet --depth 1 ${REF:+--branch "$REF"} "$FORK_URL" "$PROJECTS_SCRATCH/repo" >/dev/null 2>&1 && [ -f "$PROJECTS_SCRATCH/repo/custom/projects/lib.mjs" ]; then
      lib="$PROJECTS_SCRATCH/repo/custom/projects/lib.mjs"
    else
      rm -rf "$PROJECTS_SCRATCH"
      PROJECTS_SCRATCH=""
      printf 'error: could not fetch the projects validator (custom/projects/lib.mjs from %s) to check --projects.\n%s Retry, or run without --projects and import the file later in the Control Center (Profile > Projects).\n' "$(redact_url "$FORK_URL")" "$PROJECTS_NO_CHANGE" >&2
      exit 1
    fi
  fi
  node "$SCRIPT_DIR/seed.mjs" projects-check --lib "$lib" --file "$PROJECTS" >/dev/null || rc=$?
  if [ -n "$PROJECTS_SCRATCH" ]; then rm -rf "$PROJECTS_SCRATCH"; PROJECTS_SCRATCH=""; fi
  if [ "$rc" -ne 0 ]; then
    printf '%s Fix the projects file above: one "## Title -- link" block per project with "- " bullets, or a projects JSON.\n' "$PROJECTS_NO_CHANGE" >&2
    exit 2
  fi
  PROJECTS_CHECKED=1
}

# ---------------------------------------------------------------- intro and platform

check_data_root_conflict
DATA="$(effective_data_root)"
refuse_unconfinable_root "$DATA"
validate_inputs
check_projects local

say "career-ops (H-1B-aware fork) installer"
say "  checkout:  $DIR"
say "  data root: $DATA"
if [ -n "$RESUME" ]; then say "  resume:    $RESUME"; fi
if [ "${#DOCS[@]}" -gt 0 ]; then say "  docs:      ${DOCS[*]}"; fi
if [ -n "$PROJECTS" ]; then say "  projects:  $PROJECTS"; fi
if [ "$DRY_RUN" = 1 ]; then say "  Dry run: nothing will be changed."; fi

step "1/11 Platform"
OS="$(uname -s)"
if [ "$OS" = Darwin ]; then
  if [ "$CORE_ONLY" = 1 ]; then say "macOS, core-only: skipping Keychain, launchd and the Control Center."; else MAC_FEATURES=1; say "macOS: ok"; fi
elif [ "$CORE_ONLY" = 1 ]; then
  say "$OS, core-only: clone, dependencies, user layer and onboarding only."
else
  die 1 "$OS is not supported for the full install. These parts need macOS: the Keychain token store, the launchd jobs and the Control Center (it uses /usr/bin/lockf). Re-run with --core-only for the clone, dependencies, user layer and onboarding."
fi
# Seconds a Keychain read may wait (default 60), as in the daily job and the weekly sync: a locked login keychain can
# make security wait on an unlock dialog nobody answers. perl's alarm wraps at 2^32, so the wait is capped at 3600.
# Checked only where the Keychain is read, before anything changes.
KEYCHAIN_TIMEOUT="${CC_KEYCHAIN_TIMEOUT:-60}"
if [ "$MAC_FEATURES" = 1 ] && { ! [[ "$KEYCHAIN_TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]] || [ "$KEYCHAIN_TIMEOUT" -gt 3600 ]; }; then
  usage_error "CC_KEYCHAIN_TIMEOUT must be a whole number of seconds from 1 to 3600, not '$KEYCHAIN_TIMEOUT'."
fi

# ---------------------------------------------------------------- prerequisites

try_brew() { # try_brew <formula> <tool>: only with --install-missing and a human y/N
  [ "$INSTALL_MISSING" = 1 ] || return 0
  if ! have brew; then say "    Homebrew not found (https://brew.sh); install $2 yourself."; return 0; fi
  if [ "$PROMPT_OK" = 0 ]; then say "    Not installing $2 here: a package install needs a y/N answer at a terminal."; return 0; fi
  if ask "    Run 'brew install $1'?" n; then
    if run_logged brew install "$1"; then return 0; fi
    warn "    brew install $1 failed"
  fi
}

# ---------------------------------------------------------------- confirm

if [ "$PROMPT_OK" = 1 ]; then
  say ""
  say "This will clone or update $DIR, install npm dependencies, create your user-layer files, and may set up a Keychain token, the H-1B index and the daily job (each asked first)."
  ask "Proceed?" y || { say "Aborted. Nothing was changed."; exit 1; }
fi

step "2/11 Prerequisites"
FAILED=()
for entry in "git|git|xcode-select --install (or: brew install git)" "node|node|brew install node (needs Node $NODE_SUPPORTED)" "npm|node|comes with Node: brew install node"; do
  tool="${entry%%|*}"; rest="${entry#*|}"; formula="${rest%%|*}"; fix="${rest#*|}"
  if have "$tool"; then continue; fi
  say "  missing: $tool - $fix"
  if [ "$tool" = git ]; then try_brew git git; else try_brew "$formula" "$tool"; fi
  have "$tool" || FAILED+=("$tool: $fix")
done
if [ "${#FAILED[@]}" -gt 0 ]; then
  for f in "${FAILED[@]}"; do warn "  required but missing: $f"; done
  die 1 "install the missing prerequisites above and re-run (or pass --install-missing)."
fi
NODE_VERSION="$(node --version)"
if ! lib node-supported "$NODE_VERSION" "$NODE_RANGE"; then
  die 1 "Node ${NODE_VERSION#v} is not supported; use $NODE_SUPPORTED. Install a supported Node (brew install node, or https://nodejs.org) and re-run."
fi
say "  git, node $NODE_VERSION, npm: ok"
check_data_root_conflict
# Again now node can read a .career-ops-data marker, before the daily lock or the log is taken under the root.
DATA="$(effective_data_root)"
refuse_unconfinable_root "$DATA"
validate_inputs
check_projects fetch

for entry in "gh|gh|brew install gh|the sponsorship digest PR links" "pdftotext|poppler|brew install poppler|reading PDF resumes in intake" "go|go|brew install go|the optional Go dashboard"; do
  tool="${entry%%|*}"; rest="${entry#*|}"; formula="${rest%%|*}"; rest="${rest#*|}"; fix="${rest%%|*}"; why="${rest#*|}"
  if have "$tool"; then continue; fi
  say "  optional: $tool missing ($why): $fix"
  try_brew "$formula" "$tool"
done

if CLAUDE_BIN="$(find_claude)"; then
  say "  claude: $CLAUDE_BIN"
else
  CLAUDE_BIN=""
  say "  claude: not found"
  pending "Install Claude Code, then re-run this script: curl -fsSL https://claude.ai/install.sh | bash   (or: brew install --cask claude-code). The installer never runs it for you."
fi

# ---------------------------------------------------------------- checkout

ensure_upstream() {
  if git -C "$DIR" remote get-url upstream >/dev/null 2>&1; then return 0; fi
  if [ "$DRY_RUN" = 1 ]; then dry "add the upstream remote $UPSTREAM_URL"; return 0; fi
  git -C "$DIR" remote add upstream "$UPSTREAM_URL"
  say "  added remote upstream $UPSTREAM_URL"
}

update_checkout() {
  local dirty branch
  dirty="$(git -C "$DIR" status --porcelain)"
  if [ -n "$REF" ]; then
    if [ -n "$dirty" ]; then
      say "  Not switching to $REF: the working tree has local changes."
      pending "Commit or stash your changes in $QDIR, then run: git -C $QDIR checkout $(shell_quote "$REF")"
    elif [ "$DRY_RUN" = 1 ]; then
      dry "fetch tags and check out $REF"
    else
      # Explicit, not left to set -e: its trap points at the install log, which this early step has not created yet.
      if ! git -C "$DIR" fetch --tags origin || ! git -C "$DIR" checkout "$REF"; then
        die 1 "could not check out $REF in $DIR (offline, or no such tag or branch; see the git error above)."
      fi
      say "  checked out $REF"
    fi
    return 0
  fi
  branch="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
  if [ -n "$dirty" ]; then
    say "  Not pulling: the working tree has local changes."
  elif [ "$branch" = HEAD ]; then
    say "  Not pulling: detached HEAD (a tag checkout). To follow updates run: git switch main (in $QDIR), then re-run this script."
  elif [ "$branch" != main ]; then
    say "  Not pulling: on branch $branch, not main."
  elif [ "$DRY_RUN" = 1 ]; then
    dry "git pull --ff-only"
  elif git -C "$DIR" pull --ff-only; then
    say "  up to date with origin/main"
  else
    pending "git pull --ff-only failed in $QDIR; resolve it by hand."
  fi
}

step "3/11 Checkout"
rc=0
daily_lock_take || rc=$?
if [ "$rc" = 75 ]; then
  die 1 "the daily job is running right now (it holds $DAILY_LOCK_FAILED), so the checkout and its dependencies were left as they are. Re-run this script once it finishes."
elif [ "$rc" != 0 ]; then
  die 1 "could not take the daily job's lock $DAILY_LOCK_FAILED (see the lockf error above); nothing in the checkout was changed. Fix that, then re-run this script."
fi
if [ -e "$DIR/.git" ]; then
  origin="$(git -C "$DIR" remote get-url origin 2>/dev/null)" || die 1 "$DIR is a git checkout with no origin remote; expected the fork $(redact_url "$FORK_URL")."
  lib same-repo "$origin" "$FORK_URL" || die 1 "origin of $DIR is $(redact_url "$origin"), not the fork $(redact_url "$FORK_URL"). Pick another --dir, or fix the remote."
  say "  using the existing checkout (origin $(redact_url "$origin"))"
  ensure_upstream
  update_checkout
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die 1 "$DIR exists, is not empty and is not a git checkout. Choose another --dir."
elif [ "$DRY_RUN" = 1 ]; then
  dry "git clone $(redact_url "$FORK_URL") $DIR${REF:+ and check out $REF}"
  dry "add the upstream remote $UPSTREAM_URL"
else
  git clone "$FORK_URL" "$DIR" || die 1 "git clone of $(redact_url "$FORK_URL") into $DIR failed (offline? see the git error above). Re-run once the network is back."
  if [ -n "$REF" ] && ! git -C "$DIR" checkout "$REF"; then
    die 1 "could not check out $REF in $DIR (no such tag or branch; see the git error above)."
  fi
  ensure_upstream
fi

if [ "$DRY_RUN" = 0 ]; then
  DATA="$(effective_data_root)"
  refuse_unconfinable_root "$DATA"
  LOG_FILE="$DATA/data/install/install-$(date +%Y-%m-%d).log"
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '%s' "$LOG_BUF" >> "$LOG_FILE"
  LOG_BUF=""
  say "  log: $LOG_FILE"
fi

# ---------------------------------------------------------------- dependencies

step "4/11 Dependencies"
if [ "$DRY_RUN" = 1 ]; then
  dry "install root dependencies (npm ci if package-lock.json is tracked, else npm install --no-package-lock)"
  if [ "$MAC_FEATURES" = 1 ]; then dry "npm --prefix custom/control-center ci"; fi
else
  if git -C "$DIR" ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    root_install=(npm ci)
  else
    root_install=(npm install --no-package-lock)
  fi
  if ! (cd "$DIR" && run_logged "${root_install[@]}"); then
    die 1 "${root_install[*]} failed in $DIR. See $LOG_FILE."
  fi
  if [ "$MAC_FEATURES" = 1 ]; then
    if cc_running; then
      CC_DEPS_DEFERRED=1
      if [ -n "$CC_LOCK_BLOCKED" ]; then
        CC_DEFER_BLOCKED=1
        say "  Control Center lock $CC_LOCK_BLOCKED cannot be read; leaving its dependencies as they are"
      else
        say "  Control Center is running; leaving its dependencies as they are (stop it, run 'npm --prefix custom/control-center ci', then start it again)"
      fi
    elif ! (cd "$DIR" && run_logged npm --prefix custom/control-center ci); then
      die 1 "npm ci for the Control Center failed. See $LOG_FILE."
    fi
  fi
fi

daily_lock_release

# ---------------------------------------------------------------- user layer

step "5/11 User layer"
if [ "$DRY_RUN" = 1 ]; then
  dry "declare custom/ in config/local-paths.txt"
  if [ -n "$DATA_ROOT_ARG" ]; then dry "write $DIR/.career-ops-data pointing at $DATA_REQ"; fi
  dry "create modes/_custom.md from the template if absent (with the projects-library house rule), then run doctor.mjs --json --init-templates"
  dry "NOT create config/profile.yml or portals.yml: onboarding writes them from your documents"
else
  # Captured first: set -e ignores a failing command substitution used as a case word or a [ argument.
  seeded="$(seed local-paths --dir "$DIR")" || die 1 "could not declare custom/ in $DIR/config/local-paths.txt (the error is above). Fix it and re-run."
  case "$seeded" in
    added) say "  declared custom/ in config/local-paths.txt" ;;
    *) say "  config/local-paths.txt already declares custom/" ;;
  esac
  marker="$DIR/.career-ops-data"
  if [ -n "$DATA_ROOT_ARG" ]; then
    mkdir -p "$DATA_REQ"
    if [ -f "$marker" ]; then
      current="$(trim "$(cat "$marker")")"
      [ -n "$current" ] || die 1 "$marker is empty. Remove it or write the data root into it, then re-run."
      case "$current" in /*) ;; *) current="$DIR/$current" ;; esac
      lib same-path "$current" "$DATA_REQ" || die 1 "$marker already points at $current, not $DATA_REQ. Remove the marker or drop --data-root."
    else
      printf '%s\n' "$DATA_REQ" > "$marker"
      say "  wrote $marker -> $DATA_REQ"
    fi
  fi
  DATA="$(cd "$DIR" && node --input-type=module -e "import('./path-resolver.mjs').then((m) => process.stdout.write(m.getCareerOpsRoot()))")"
  refuse_unconfinable_root "$DATA"
  mkdir -p "$DATA"
  # same-path resolves letter case too (realpathSync.native), as pwd -P does not on a case-insensitive volume.
  if [ -n "$DATA_ROOT_ARG" ] && ! lib same-path "$DATA" "$DATA_REQ"; then
    die 1 "the data root resolves to $DATA (CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR is set in your environment) instead of $DATA_REQ. Unset it and re-run."
  fi
  say "  data root: $DATA"
  seeded="$(seed custom-template --data "$DATA" --template "$SCRIPT_DIR/templates/_custom.md")" || die 1 "could not create $DATA/modes/_custom.md from the fork template (the error is above). Fix it and re-run."
  case "$seeded" in
    created)
      say "  created modes/_custom.md from the fork template"
      if ! seeded="$(seed projects-rule --data "$DATA" --template "$SCRIPT_DIR/templates/_custom-projects.md")"; then
        pending "the projects-library house rule could not be added to $DATA/modes/_custom.md (the error is above); the onboarding adds it after your yes."
      elif [ "$seeded" = added ]; then
        say "  added the projects-library house rule to modes/_custom.md"
      fi
      ;;
    *)
      say "  modes/_custom.md already exists; left as is"
      if ! grep -q '^### Projects library' "$DATA/modes/_custom.md"; then
        say "  it has no projects-library house rule yet; the onboarding adds it after your yes"
      fi
      ;;
  esac
  if ! (cd "$DIR" && node doctor.mjs --json --init-templates >/dev/null); then
    pending "node doctor.mjs --json --init-templates failed in $QDIR; run it and read the error."
  fi
fi

# ---------------------------------------------------------------- resume and documents

step "6/11 Resume and documents"
if [ -z "$RESUME" ] && [ "${#DOCS[@]}" -eq 0 ]; then
  say "  none given (use --resume resume.md [--docs a.md b.md], or the Claude Code prompt install for other formats)"
elif [ "$DRY_RUN" = 1 ]; then
  if [ -n "$RESUME" ]; then dry "copy $RESUME to documents/cv/ and seed cv.md from it when cv.md is absent"; fi
  for d in ${DOCS[@]+"${DOCS[@]}"}; do dry "copy $d to documents/projects/"; done
else
  sargs=(--data "$DATA")
  if [ -n "$RESUME" ]; then sargs+=(--resume "$RESUME"); fi
  if [ "${#DOCS[@]}" -gt 0 ]; then sargs+=(--docs "${DOCS[@]}"); fi
  copies="$(seed copy-documents "${sargs[@]}")"
  while IFS=$'\t' read -r kind what dest; do
    [ -n "$kind" ] || continue
    case "$what" in
      resume) CV_COPY="$dest" ;;
      doc) DOC_COPIES+=("$dest") ;;
    esac
    if [ "$kind" = copied ]; then say "  copied $dest"; else say "  already present: $dest"; fi
  done <<< "$copies"

  if [ -n "$RESUME" ]; then
    cv_out="$(seed cv-status --data "$DATA" --resume "$RESUME")"
    cv_state="${cv_out%%$'\n'*}"
    case "$cv_state" in
      absent)
        seed cv-write --data "$DATA" --resume "$RESUME" >/dev/null
        say "  Seeded cv.md from your resume (LF line endings, one trailing newline). Review it, it drives every evaluation."
        ;;
      identical) say "  cv.md already matches your resume; left as is" ;;
      differs)
        added="$(printf '%s\n' "$cv_out" | awk -F'\t' '$1=="added"{print $2}')"
        removed="$(printf '%s\n' "$cv_out" | awk -F'\t' '$1=="removed"{print $2}')"
        say "  cv.md already exists and differs from your resume."
        say "  Summary: $added line(s) added, $removed line(s) removed if replaced. First lines of the diff:"
        printf '%s\n' "$cv_out" | awk -F'\t' '$1=="diff"{print "    " substr($0, 6)}' | while IFS= read -r line; do say "$line"; done
        replace=0
        if [ "$REPLACE_CV" = 1 ]; then replace=1
        elif [ "$PROMPT_OK" = 1 ] && ask "Replace cv.md?" n; then replace=1; fi
        if [ "$replace" = 1 ]; then
          result="$(seed cv-write --data "$DATA" --resume "$RESUME" --replace)"
          say "  replaced cv.md; the old one is saved as ${result#*$'\t'}"
        else
          say "  cv.md left as is."
          CV_APPLIED=0
          pending "cv.md exists and differs from $RESUME, so it was not replaced. Re-run with --replace-cv to replace it (the old file is backed up as cv.md.bak-<timestamp>)."
        fi
        ;;
      *) die 1 "could not compare cv.md with the resume: $cv_out" ;;
    esac
  fi
fi

if [ -n "$PROJECTS" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    dry "copy $PROJECTS to documents/projects/ (a projects JSON as its Markdown conversion, which intake reads) and create article-digest.md from it when absent"
  else
    # Already validated in step 2; projects-seed checks again with this checkout's parser.
    lib_path="$(projects_lib)"
    [ -n "$lib_path" ] || die 1 "custom/projects/lib.mjs is missing from $DIR; the checkout is set up but article-digest.md was not created from $PROJECTS"
    proj_out="$(seed projects-seed --lib "$lib_path" --data "$DATA" --file "$PROJECTS")" || die 1 "article-digest.md was not created from $PROJECTS (see the error above); the checkout and the user layer are already set up"
    proj_copy=""
    while IFS=$'\t' read -r kind what dest; do
      case "$kind" in
        copied) proj_copy="$dest"; say "  copied $dest" ;;
        present) proj_copy="$dest"; say "  already present: $dest" ;;
        created) say "  created article-digest.md from $PROJECTS (your projects library)" ;;
        exists)
          say "  article-digest.md already exists; left as is"
          pending "article-digest.md exists, so --projects did not replace it. To add only the new projects: cd $QDIR && node custom/projects/import.mjs $(shell_quote "$proj_copy") --merge --write (run it without --write first to preview)."
          ;;
      esac
    done <<< "$proj_out"
  fi
fi

# ---------------------------------------------------------------- Keychain

step "7/11 Claude token (Keychain)"
KEYCHAIN_OK=0
# Only exit 44 (errSecItemNotFound) means the item is missing, as the Control Center, the daily job and the weekly sync
# read it: a locked or denied keychain still holds a token that works, so no new one is minted or stored over it.
KEYCHAIN_UNREADABLE=0
if [ "$MAC_FEATURES" = 0 ]; then
  say "  skipped (core-only)"
else
  keychain_check
  if [ "$KEYCHAIN_RC" = 0 ]; then
    KEYCHAIN_OK=1
    say "  Keychain item $KEYCHAIN_SERVICE exists (not read)"
  elif [ "$KEYCHAIN_RC" != 44 ]; then
    KEYCHAIN_UNREADABLE=1
    say "  $(keychain_problem "$KEYCHAIN_RC" "$KEYCHAIN_WHY" "re-run the installer")"
    pending "$(keychain_problem "$KEYCHAIN_RC" "$KEYCHAIN_WHY" "re-run the installer")"
  elif [ "$DRY_RUN" = 1 ]; then
    dry "ask you to create the Keychain item $KEYCHAIN_SERVICE with claude setup-token (the token never passes through this script)"
  else
    token_help="Store the Claude token yourself, in your own terminal: claude setup-token, then security add-generic-password -U -a \"\$USER\" -s $KEYCHAIN_SERVICE -w (paste the token at the hidden prompt, then clear your scrollback)."
    if [ -z "$CLAUDE_BIN" ]; then
      say "  Keychain item $KEYCHAIN_SERVICE is missing and Claude Code is not installed yet."
      pending "$token_help"
    elif [ "$TTY_OK" = 0 ]; then
      say "  Keychain item $KEYCHAIN_SERVICE is missing and there is no terminal to create it with."
      pending "$token_help"
    elif [ "$PROMPT_OK" = 1 ] && ! ask "Keychain item $KEYCHAIN_SERVICE is missing. Create it now with claude setup-token (uses your Claude subscription)?" y; then
      pending "$token_help"
    else
      say "  Running claude setup-token. Copy the token it prints; it is shown on your terminal only, not by this script."
      if "$CLAUDE_BIN" setup-token <&3 >&4 2>&4; then
        say "  Now paste the token at the hidden Keychain prompt (macOS asks twice)."
        security add-generic-password -U -a "${USER:-$(id -un)}" -s "$KEYCHAIN_SERVICE" -w <&3 >&4 2>&4 || true
        say "  Clear your terminal scrollback now (Cmd+K) so the token is not left on screen."
        # Only the item this run just created is read back, so an empty paste counts as missing, as every consumer
        # reads it. An item that existed before this run is never read.
        keychain_read_token
        KEYCHAIN_TOKEN=""
      else
        warn "  claude setup-token did not finish."
        keychain_check
      fi
      if [ "$KEYCHAIN_RC" = 0 ]; then
        KEYCHAIN_OK=1
        say "  Keychain item stored."
      elif [ "$KEYCHAIN_RC" != 44 ]; then
        KEYCHAIN_UNREADABLE=1
        say "  $(keychain_problem "$KEYCHAIN_RC" "$KEYCHAIN_WHY" "re-run the installer")"
        pending "$(keychain_problem "$KEYCHAIN_RC" "$KEYCHAIN_WHY" "re-run the installer")"
      else
        pending "$token_help"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- H-1B index

# same_file_path <a> <b>: whether two absolute paths name one file, however spelled (./, //, .., symlinked folders).
same_file_path() {
  [ "$1" = "$2" ] || [ "$1" -ef "$2" ] || [ "$(physical_path "$1")" = "$(physical_path "$2")" ]
}

step "8/11 H-1B sponsor index"
# Resolved as the plugin's indexPath() does: trimmed, set-but-blank is an error, and a relative path is taken from the
# checkout, which is where the plugin runs.
H1B_CMD="cd $QDIR && node plugins.mjs enable h1b-sponsor --confirm && node plugins/h1b-sponsor/install-h1b-index.mjs"
H1B_DEFAULT="$DIR/data/h1b/index.ndjson.gz"
H1B_INDEX="$H1B_DEFAULT"
H1B_BLANK=0
if [ -n "${H1B_INDEX_PATH+set}" ]; then
  H1B_INDEX="$(trim "$H1B_INDEX_PATH")"
  case "$H1B_INDEX" in
    '') H1B_BLANK=1 ;;
    /*) ;;
    *) H1B_INDEX="$DIR/$H1B_INDEX" ;;
  esac
fi
# The launchd plist does not carry H1B_INDEX_PATH, so the daily job always reads the default index; step 10 raises this
# once it has installed the job and the default index is still not there.
H1B_DAILY_NOTE=""
if [ "$NO_H1B" = 0 ] && [ "$H1B_BLANK" = 0 ] && ! same_file_path "$H1B_INDEX" "$H1B_DEFAULT"; then
  H1B_DAILY_NOTE="H1B_INDEX_PATH points at $H1B_INDEX, but the daily job does not inherit H1B_INDEX_PATH and reads $H1B_DEFAULT. Copy the index there, or unset H1B_INDEX_PATH and run: $H1B_CMD"
fi
if [ "$NO_H1B" = 1 ]; then
  say "  skipped (--no-h1b-index); install later: $H1B_CMD"
elif [ "$H1B_BLANK" = 1 ]; then
  pending "H1B_INDEX_PATH is set but empty, so the h1b-sponsor plugin cannot read the H-1B index. Unset it to use the default index location, then run: $H1B_CMD"
elif [ -f "$H1B_INDEX" ]; then
  say "  index already installed: $H1B_INDEX"
elif [ "$DRY_RUN" = 1 ]; then
  dry "enable the h1b-sponsor plugin and download the index (about 8 MiB from github.com)"
elif [ "$PROMPT_OK" = 1 ] && ! ask "Enable the h1b-sponsor plugin and download the H-1B index (about 8 MiB from github.com)?" y; then
  # Declined like --no-h1b-index, so the daily job's index is left unmentioned too.
  H1B_DAILY_NOTE=""
  say "  skipped; install later: $H1B_CMD"
elif (cd "$DIR" && run_logged node plugins.mjs enable h1b-sponsor --confirm) && (cd "$DIR" && run_logged node plugins/h1b-sponsor/install-h1b-index.mjs); then
  say "  H-1B index installed"
else
  pending "The H-1B index download failed. Retry: $H1B_CMD"
fi

# ---------------------------------------------------------------- onboarding

doctor_state() { # prints "ready" or "incomplete<TAB>files"
  local json
  json="$(cd "$DIR" && node doctor.mjs --json 2>/dev/null)" || true
  printf '%s' "$json" | lib doctor-state
}

onboard_inputs() {
  ONBOARD_ARGS=()
  if [ "$CV_APPLIED" = 0 ]; then ONBOARD_ARGS+=(--cv-not-applied); fi
  if [ -n "$CV_COPY" ]; then ONBOARD_ARGS+=("$CV_COPY"); else ONBOARD_ARGS+=(""); fi
  if [ "${#DOC_COPIES[@]}" -gt 0 ]; then ONBOARD_ARGS+=("${DOC_COPIES[@]}"); fi
}

print_onboard_command() {
  local prompt="$1"
  say "  To personalize career-ops from your documents, run:"
  say "    cd $QDIR && claude $(shell_quote "$prompt")"
}

step "9/11 Onboarding"
if [ "$DRY_RUN" = 1 ]; then
  dry "offer to personalize career-ops from your documents (--onboard ${ONBOARD_MODE:-interactive|none})"
else
  mode="$ONBOARD_MODE"
  state_line="$(doctor_state)"
  onboard_inputs
  prompt="$(lib onboard-prompt "${ONBOARD_ARGS[@]}")"
  if [ -z "$mode" ]; then
    if [ "${state_line%%$'\t'*}" = ready ] && [ -z "$RESUME" ] && [ "${#DOCS[@]}" -eq 0 ]; then
      mode=skip
    elif [ "$PROMPT_OK" = 1 ] && [ -n "$CLAUDE_BIN" ] && ask "Start Claude Code now to personalize career-ops from your documents?" y; then
      mode=interactive
    elif [ "$ASSUME_YES" = 1 ] && [ "$TTY_OK" = 1 ] && [ "$DRY_RUN" = 0 ] && [ -n "$CLAUDE_BIN" ]; then
      # --yes takes the default answer, which is yes: start onboarding as --help documents.
      mode=interactive
    else
      mode=none
    fi
  fi
  case "$mode" in
    skip) say "  career-ops is already personalized" ;;
    none) print_onboard_command "$prompt" ;;
    interactive)
      if [ -z "$CLAUDE_BIN" ]; then
        print_onboard_command "$prompt"
        pending "Install Claude Code, then run the onboarding command printed above."
      elif [ "$TTY_OK" = 0 ]; then
        print_onboard_command "$prompt"
        pending "Run the interactive onboarding command printed above in a terminal."
      else
        say "  Starting Claude Code. Answer its questions; type /exit when you are done."
        (cd "$DIR" && "$CLAUDE_BIN" "$prompt" <&3 >&4 2>&4) || warn "  claude exited with an error."
      fi
      ;;
    headless)
      draft="$DATA/data/install/onboarding-draft"
      headless_ready=0
      if [ -z "$CLAUDE_BIN" ]; then
        pending "Install Claude Code, then re-run with --onboard headless (or run the interactive command)."
      elif [ "$MAC_FEATURES" = 0 ] && [ "$OS" != Darwin ]; then
        say "  Headless onboarding reads the Claude token from the macOS Keychain, so it runs only on macOS."
        pending "Run the interactive onboarding instead: cd $QDIR && claude $(shell_quote "$prompt")"
      elif [ "$MAC_FEATURES" = 0 ]; then
        # Step 7 skipped the Keychain, so KEYCHAIN_OK=0 says nothing about whether the token is stored.
        say "  Headless onboarding reads the Claude token from the macOS Keychain, which --core-only skips."
        pending "To use --onboard headless, re-run without --core-only. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
      elif [ "$KEYCHAIN_UNREADABLE" = 1 ]; then
        say "  Headless onboarding needs to read the Keychain item $KEYCHAIN_SERVICE, which could not be read (see step 7)."
        pending "Make the Keychain item readable (see step 7), then re-run with --onboard headless. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
      elif [ "$KEYCHAIN_OK" = 0 ]; then
        say "  Headless onboarding needs the Keychain item $KEYCHAIN_SERVICE."
        pending "Store the Keychain token, then re-run with --onboard headless. Without it, run: cd $QDIR && claude $(shell_quote "$prompt")"
      elif ! claude_version="$("$CLAUDE_BIN" --version 2>/dev/null)" || ! lib version-ge "${claude_version%% *}" "$CLAUDE_HEADLESS_MIN"; then
        # Older builds ignore CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, so hook and tool children would inherit the token,
        # or lack --restricted, so the user's own settings (allow rules, hooks) would widen the session.
        say "  Headless onboarding needs Claude Code $CLAUDE_HEADLESS_MIN or later, which keeps the token out of hooks and tools and confines the session (found: ${claude_version:-unknown})."
        # claude update can land on a version newer than the probed ones, which the gate below refuses: name an approved one.
        update_hint="claude update"
        gate="$(headless_claude_gate)"
        IFS=$'\037' read -r gate_state gate_found gate_approved gate_identity gate_fix <<< "$gate"
        if [ -n "$gate_fix" ]; then
          update_hint="claude update installs the latest, which may not be approved yet; claude install $gate_fix installs an approved one"
        elif [ "$gate_approved" = "none yet" ]; then
          update_hint="claude update; no Claude Code version is approved for headless onboarding yet, so until one is run the interactive command"
        elif [ "$gate_approved" != unknown ]; then
          update_hint="claude update; no approved Claude Code version meets $CLAUDE_HEADLESS_MIN yet, so until one does run the interactive command"
        fi
        pending "Update Claude Code ($update_hint), then re-run with --onboard headless. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
      elif gate="$(headless_claude_gate)"; IFS=$'\037' read -r gate_state gate_found gate_approved gate_identity gate_fix <<< "$gate"; [ "$gate_state" != approved ]; then
        if [ "$gate_state" = unapproved ]; then
          # A newer CLI than the probed ones can change what --restricted and the scrub do while still passing >= MIN.
          say "  Headless onboarding runs only on a Claude Code version the Control Center approves (approved: $gate_approved; found: $gate_found), because an unprobed one can change what --restricted and the token scrub do."
          if [ -n "$gate_fix" ]; then
            pending "Get an approved version (claude install $gate_fix), then re-run with --onboard headless. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
          elif [ "$gate_approved" = "none yet" ]; then
            pending "No Claude Code version is approved for headless onboarding yet. Run: cd $QDIR && claude $(shell_quote "$prompt")"
          else
            pending "No approved Claude Code version meets $CLAUDE_HEADLESS_MIN yet. Run: cd $QDIR && claude $(shell_quote "$prompt")"
          fi
        else
          say "  Headless onboarding could not read the approved Claude Code versions or the installed one: $gate_found"
          pending "Fix the problem above (a checkout without the Control Center contract is fixed by re-running the installer), then re-run with --onboard headless. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
        fi
      elif keychain_read_token; [ "$KEYCHAIN_RC" != 0 ]; then
        # Read before the earlier drafts are moved aside: a refused run leaves them where "Resume from drafts" looks.
        # The token the daily job and the Control Center would read is not usable either, so they wait as step 7 makes them.
        KEYCHAIN_OK=0
        if [ "$KEYCHAIN_RC" != 44 ]; then KEYCHAIN_UNREADABLE=1; fi
        say "  $(keychain_problem "$KEYCHAIN_RC" "$KEYCHAIN_WHY" "re-run with --onboard headless")"
        say "  Headless onboarding did not run."
        pending "Fix the Keychain item as described above, then re-run with --onboard headless. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
      else
        # Drafts from an earlier run would be listed as this run's and picked up by "Resume from drafts": they hold
        # personal data, so they are moved aside, not deleted.
        if [ -d "$draft" ] && [ -n "$(ls -A "$draft" 2>/dev/null)" ]; then
          prev="$draft.prev-$(date +%Y%m%d-%H%M%S)-$$"
          if mv "$draft" "$prev"; then
            say "  Moved the drafts of an earlier headless run to $prev."
          else
            warn "  Could not move the earlier drafts out of $draft; they are listed with this run's."
          fi
        fi
        mkdir -p "$draft"
        inputs=()
        if [ -n "$CV_COPY" ]; then inputs+=("$CV_COPY"); fi
        if [ "${#DOC_COPIES[@]}" -gt 0 ]; then inputs+=("${DOC_COPIES[@]}"); fi
        hprompt="$(lib render-headless "$SCRIPT_DIR/onboard-headless-prompt.md" "$draft" ${inputs[@]+"${inputs[@]}"})"
        extra_dirs=()
        if [ "$DATA" != "$DIR" ]; then extra_dirs=(--add-dir "$DATA"); fi
        # The binary checked above, asked again just before it gets the token: an npm or Homebrew update rewrites it in
        # place at the same path, so its real path alone does not pin the version.
        recheck="$(headless_claude_gate)"
        IFS=$'\037' read -r _ _ _ recheck_identity _ <<< "$recheck"
        headless_ready=1
      fi
      if [ "$headless_ready" = 1 ] && [ "$recheck_identity" != "$gate_identity" ]; then
        say "  Claude Code changed while onboarding was being prepared (approved: $gate_identity; now: ${recheck_identity:--}); nothing was run."
        pending "Re-run with --onboard headless once Claude Code has finished updating. Or run: cd $QDIR && claude $(shell_quote "$prompt")"
        headless_ready=0
        KEYCHAIN_TOKEN=""
      fi
      if [ "$headless_ready" = 1 ]; then
        say "  Running a restricted headless Claude (reads your documents, writes drafts only to $draft). This uses your Claude subscription."
        # The token lives only in the child's environment; it is never echoed, logged or placed on a command line.
        # As in the Control Center's sessions, SUBPROCESS_ENV_SCRUB keeps it out of hook and tool children, and
        # --strict-mcp-config starts none of the user's or the project's MCP servers, which would inherit it.
        # --restricted loads no user, project or local settings, so their allow rules and hooks cannot widen
        # --tools; what it would otherwise keep is disallowed by name, and --settings turns off any remaining hooks.
        # It starts the real path the gate approved, not a symlink an update could re-point, with the autoupdater off.
        if (strip_claude_credentials && cd "$DIR" && CLAUDE_CODE_OAUTH_TOKEN="$KEYCHAIN_TOKEN" ANTHROPIC_API_KEY="" \
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 DISABLE_AUTOUPDATER=1 \
          "${gate_identity%@*}" -p "$hprompt" --effort medium --restricted --tools Read,Glob,Grep,Edit,Write \
          --disallowedTools Bash,PowerShell,WebFetch,WebSearch,Task,Agent,NotebookEdit --settings '{"disableAllHooks":true}' \
          --permission-mode dontAsk --strict-mcp-config --add-dir "$draft" ${extra_dirs[@]+"${extra_dirs[@]}"} \
          --allowedTools Read Glob Grep "Edit(/$draft/**)" --max-turns 40 --output-format text); then
          say "  Drafts written:"
          for f in "$draft"/*; do
            if [ -e "$f" ]; then say "    $f"; fi
          done
        else
          warn "  The headless run did not finish cleanly; review any drafts in $draft."
        fi
        KEYCHAIN_TOKEN=""
        say "  Review the drafts, then finish interactively (nothing live was written):"
        say "    cd $QDIR && claude $(shell_quote 'Read custom/install/ONBOARDING.md and follow it.')"
      fi
      ;;
  esac
fi

# ---------------------------------------------------------------- launchd

step "10/11 Daily job (launchd)"
DAILY_CMD="bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs daily"
if [ "$MAC_FEATURES" = 0 ]; then
  say "  skipped (core-only)"
elif [ "$NO_LAUNCHD" = 1 ]; then
  say "  skipped (--no-launchd); install later: $DAILY_CMD"
elif [ "$DRY_RUN" = 1 ]; then
  dry "install the daily 8am job once onboarding is complete and the Keychain item exists (--jobs $([ "$WITH_UPSTREAM_SYNC" = 1 ] && echo all || echo daily))"
else
  state_line="$(doctor_state)"
  if [ "${state_line%%$'\t'*}" != ready ]; then
    say "  Onboarding is not finished (still needed: ${state_line#*$'\t'}); not installing the job yet."
    pending "Finish onboarding, then install the daily job: $DAILY_CMD"
  elif [ "$KEYCHAIN_UNREADABLE" = 1 ]; then
    say "  The Keychain item could not be read, so the job would fail every morning; not installing it yet."
    pending "Make the Keychain item readable (see step 7), then install the daily job: $DAILY_CMD"
  elif [ "$KEYCHAIN_OK" = 0 ]; then
    say "  The Keychain item is missing, so the job would fail every morning; not installing it yet."
    pending "Store the Keychain token, then install the daily job: $DAILY_CMD"
  else
    jobs=daily
    if [ "$WITH_UPSTREAM_SYNC" = 1 ]; then jobs=all; fi
    if [ -f "$HOME/Library/LaunchAgents/com.career-ops.immigration-watch.plist" ]; then
      # Reinstalled so its paths follow this checkout and data root; launchd/install.sh keeps the time and on/off state
      # set in the Control Center (Runs & Schedule).
      say "  The daily job is already installed; reinstalling it for this checkout keeps its time and on/off state from the Control Center."
    else
      say "  The daily job (08:00) runs headless Claude on your subscription: policy watch, scan, rank, shortlist."
    fi
    place="$(fda_place "$DIR")"
    [ -z "$place" ] || say "  Note: the checkout is under $place; give /bin/bash Full Disk Access (System Settings > Privacy & Security) so launchd can read it."
    # The job's bash writes its lock, day logs and launchd logs under the data root, so that needs it too.
    place="$(fda_place "$DATA")"
    [ -z "$place" ] || say "  Note: the data root is under $place; give /bin/bash Full Disk Access (System Settings > Privacy & Security) so launchd can write it."
    if [ "$PROMPT_OK" = 1 ] && ! ask "Install the daily job now?" y; then
      say "  skipped; install later: $DAILY_CMD"
    else
      rc=0
      lock_rc=0
      daily_lock_take || lock_rc=$?
      if [ "$lock_rc" = 0 ]; then
        run_logged bash "$DIR/custom/launchd/install.sh" --jobs "$jobs" || rc=$?
        daily_lock_release
      fi
      if [ "$lock_rc" = 75 ]; then
        pending "The daily job is running right now, so it was left as it was. Once it finishes, run: bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs $jobs"
      elif [ "$lock_rc" != 0 ]; then
        pending "Could not take the daily job's lock $DAILY_LOCK_FAILED (see the lockf error above), so the launchd job was left as it was. Fix that, then run: bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs $jobs"
      elif [ "$rc" = 4 ]; then
        # launchd/install.sh never boots out a job mid-run: it changed nothing.
        pending "A launchd job is running right now, so it was left as it was. Once it finishes, run: bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs $jobs"
      elif [ "$rc" != 0 ]; then
        pending "The launchd install failed. Retry: bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs $jobs"
      elif [ -n "$H1B_DAILY_NOTE" ] && [ ! -f "$H1B_DEFAULT" ]; then
        pending "$H1B_DAILY_NOTE"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- health

step "11/11 Health checks"
if [ "$DRY_RUN" = 1 ]; then
  dry "run node doctor.mjs, the custom/*/tests specs and the Control Center preflight"
else
  if ! (cd "$DIR" && run_logged node doctor.mjs); then
    pending "node doctor.mjs reported problems; run it in $QDIR and read the output."
  fi
  specs=("$DIR"/custom/*/tests/*.spec.mjs)
  if [ -n "${CAREER_OPS_IN_SELFTEST:-}" ]; then
    # A spec that runs this installer must not start the specs again (each level would run the next).
    say "  already inside a self-test run; skipping the self-tests"
  elif [ -e "${specs[0]}" ]; then
    if ! (cd "$DIR" && export CAREER_OPS_IN_SELFTEST=1 && run_logged node --test custom/*/tests/*.spec.mjs); then
      pending "The fork self-tests failed (node --test custom/*/tests/*.spec.mjs in $QDIR); see $LOG_FILE."
    fi
  else
    say "  no custom/*/tests specs in this checkout; skipping the self-tests"
  fi
  if [ "$MAC_FEATURES" = 1 ] && [ "$KEYCHAIN_OK" = 1 ]; then
    if ! (cd "$DIR" && run_logged npm --prefix custom/control-center run preflight); then
      PREFLIGHT_FAILED=1
      pending "The Control Center preflight failed; run: npm --prefix $(shell_quote "$DIR/custom/control-center") run preflight, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")"
    fi
  elif [ "$MAC_FEATURES" = 1 ] && [ "$KEYCHAIN_UNREADABLE" = 1 ]; then
    say "  Control Center preflight skipped until the Keychain item can be read"
  elif [ "$MAC_FEATURES" = 1 ]; then
    say "  Control Center preflight skipped until the Keychain item exists"
  fi
fi

# ---------------------------------------------------------------- finish

say ""
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run finished. Nothing was changed."
  exit 0
fi
# A failed preflight means the Control Center would not run as it should: it is not started, so the pending actions
# below (and exit 3) stay what the run ends with. Whether it is running is asked once, so the pending list and the
# start below cannot disagree about it.
CC_START=0
CC_LIVE=0
if [ "$NO_START" = 0 ] && [ "$MAC_FEATURES" = 1 ] && [ "$KEYCHAIN_OK" = 1 ] && [ -n "$CLAUDE_BIN" ] && [ "$PREFLIGHT_FAILED" = 0 ]; then
  CC_START=1
fi
if [ "$CC_START" = 1 ] || [ "$CC_DEPS_DEFERRED" = 1 ]; then
  if cc_running; then CC_LIVE=1; fi
fi
# The skipped npm ci is installed below only when this run starts the Control Center; while it is still running, or
# when this run will not start it, the new code would run on the old node_modules (bin/cc only checks they exist).
# It goes first: a failed preflight listed above ran against those old dependencies.
if [ "$CC_DEPS_DEFERRED" = 1 ] && [ "$CC_LIVE" = 1 ] && [ -n "$CC_LOCK_BLOCKED" ]; then
  PENDING=("The Control Center lock $(shell_quote "$CC_LOCK_BLOCKED") cannot be read, so its dependencies were not reinstalled: if no Control Center is running, remove that lock, run npm --prefix $(shell_quote "$DIR/custom/control-center") ci, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")" ${PENDING[@]+"${PENDING[@]}"})
elif [ "$CC_LIVE" = 1 ] && [ -n "$CC_LOCK_BLOCKED" ]; then
  PENDING=("The Control Center lock $(shell_quote "$CC_LOCK_BLOCKED") cannot be read, so it was not started: if no Control Center is running, remove that lock, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")" ${PENDING[@]+"${PENDING[@]}"})
elif [ "$CC_DEPS_DEFERRED" = 1 ] && [ "$CC_LIVE" = 1 ] && [ "$CC_DEFER_BLOCKED" = 1 ]; then
  PENDING=("The Control Center lock could not be read when its dependencies were due, and a Control Center is running now: stop it, run npm --prefix $(shell_quote "$DIR/custom/control-center") ci, then start it again." ${PENDING[@]+"${PENDING[@]}"})
elif [ "$CC_DEPS_DEFERRED" = 1 ] && [ "$CC_LIVE" = 1 ]; then
  PENDING=("The Control Center was running, so its dependencies were not reinstalled: stop it, run npm --prefix $(shell_quote "$DIR/custom/control-center") ci, then start it again." ${PENDING[@]+"${PENDING[@]}"})
elif [ "$CC_DEPS_DEFERRED" = 1 ] && [ "$CC_START" = 0 ] && [ "$CC_DEFER_BLOCKED" = 1 ]; then
  PENDING=("The Control Center lock could not be read, so its dependencies were not reinstalled; it is gone now: run npm --prefix $(shell_quote "$DIR/custom/control-center") ci, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")" ${PENDING[@]+"${PENDING[@]}"})
elif [ "$CC_DEPS_DEFERRED" = 1 ] && [ "$CC_START" = 0 ]; then
  PENDING=("The Control Center was running, so its dependencies were not reinstalled; it has stopped since: run npm --prefix $(shell_quote "$DIR/custom/control-center") ci, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")" ${PENDING[@]+"${PENDING[@]}"})
fi
if [ "${#PENDING[@]}" -gt 0 ]; then
  say "Done, with pending actions:"
  n=0
  for p in "${PENDING[@]}"; do n=$((n + 1)); say "  $n. $p"; done
else
  say "Done."
fi

if [ "$CC_START" = 1 ]; then
  if [ "$CC_LIVE" = 1 ] && [ -n "$CC_LOCK_BLOCKED" ]; then
    say "Control Center not started: its lock $(shell_quote "$CC_LOCK_BLOCKED") cannot be read"
  elif [ "$CC_LIVE" = 1 ]; then
    say "Control Center is already running; not starting a second instance"
  else
    # It was running when its npm ci was skipped and has stopped since: install what it was left without first, and
    # check the result again, since the preflight above ran against the dependencies it had then.
    if [ "$CC_DEPS_DEFERRED" = 1 ]; then
      if ! (cd "$DIR" && run_logged npm --prefix custom/control-center ci); then
        die 1 "npm ci for the Control Center failed. See $LOG_FILE."
      fi
      if ! (cd "$DIR" && run_logged npm --prefix custom/control-center run preflight); then
        say "The Control Center preflight failed after its npm ci, so it was not started; run: npm --prefix $(shell_quote "$DIR/custom/control-center") run preflight, then start it: $(shell_quote "$DIR/custom/control-center/bin/cc")"
        exit 3
      fi
    fi
    say "Starting the Control Center (Ctrl+C stops it). Open the token URL it prints."
    exec "$DIR/custom/control-center/bin/cc" 3<&- 4>&-
  fi
fi
if [ "${#PENDING[@]}" -gt 0 ]; then exit 3; fi
exit 0
