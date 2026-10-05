#!/usr/bin/env bash
# Installer for the H-1B-aware career-ops fork (Divy2000/career-ops). The recommended install is the
# Claude Code prompt in .github/README.md (any resume format); this script is the second option and
# takes the resume as Markdown. Idempotent: every step checks first and skips what is already done.
# Written for the bash 3.2 that macOS ships.
set -eEuo pipefail
trap 'echo "install.sh: unexpected failure at line $LINENO (see the install log)" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FORK_URL="${CAREER_OPS_REPO_URL:-https://github.com/Divy2000/career-ops.git}"
UPSTREAM_URL="https://github.com/career-ops-hq/career-ops.git"
NODE_FLOOR="22.6.0"
KEYCHAIN_SERVICE="career-ops-claude-token"
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
TTY_OK=0
PROMPT_OK=0
CV_COPY=""
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

keychain_present() { security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; }

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }

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
  local mode="$1" lib="" rc=0 scratch=""
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
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/career-ops-validator.XXXXXX")"
    if git clone --quiet --depth 1 ${REF:+--branch "$REF"} "$FORK_URL" "$scratch/repo" >/dev/null 2>&1 && [ -f "$scratch/repo/custom/projects/lib.mjs" ]; then
      lib="$scratch/repo/custom/projects/lib.mjs"
    else
      rm -rf "$scratch"
      printf 'error: could not fetch the projects validator (custom/projects/lib.mjs from %s) to check --projects.\n%s Retry, or run without --projects and import the file later in the Control Center (Profile > Projects).\n' "$FORK_URL" "$PROJECTS_NO_CHANGE" >&2
      exit 1
    fi
  fi
  node "$SCRIPT_DIR/seed.mjs" projects-check --lib "$lib" --file "$PROJECTS" >/dev/null || rc=$?
  if [ -n "$scratch" ]; then rm -rf "$scratch"; fi
  if [ "$rc" -ne 0 ]; then
    printf '%s Fix the projects file above: one "## Title -- link" block per project with "- " bullets, or a projects JSON.\n' "$PROJECTS_NO_CHANGE" >&2
    exit 2
  fi
  PROJECTS_CHECKED=1
}

# ---------------------------------------------------------------- intro and platform

check_data_root_conflict
DATA="$(effective_data_root)"
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
for entry in "git|git|xcode-select --install (or: brew install git)" "node|node|brew install node (needs Node >= $NODE_FLOOR)" "npm|node|comes with Node: brew install node"; do
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
if ! lib version-ge "$NODE_VERSION" "$NODE_FLOOR"; then
  die 1 "Node $NODE_VERSION is older than the required $NODE_FLOOR. Install a newer Node (brew install node, or https://nodejs.org) and re-run."
fi
say "  git, node $NODE_VERSION, npm: ok"
check_data_root_conflict
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
      git -C "$DIR" fetch --tags origin
      git -C "$DIR" checkout "$REF"
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
if [ -e "$DIR/.git" ]; then
  origin="$(git -C "$DIR" remote get-url origin 2>/dev/null)" || die 1 "$DIR is a git checkout with no origin remote; expected the fork $FORK_URL."
  lib same-repo "$origin" "$FORK_URL" || die 1 "origin of $DIR is $origin, not the fork $FORK_URL. Pick another --dir, or fix the remote."
  say "  using the existing checkout (origin $origin)"
  ensure_upstream
  update_checkout
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die 1 "$DIR exists, is not empty and is not a git checkout. Choose another --dir."
elif [ "$DRY_RUN" = 1 ]; then
  dry "git clone $FORK_URL $DIR${REF:+ and check out $REF}"
  dry "add the upstream remote $UPSTREAM_URL"
else
  git clone "$FORK_URL" "$DIR"
  if [ -n "$REF" ]; then git -C "$DIR" checkout "$REF"; fi
  ensure_upstream
fi

if [ "$DRY_RUN" = 0 ]; then
  DATA="$(effective_data_root)"
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
    if ! (cd "$DIR" && run_logged npm --prefix custom/control-center ci); then
      die 1 "npm ci for the Control Center failed. See $LOG_FILE."
    fi
  fi
fi

# ---------------------------------------------------------------- user layer

step "5/11 User layer"
if [ "$DRY_RUN" = 1 ]; then
  dry "declare custom/ in config/local-paths.txt"
  if [ -n "$DATA_ROOT_ARG" ]; then dry "write $DIR/.career-ops-data pointing at $DATA_REQ"; fi
  dry "create modes/_custom.md from the template if absent (with the projects-library house rule), then run doctor.mjs --json --init-templates"
  dry "NOT create config/profile.yml or portals.yml: onboarding writes them from your documents"
else
  case "$(seed local-paths --dir "$DIR")" in
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
  mkdir -p "$DATA"
  if [ -n "$DATA_ROOT_ARG" ] && [ "$(cd "$DATA" && pwd -P)" != "$(cd "$DATA_REQ" && pwd -P)" ]; then
    die 1 "the data root resolves to $DATA (CAREER_OPS_ROOT or CAREER_OPS_DATA_DIR is set in your environment) instead of $DATA_REQ. Unset it and re-run."
  fi
  say "  data root: $DATA"
  case "$(seed custom-template --data "$DATA" --template "$SCRIPT_DIR/templates/_custom.md")" in
    created)
      say "  created modes/_custom.md from the fork template"
      if [ "$(seed projects-rule --data "$DATA" --template "$SCRIPT_DIR/templates/_custom-projects.md")" = added ]; then
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
if [ "$MAC_FEATURES" = 0 ]; then
  say "  skipped (core-only)"
elif keychain_present; then
  KEYCHAIN_OK=1
  say "  Keychain item $KEYCHAIN_SERVICE exists (not read)"
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
    else
      warn "  claude setup-token did not finish."
    fi
    if keychain_present; then KEYCHAIN_OK=1; say "  Keychain item stored."; else pending "$token_help"; fi
  fi
fi

# ---------------------------------------------------------------- H-1B index

step "8/11 H-1B sponsor index"
H1B_INDEX="${H1B_INDEX_PATH:-$DIR/data/h1b/index.ndjson.gz}"
H1B_CMD="cd $QDIR && node plugins.mjs enable h1b-sponsor --confirm && node plugins/h1b-sponsor/install-h1b-index.mjs"
if [ "$NO_H1B" = 1 ]; then
  say "  skipped (--no-h1b-index); install later: $H1B_CMD"
elif [ -f "$H1B_INDEX" ]; then
  say "  index already installed: $H1B_INDEX"
elif [ "$DRY_RUN" = 1 ]; then
  dry "enable the h1b-sponsor plugin and download the index (about 8 MiB from github.com)"
elif [ "$PROMPT_OK" = 1 ] && ! ask "Enable the h1b-sponsor plugin and download the H-1B index (about 8 MiB from github.com)?" y; then
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
      if [ -z "$CLAUDE_BIN" ]; then
        pending "Install Claude Code, then re-run with --onboard headless (or run the interactive command)."
      elif [ "$KEYCHAIN_OK" = 0 ]; then
        say "  Headless onboarding needs the Keychain item $KEYCHAIN_SERVICE."
        pending "Store the Keychain token, then re-run with --onboard headless. Without it, run: cd $QDIR && claude $(shell_quote "$prompt")"
      else
        mkdir -p "$draft"
        inputs=()
        if [ -n "$CV_COPY" ]; then inputs+=("$CV_COPY"); fi
        if [ "${#DOC_COPIES[@]}" -gt 0 ]; then inputs+=("${DOC_COPIES[@]}"); fi
        hprompt="$(lib render-headless "$SCRIPT_DIR/onboard-headless-prompt.md" "$draft" ${inputs[@]+"${inputs[@]}"})"
        extra_dirs=()
        if [ "$DATA" != "$DIR" ]; then extra_dirs=(--add-dir "$DATA"); fi
        say "  Running a restricted headless Claude (reads your documents, writes drafts only to $draft). This uses your Claude subscription."
        # The token lives only in the child's environment; it is never echoed, logged or placed on a command line.
        if (cd "$DIR" && CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w)" ANTHROPIC_API_KEY="" \
          "$CLAUDE_BIN" -p "$hprompt" --permission-mode dontAsk --add-dir "$draft" ${extra_dirs[@]+"${extra_dirs[@]}"} \
          --allowedTools Read Glob Grep "Edit(/$draft/**)" --max-turns 40 --output-format text); then
          say "  Drafts written:"
          for f in "$draft"/*; do
            if [ -e "$f" ]; then say "    $f"; fi
          done
        else
          warn "  The headless run did not finish cleanly; review any drafts in $draft."
        fi
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
  elif [ "$KEYCHAIN_OK" = 0 ]; then
    say "  The Keychain item is missing, so the job would fail every morning; not installing it yet."
    pending "Store the Keychain token, then install the daily job: $DAILY_CMD"
  else
    jobs=daily
    if [ "$WITH_UPSTREAM_SYNC" = 1 ]; then jobs=all; fi
    say "  The daily job (08:00) runs headless Claude on your subscription: policy watch, scan, rank, shortlist."
    case "$DIR" in "$HOME/Desktop"/* | "$HOME/Documents"/*) say "  Note: this checkout is under Desktop or Documents; give /bin/bash Full Disk Access (System Settings > Privacy & Security) so launchd can read it." ;; esac
    if [ "$PROMPT_OK" = 1 ] && ! ask "Install the daily job now?" y; then
      say "  skipped; install later: $DAILY_CMD"
    elif ! run_logged bash "$DIR/custom/launchd/install.sh" --jobs "$jobs"; then
      pending "The launchd install failed. Retry: bash $(shell_quote "$DIR/custom/launchd/install.sh") --jobs $jobs"
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
      pending "The Control Center preflight failed; run: npm --prefix $(shell_quote "$DIR/custom/control-center") run preflight"
    fi
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
if [ "${#PENDING[@]}" -gt 0 ]; then
  say "Done, with pending actions:"
  n=0
  for p in "${PENDING[@]}"; do n=$((n + 1)); say "  $n. $p"; done
else
  say "Done."
fi

if [ "$NO_START" = 0 ] && [ "$MAC_FEATURES" = 1 ] && [ "$KEYCHAIN_OK" = 1 ] && [ -n "$CLAUDE_BIN" ]; then
  say "Starting the Control Center (Ctrl+C stops it). Open the token URL it prints."
  exec "$DIR/custom/control-center/bin/cc" 3<&- 4>&-
fi
if [ "${#PENDING[@]}" -gt 0 ]; then exit 3; fi
exit 0
