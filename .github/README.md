# H-1B-aware fork of career-ops

An **unofficial fork** of [career-ops](https://github.com/career-ops-hq/career-ops), the AI job-search command center that runs inside Claude Code. This fork keeps everything upstream does (evaluate offers, tailor CVs, scan portals, track applications) and adds what a job seeker who **needs US visa sponsorship** has to track by hand: a daily immigration-policy watch, a per-company sponsorship check, sponsorship-aware ranking, and a local Control Center web app.

> This fork is not affiliated with and not endorsed by the career-ops project or its maintainers. See [Credits, license and trademark](#credits-license-and-trademark).

## Who it is for

- Job seekers in the US who need H-1B or green card sponsorship (or are on OPT/STEM OPT and expect to).
- Computer science and data roles: backend, AI/ML, data, platform.
- People comfortable running a few commands on a Mac and paying for a Claude subscription. Nothing here applies to jobs for you: you always press Submit yourself.

## Quick start

Pick one path. Both end in the same place: a checkout in `~/career-ops` with your personal files kept out of git.

### Option 1 (recommended): install with a Claude Code prompt

Claude Code does the install and then builds your profile from your documents. It accepts your resume and project documents in **any format**: PDF, DOCX, Pages (export first), Markdown, plain text, LaTeX, JSON Resume, HTML, images or screenshots, a LinkedIn data export ZIP, a project folder or ZIP.

1. Install [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) and sign in.
2. Run `claude` in any folder.
3. Paste this prompt. Replace the line that starts with `My documents` with the real paths (drag files into the terminal to paste their paths).

```text
I want to install the H-1B-aware career-ops fork (Divy2000/career-ops). Follow these steps in order and never skip a confirmation.

1. Show me your plan first: every command you will run and every folder you will create or change. Ask me before each system change (installing software, cloning, writing outside the clone). Wait for my yes.
2. Check the requirements: macOS, git, Node.js 22.6 or newer, npm and the claude CLI. Tell me what is missing and how to install it. Do not install system software without asking me.
3. Clone the fork at the pinned tag into ~/career-ops:
   git clone --branch fork-install-v2 https://github.com/Divy2000/career-ops.git ~/career-ops
4. Run the installer from the clone:
   cd ~/career-ops
   custom/install/install.sh --non-interactive --no-start --no-launchd --onboard none
   It exits 3 when actions are still pending, such as the missing Keychain item. That is expected: relay every pending action it prints.
5. The Keychain step must be done by me in my own terminal, because your Bash tool cannot take hidden input. Give me the exact commands (claude setup-token, then security add-generic-password) and wait until I confirm. Never ask me to paste the token into this chat.
6. My documents (any format) are listed on the next line. Copy them into documents/ in the clone: the resume into documents/cv/, project documents into documents/projects/. Copy, never move, and never edit the originals.
My documents: <PASTE THE PATHS OF YOUR RESUME AND PROJECT DOCUMENTS HERE>
7. Read custom/install/ONBOARDING.md in the clone and follow it: extract my documents, ask me the questionnaire once, show me every file you will write, and write nothing until I say an explicit yes. Then verify with the doctor and offer the daily job and the Control Center.
```

Claude shows its plan, asks before each change, and stops at the one step it cannot do for you: storing your Claude token in the macOS Keychain (see [First run](#first-run)). Under these flags the installer exits with code 3 and a list of pending actions such as the missing Keychain item. That is expected, not a failure: while the Keychain item is missing it skips the daily job and the Control Center start, and Claude relays each pending action to you. The full procedure it follows is [custom/install/ONBOARDING.md](/custom/install/ONBOARDING.md).

### Option 2: install script

For people who prefer a script. **The script accepts Markdown only**: your resume must be a `.md` (or `.markdown`) file, and project documents too. For PDF, DOCX or any other format, use Option 1, or convert the file to Markdown first.

```bash
git clone --branch fork-install-v2 https://github.com/Divy2000/career-ops.git ~/career-ops
cd ~/Documents/job-search   # the folder that holds resume.md and your project .md files
~/career-ops/custom/install/install.sh --resume resume.md --docs project-a.md project-b.md
```

`--docs` is optional. If you already keep a list of your projects, pass it with `--projects projects.md` (or a `projects.json`, see below). Relative `--resume`, `--docs` and `--projects` paths resolve against the current directory you run the script from. Commands the script prints for you to run later are shell-quoted, so they are safe to paste even when a path contains spaces. Run `install.sh --help` for the full list.

What the script does with your Markdown files:

- Limits: the resume is at most 1 MiB, each project document at most 2 MiB, at most 20 documents. Files must be UTF-8 text. Every file is checked before anything is written; one bad file means nothing is copied (exit 2, with the file and the reason).
- Originals are copied into `documents/cv/` and `documents/projects/` (a name that already exists gets a `-1` suffix; nothing is overwritten).
- `--projects` takes your projects library (`.md`, one `## Title -- link` block per project with `- ` bullets) or a projects JSON (AutoJobApply or JSON Resume). It is validated before anything else changes (exit 2 with the reason), copied into `documents/projects/` (a JSON as its Markdown conversion, since intake reads Markdown, and each entry gets a `Source:` line naming that file), and turned into `article-digest.md` when that file does not exist. An existing `article-digest.md` is never replaced; a pending action prints the command that adds only the new projects.
- `cv.md` is created from your resume when it does not exist. If a different `cv.md` already exists, it is **never replaced** without your confirmation (a diff summary and a y/N prompt) or `--replace-cv`, and a `cv.md.bak-<timestamp>` backup is kept before any replacement.
- Without the Keychain item (see [First run](#first-run)) it still installs, but skips the daily job and the Control Center start and lists them as pending actions.
- After the install it offers to start Claude Code with the onboarding procedure, which turns your documents into `config/profile.yml`, `modes/_profile.md`, `portals.yml` and the rest after showing you every change.

| Flag | Meaning |
|---|---|
| `--resume <file.md>` | Resume in Markdown. Seeds `cv.md` when absent. |
| `--docs <a.md> [b.md ...]` | Project documents in Markdown (values run until the next flag). |
| `--replace-cv` | Allow replacing an existing, different `cv.md` (a backup is written first). |
| `--projects <file>` | Projects library (`.md`) or projects JSON. Validated, copied to `documents/projects/`, creates `article-digest.md` when absent (never replaces it). |
| `--onboard interactive\|headless\|none` | After install: start Claude Code with the onboarding prompt (default when a terminal and `claude` are present), draft the files headlessly from the Keychain token (drafts only, never live files), or only print the command. |
| `--yes` | Do not ask for confirmation; take the default answer. |
| `--non-interactive` | Never prompt or read the terminal; unfinished steps become pending actions. |
| `--dir <path>` | Checkout location (default: the checkout the script is in, otherwise `~/career-ops`; an existing checkout is reused). |
| `--data-root <path>` | Keep your personal files outside the checkout. Writes a git-ignored `.career-ops-data` marker. |
| `--ref <tag>` | Check out this tag or branch of the fork. |
| `--no-launchd` | Do not install the 8am daily job. |
| `--with-upstream-sync` | Also install the weekly upstream-merge job. Maintainer only; see [Safety model](#safety-model). |
| `--no-start` | Do not start the Control Center at the end. |
| `--no-h1b-index` | Skip the optional ~8 MiB DOL H-1B index download. |
| `--install-missing` | Offer to `brew install` missing prerequisites (asks y/N each time, never with `--yes`). |
| `--core-only` | Skip the macOS-only parts (Keychain, launchd, Control Center); for Linux. |
| `--dry-run` | Validate inputs and print the plan; change nothing. |
| `--help` | Print the flags. |

Exit codes: `0` done, `1` failure, `2` usage or input error, `3` done with actions you still have to do (for example the Keychain step). Pending actions are printed before the Control Center starts; the script then replaces itself with the Control Center, so exit 3 only shows up when it does not start (for example with `--no-start`, or while the Keychain item is missing).

**One-liner (least safe).** Prefer `git clone`, shown first: it is the route where you read the script before it runs. If you still want a single command, download the pinned bootstrap, read it, then run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/Divy2000/career-ops/fork-install-v2/custom/install/bootstrap.sh
less bootstrap.sh
bash bootstrap.sh --resume resume.md
```

`bootstrap.sh` runs nothing if the download is cut off: its whole body is one function that is called on the last line, so a truncated file defines nothing and executes nothing. The real safeguards are reading the script before you run it and the pinned tag (`fork-install-v2`, not a moving branch). Piping it straight into a shell skips reading it: `curl -fsSL https://raw.githubusercontent.com/Divy2000/career-ops/fork-install-v2/custom/install/bootstrap.sh | bash -s -- --resume resume.md`.

## What you get

Everything upstream career-ops does (see the [upstream README](/README.md)), plus these additions. All fork code lives under [custom/](/custom/README.md).

**Immigration intelligence**

- **Policy watch.** Every day it reads the Federal Register and USCIS feeds, runs a headless Claude news pass, and writes a digest (`data/immigration/policy-digest.md`), `policy-changes.tsv` (government changes) and `company-alerts.tsv` (employers pausing, stopping, resuming, expanding or restricting sponsorship).
- **Per-company sponsorship check.** Before an evaluation or an application draft, the house rule looks up the employer in DOL filing history (LCA and PERM data via the bundled `h1b-sponsor` plugin) and in recent news, and saves the result under `data/immigration/companies/`. The saved check is refetched after any new policy change, daily for 15 days after a change is announced, and otherwise when it is 7 days old. A DOL tier alone is never treated as proof that a company sponsors today; a pause, stop or restriction is a hard blocker that asks you first.
- **Sponsorship lookup.** The Control Center looks up any company and shows the DOL entity, tier, totals and staffing-shop flag.

**Targeting and ranking**

- **US-only, CS and data roles.** Onboarding writes your title keywords and (if you confirm) a US location filter into `portals.yml`, so scans only return roles you can take.
- **Backend and AI priority (hardcoded).** The daily ordering of new postings puts titles matching backend, Python, Django, API, AI, ML, LLM or agentic first. The pattern is hardcoded as `PRIORITY_TITLE` in `custom/pipeline/lib.mjs` and is not configurable yet; edit it if your targets differ.
- **Shortlist.** `data/shortlist.md` combines the relevance rank (0 to 5) with a DOL tier adjustment: strong +0.5, moderate +0.2, unknown -0.3, weak -1.0, none or staffing shop -1.5. Companies with a paused, stopped or restricted alert are listed separately and never shortlisted.
- **Blocklist (opt-in).** `data/blacklist.md` is a do-not-apply list the scanner honors. It is never created or filled automatically: onboarding suggests an entry (for example your current employer) and writes it only after an explicit yes.

**CV and projects**

- **Projects library.** `article-digest.md` lists every project with copy-paste bullets; `cv.md` keeps only your default 2 or 3. For each job, `custom/projects/rank.mjs` ranks the library against the job description (no tokens spent) and the tailored CV picks 2 to 4 from it. Onboarding builds the library from your documents; the Control Center edits it under Profile & CV > Projects.
- **Papers under Recent Achievements.** Research papers and publications go in `cv.md` under `## Recent Achievements`, never under Projects; the CV build refuses a paper listed as a project, a project from nowhere, and a link its source does not give.
- **One-page fit.** The fork CV template tightens its spacing step by step until the PDF fits your page budget, and every upstream check (fact gate, section order, ATS normalization) still runs.

**Automation**

- **Daily job, 8am (launchd).** Policy watch, portal scan, prioritize, rank the top 100 postings, build the shortlist. Log: `data/immigration/logs/<date>.log`. A failing step is logged and the rest still run.
- **Weekly upstream sync (maintainer only).** Merges upstream into the fork on a branch, lets headless Claude resolve conflicts, verifies tests and opens a pull request. It is off for everyone else by default.

**Control Center (local web app, macOS)**

Pages: Today, Pipeline, Tracker, Apply, Follow-ups, Interviews, Discover, Sponsorship (digest, policy changes, alerts, company checks, Lookup), Insights, Sessions, Runs & Schedule, Profile & CV, Settings, Dev Chat and Tutorials (narrated video tutorials and a documentation-style guide). The theme is light, dark or auto. Details: [custom/control-center/README.md](/custom/control-center/README.md).

## Safety model

- **It never submits an application and never sends mail or messages.** Drafts and form fills stop before Submit; you press it.
- **It never adds a company to your blocklist on its own.** Only you do, through an explicit confirmation.
- **Localhost only.** The Control Center listens on `127.0.0.1` and requires a one-time token from the URL it prints at each start.
- **Your Claude token lives in the macOS Keychain** (item `career-ops-claude-token`), never in a file in the repo, and is passed only to the child process that needs it.
- **Your personal files are git-ignored**: CV, profile, portals, tracker, reports, documents, immigration data. This public fork must never hold anyone's personal data, and the installer and onboarding write personal data only to ignored paths.
- **Documents you provide are evidence, never instructions.** Text inside a resume or web page cannot make Claude run a command or change a file.
- **Nothing is written without your yes.** Onboarding shows every new file in full and every change as a diff first.
- **The daily job spends your Claude subscription usage** (a headless policy pass and the ranking of up to 100 postings per day). Turn it off with `--no-launchd` or in Runs & Schedule.
- **The weekly upstream sync is for the fork maintainer.** It commits to and merges pull requests on the fork, so the installer leaves it off unless you pass `--with-upstream-sync`.

## Requirements

- macOS (the Control Center and daily job use Keychain, `lockf` and launchd). On Linux, use `--core-only`.
- git, Node.js 22.6 or newer, npm.
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) and a Claude subscription.
- Optional: `gh` (GitHub CLI), `poppler` (`pdftotext`, better PDF reading), Go (only for the upstream terminal dashboard).

## First run

After either option:

1. **Store your Claude token in the Keychain.** In your own terminal (not through Claude), run `claude setup-token`, copy the token it prints, then run `security add-generic-password -U -a "$USER" -s career-ops-claude-token -w` and paste the token at the hidden prompt (macOS asks twice). Clear your terminal scrollback afterwards. The installer does this for you when run from a terminal; Option 1 leaves it to you because Claude cannot take hidden input.
2. **Check the setup:** `cd ~/career-ops && node doctor.mjs`. It reports missing or still-template personal files.
3. **Start the Control Center:** `custom/control-center/bin/cc`. It prints and opens a one-time `http://127.0.0.1:4317/auth?t=...` URL.
4. **Run the daily job once by hand** to see real output: `custom/immigration/run-daily.sh`. Then open Today.
5. Paste a job URL into Claude Code (`claude` inside `~/career-ops`) to evaluate it, or use Evaluate in the Control Center.

If the checkout is under `~/Desktop` or `~/Documents`, give `/bin/bash` Full Disk Access (System Settings > Privacy & Security) so launchd can read it.

## Daily use

- At 8am the daily job refreshes the policy digest, scans your portals and rebuilds `data/shortlist.md`.
- Open the **Control Center** and start on **Today**: the shortlist top rows with sponsor tiers, anything excluded by an alert, the day's policy bullets, follow-ups due.
- Or run `claude` inside `~/career-ops` and say `today`: it checks the day's log, shows the policy bullets and the shortlist, and asks which roles to evaluate.
- Logs: `data/immigration/logs/<date>.log`. Look for lines that start with `!!!`.

## Updating

```bash
cd ~/career-ops
git switch main && git pull --ff-only
custom/install/install.sh --non-interactive --no-start --no-launchd --no-h1b-index   # refreshes dependencies and checks; existing files are never overwritten
```

The extra flags keep an update from touching choices you made: without them the installer would reinstall the daily launchd job and download the H-1B index again. To (re)enable them deliberately: `custom/launchd/install.sh --jobs daily` installs the 8am job, and `node plugins.mjs enable h1b-sponsor --confirm` followed by `node plugins/h1b-sponsor/install-h1b-index.mjs` enables the sponsor plugin and downloads the index.

Do **not** run `node update-system.mjs apply` in this fork: it can overwrite fork files. Do not use `npx @santifer/career-ops init` either, because that installs upstream, not this fork. The maintainer's weekly sync pull request is the update path for upstream changes.

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.career-ops.immigration-watch"
launchctl bootout "gui/$(id -u)/com.career-ops.upstream-sync"    # only if you enabled it
rm -f ~/Library/LaunchAgents/com.career-ops.immigration-watch.plist ~/Library/LaunchAgents/com.career-ops.upstream-sync.plist
security delete-generic-password -s career-ops-claude-token
rm -rf ~/Library/Application\ Support/career-ops-control-center
```

**Back up your personal files before deleting the checkout**: `cv.md`, `config/profile.yml`, `portals.yml`, `modes/_*.md`, `article-digest.md`, `documents/`, `data/`, `reports/`, `output/` (or the whole `--data-root` folder if you used one). Then remove `~/career-ops`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| The daily job does not run, or launchd cannot read the checkout | The checkout is under `~/Desktop` or `~/Documents`. Give `/bin/bash` Full Disk Access, or move the checkout. |
| The log says the Keychain item `career-ops-claude-token` is not found | Do the Keychain step in [First run](#first-run). The installer lists it as a pending action until it exists. |
| Control Center says the port is in use | Start it on another port: `CC_PORT=4318 custom/control-center/bin/cc`. |
| Warning that `ANTHROPIC_API_KEY` is set | Harmless: sessions and the daily job force it empty so your subscription is used. Unset it in your shell profile to silence the warning. |
| Control Center cannot find `claude`, or you have several | Point it at the one you want: `CC_CLAUDE_BIN=/path/to/claude custom/control-center/bin/cc`. |
| After a Claude Code update, AI sessions fail with "Claude Code X is not approved" and the top bar shows "Setup needs attention" | The Control Center still starts and everything but AI sessions works. Sessions run only on a Claude Code version whose read confinement was tested (2.1.289 today). Either go back to it with `claude install 2.1.289`, or test and approve the new one with `npm --prefix custom/control-center run probe:reads -- --record` (about 20 small real Claude calls on your token, roughly $1-2). |
| Chromium or PDF generation fails | Run `node doctor.mjs`; reinstall the browser with `npx playwright install chromium`. |
| Sponsorship lookup says there is no H-1B index | `node plugins.mjs enable h1b-sponsor --confirm`, then `node plugins/h1b-sponsor/install-h1b-index.mjs` (about 8 MiB). |
| Every start prints a new token URL | Expected: the token is one-time. Open the URL the latest start printed. |
| Installer exit code 3 | Not an error: it lists the actions you still have to do (it is printed before the Control Center starts, and exit 3 only shows when it does not start). |

## Links

- [Fork additions: custom/README.md](/custom/README.md)
- [Control Center guide](/custom/control-center/README.md)
- [Onboarding procedure used by Option 1](/custom/install/ONBOARDING.md)
- [Upstream career-ops README](/README.md)
- [Data contract: what is yours and what is system](/DATA_CONTRACT.md)
- [Agent instructions](/AGENTS.md)
- [Legal disclaimer](/LEGAL_DISCLAIMER.md)

## Credits, license and trademark

career-ops was created by santifer and the [career-ops-hq](https://github.com/career-ops-hq/career-ops) community; nearly everything here is their work. This fork adds the code under `custom/` and this page.

The code is released under the MIT license ([LICENSE](/LICENSE)), the same as upstream.

This is an **unofficial fork**: it is not affiliated with, not endorsed by and not sponsored by the career-ops project or its maintainers, and nothing here is an official release. The name "career-ops" is a trademark of its owner; it is used here only to describe origin and lineage ("a fork of career-ops"), as the [trademark policy](/TRADEMARK.md) allows. The fork is named for what it adds, not as a product of the original project. Read [MANIFESTO.md](/MANIFESTO.md) for the principles the project practices.
