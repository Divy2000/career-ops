# career-ops Control Center

A local, dark-mode web app that sits next to the career-ops checkout and lets you see and drive every capability (web alpha, TUI, modes, scripts, the fork's add-ons, settings, schedule and AI sessions) from the browser. It lives entirely under `custom/control-center/` so the weekly upstream merge never conflicts with it.

## 1. What it is, and the safety guarantees

- **Localhost only.** The supervisor listens on `127.0.0.1` (default port 4317). Every request must carry a `Host` of `127.0.0.1:PORT` or `localhost:PORT`; anything else gets 403 (DNS-rebinding defense).
- **One-time token.** Each start prints `http://127.0.0.1:4317/auth?t=...` and opens it. Redeeming the token sets an HttpOnly, SameSite=Strict cookie; every `/api/*` and SSE route requires it. Mutating requests also need a same-origin `Origin` header and `X-CC: 1`.
- **Never submits.** The Apply page drafts answers and (once Playwright MCP is probed) fills forms, but you press Submit. AI sessions never send mail or messages.
- **Blacklist rule.** `data/blacklist.md` is written only from the Settings > Blacklist editor after an explicit confirm dialog; the request must carry `{confirm:true}` and `X-CC-Explicit: blacklist` or the server answers 403. Every AI session is denied that file by the guard hook.
- **Data never committed.** CV, profile, portals, tracker, reports, immigration files and app state stay in the data root (`CAREER_OPS_ROOT`). Test fixtures are synthetic.
- **No shell.** Every child process is `spawn(cmd, args[], { shell: false })` from a static action registry; the client never sends a command string.
- Responses carry `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`; untrusted markdown (reports, digests, plugin docs) is rendered through rehype-sanitize.

## 2. Install and launch

```bash
# from the career-ops root, first run only
npm --prefix custom/control-center ci

# start (opens the browser on the token URL)
npm --prefix custom/control-center start
# or
custom/control-center/bin/cc
```

Preflight fails with an actionable message when Node is below 22.6, the `claude` binary is missing, or the Keychain item `career-ops-claude-token` is absent (it prints the `claude setup-token` / `security add-generic-password` steps from `custom/immigration/run-daily.sh`). It warns when `ANTHROPIC_API_KEY` is set, because sessions force it empty.

Environment: `CC_PORT` (default 4317), `CC_DATA_ROOT` (defaults to the career-ops data root from `path-resolver.mjs`), `CC_GUARD_DIR` (session policies, hook settings and Dev Chat revert bookkeeping; default `~/Library/Application Support/career-ops-control-center`, and the supervisor refuses to start when it is inside the code or data root), `CC_CLAUDE_BIN`, `CC_NO_OPEN=1`, `CC_LAUNCH_AGENTS_DIR` (default `~/Library/LaunchAgents`), `CC_CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`, read-only usage meter).

## 3. Pages tour

Sidebar groups: Work (Today, Pipeline, Tracker, Apply, Follow-ups, Interviews), Intel (Discover, Sponsorship, Insights), System (Sessions, Runs & Schedule, Profile & CV, Settings, Dev Chat, Tutorials). The top bar has the command palette (Cmd+K), the daily-job chip, the Activity chip, the setup-health chip and the Ask drawer (Cmd+J). The sidebar footer shows the 5h/7d token meter.

- **Today**: shortlist top 15 with sponsor tiers, excluded-by-alert list, daily job result from the latest log, digest staleness, policy bullets, follow-ups due, decisions, fresh matches, quick evaluate (and the CV import hero when `cv.md` is missing).
- **Pipeline**: inbox with facets, skip/undo, add URLs, Evaluate visible (fan-out), Process inbox; shortlist with the excluded list; batch runner.
- **Tracker**: status tabs, Top 4+, search across company, role and notes, sorting on every column, grouped or flat view, column picker, keyboard navigation (`?` lists the keys), side preview, status control with discard reasons and the hired flow, multi-select with **Compare selected (ofertas)**, "Ask about tracker".
- **Application**: verdict callout, report sections, documents (PDFs, HTML twins, re-render), sponsorship panel, outreach, interview, offer and outcome modes, timeline, sessions, delete with dry-run preview.
- **Apply**: drafts answers from the `apply` mode as an editable form; "Fill real form" stays disabled until Playwright MCP is probed.
- **Follow-ups**: Cadence (log, pin, history, AI drafts), Replies (paste a reply, reply-watch digest, invite match, reply-watch session), Contacts (`data/contacts.tsv`, vCard export, LinkedIn join lookup).
- **Interviews**: active interviews, story bank with provenance counts, prep documents, weekly digest, process quality, rejection latency with explicit "Add to blacklist" buttons (they only open the Blacklist editor prefilled).
- **Discover**: network scan, portal scan, AI search, fresh matches, funded companies, reposts.
- **Sponsorship**: digest, policy changes, official feed, company alerts, company checks, H-1B lookup, tier cache, AI policy pass. The Lookup tab (`/sponsorship?tab=lookup&q=...`) runs `plugins/h1b-sponsor/check.mjs` (argv only, no shell; name validated: non-empty, at most 200 characters, no control characters, no leading dash) and shows the resolved DOL name, tier, totals, staffing-shop flag and index build, plus the `freshness.mjs` decision, the saved `data/immigration/companies/<slug>.md` and matching `company-alerts.tsv` rows. "Search names" lists DOL entities (brand versus legal names), each linking to an exact lookup. "Run sponsorship check" starts the `sponsorship-check` session. With no local index it prints the install command (`node plugins/h1b-sponsor/install-h1b-index.mjs`) as text and never runs it.
- **Insights**: Overview, Progress and Breakdown computed server-side; Funnel velocity, Patterns, Salary, Skills and Reposts & legitimacy run the core scripts (JSON, cached by input mtimes, with a run timestamp and Recompute); AI analyses launch patterns, calibrate, upskill and titles.
- **Sessions**: list, transcript, reply, fork, cancel, delete (dialog confirm); New session with any mode.
- **Runs & Schedule**: every run with its live log, cancel; both launchd jobs (daily `com.career-ops.immigration-watch`, weekly `com.career-ops.upstream-sync`) with loaded state, next fire, last exit, time editing, enable/disable and Run now; a log browser over `data/immigration/logs` and `data/upstream-sync`.
- **Profile & CV**: editors for the user markdown files, CV import, AI flows and exports.
- **Settings**: Portals (structured editor for every top-level key, raw YAML, health), Profile (form for every `profile.example.yml` section, follow-up cadence form, raw YAML), House rules, Blacklist, Plugins, AI engine (status, concurrency, model default, usage budgets, usage meter), Health, Updates (read-only, link to the sync PR), App (logos opt-in, run retention).
- **Dev Chat**: scoped edits with per-turn diffs and reverts.
- **Tutorials** (`/tutorials`): plays the narrated tutorials in `data/control-center/tutorials/` (see section 11).

Structured editors send `{ops}` (set, delete, insert) that the server applies with the `yaml` Document API, so comments, key order and unknown keys survive. Saves are ETag-gated: a 409 keeps your pending edits on top of the current file so "save again" is the merge. Portals go through `validate-portals.mjs`, the profile through `validate-profile.mjs`; a failing validator returns 422 and nothing is written.

## 4. AI sessions and permissions

Sessions run `claude -p` headless with `--permission-mode dontAsk`, path-scoped `Edit(...)` rules (which also cover Write and MultiEdit), a `--settings` PreToolUse/PostToolUse guard hook and `--strict-mcp-config`. Policy classes live in `server/claude/modes.ts`; the mode list is derived from `modes/**/*.md` by `scripts/derive-mode-policies.ts` and frozen in `modes.generated.json`. A test fails when the modes tree drifts.

| Policy class | Writes allowed | Examples |
|---|---|---|
| read-only | none | advisor (Ask drawer), tracker, discover AI search, cv-ingest |
| evaluate | `reports/`, tracker via core CLIs | oferta, auto-pipeline, ofertas, pipeline, batch |
| documents | `output/`, `jds/` | pdf, text, latex, cover |
| outreach and interview | `interview-prep/`, follow-up drafts | followup, interview-prep, interview/plan, interview/practice |
| profile | user markdown files | interview (onboarding), master-profile, add, expand, intake |
| immigration | `data/immigration/**` | immigration-policy, sponsorship-check |
| devchat | user layer and `custom/**` (see section 5 for what stays protected) | Dev Chat |

Every class is denied `data/blacklist.md`, direct edits to `data/applications.md`, the app's own state under `data/control-center/`, git, network tools and shell operators in Bash. The guard accepts one command per Bash call and refuses line breaks, control characters, operators, expansions (`$`, backticks, `~`, zsh `=cmd`), globs and escapes anywhere in it, even inside quotes. Each allowed command then has an exact argument grammar: the npm scripts take no arguments, `npx vitest run` only test-name filters or files under `tests/`, git only read-only `status`/`diff`/`log` flags (never `--output`, `-o` or `--no-index`) and in-repo paths, and core scripts only path arguments inside the roots that are not protected, with every dash token a plain flag name (a script with a lax parser would read `-x/../cv.md` as a path). Scripts that write to a path their caller names (`generate-pdf.mjs`, `build-cv-latex.mjs`, `generate-cover-letter.mjs --out` and similar) are modelled on their own parsers: only their known switches and value flags are accepted, each positional and flag value has a role (input inside the roots, output inside the write scope), and `generate-pdf.mjs --batch` is refused. Each turn's policy is written outside both roots (`CC_GUARD_DIR`) and the hook verifies its sha256 (passed in the session env) on every call, so a changed policy refuses every tool call. The hook command is shell-quoted and ends in `|| exit 2`, so a hook that cannot start blocks instead of failing open. `server/claude/manager.ts` runs each turn through the detached runner (Claude slot cap from Settings > AI engine, default 2), reads the OAuth token from the Keychain at spawn (never written to disk; the wrapper redacts it from stored logs), normalizes stream-json into `events.ndjson` and applies the honesty gate. The model default from app settings is used when a session does not pick one.

## 5. Dev Chat scope, diffs and recovery

Dev Chat (`/dev`) edits the user layer and `custom/**`. It is denied `data/control-center/**` (session and app state), `custom/control-center/server/claude/**` (the guard and the policy code), `supervisor/**`, `package.json`, `package-lock.json`, the vite, vitest, playwright, eslint and tsconfig configs, `tests/**`, `scripts/**`, every `node_modules`, `applications.md`, and the blacklist unless the checkbox is ticked for that turn (the unlock is honored only for Dev Chat and only when that request carries `X-CC-Explicit: blacklist`, which the checkbox sends; every other session class is refused). It is also denied what runs outside any session guard: `custom/immigration/run-daily.sh` and `daily-prompt.md` (launchd's daily job, which calls `claude -p` with your token), `custom/upstream-sync/**` (the weekly job), `custom/launchd/**`, and the test suites under `custom/immigration` and `custom/pipeline`; it cannot run `node --test` there either.

**Dev Chat is a trusted code-editing agent, not a sandboxed one.** Its guard prevents accidents (a wrong path, a stray write to the tracker or the blacklist, a command outside its allowlist); it does not contain a hostile session. Dev Chat may edit `server/**`, `web/**`, `shared/**` and `custom/immigration/**`, and the commands it may run (`npm run test|build|lint|typecheck`, `npx vitest run`) load and execute that code with your user's full permissions, as does the blue/green restart after a server edit. The modules the daily job runs (`custom/immigration/watch.mjs` and `lib.mjs`, `custom/pipeline/prioritize.mjs`, `shortlist.mjs` and `lib.mjs`) and `custom/immigration/freshness.mjs` (run by evaluation sessions) also stay editable, so a Dev Chat change there runs on the next daily job or evaluation. Every session sets Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so its Bash commands and hooks run without `CLAUDE_CODE_OAUTH_TOKEN` (the switch was confirmed present in the pinned CLI 2.1.288 by inspecting the binary, not by a live call; `npm run probe:claude` is the place to confirm it). Review its diffs before you keep them, and only give it prompts and pages you trust. The Changes panel shows per-turn unified diffs with Revert file / Revert turn (dialog confirm). Server edits trigger a blue/green restart; a failed restart keeps the old server and shows a banner. The new server serves requests at once but takes over tracking runs and sessions only after the old one has stopped its trackers and exited; each turn's transcript position is saved as it goes, so the new server continues the transcript without replaying it, and a turn's cost and report number are settled exactly once. `/__recovery` (served by the supervisor, token or cookie gated) offers the same reverts even when the server child is broken; its POSTs need the app origin and `X-CC: 1` like the API (the page sends them from a CSP-hashed inline script).

A revert only writes files that resolve inside the code or data root and that the turn's own policy allowed, never while the session is running, and never over bytes that changed after the turn: the guard hook records each changed file's sha256 right after the turn writes it (so finalizing late, after a restart, never adopts a later edit), and a file that differs now (a later turn or your own edit) is refused with 409 and named in the message. A turn revert is all or nothing. A file already back at its pre-turn bytes counts as `unchanged`.

## 6. Daily job and schedule

The launchd jobs `com.career-ops.immigration-watch` (daily, `custom/immigration/run-daily.sh`) and `com.career-ops.upstream-sync` (weekly, `custom/upstream-sync/sync.sh`) are read with `plutil -convert json` and `launchctl print`, and written by rendering the plist, `plutil -lint`, then `launchctl enable`, `bootout` and `bootstrap` to enable, or `launchctl disable` and `bootout` to disable. `disable` is persistent, so a disabled job stays off after a logout or reboot although its plist stays in `~/Library/LaunchAgents`; the card shows "disabled at login" from `launchctl print-disabled`. `ProgramArguments` always points at the fork script, and launchd's own stdout and stderr go to `launchd.out.log` and `launchd.err.log` in the job's log directory under the data root (created on save), where the log browser reads. Each plist also sets `CAREER_OPS_ROOT` to the data root, so both scripts resolve the same data root the app shows through `path-resolver.mjs`: `run-daily.sh` for its data and logs, and `custom/upstream-sync/sync.sh` for its dated logs in `data/upstream-sync`. `sync.sh` exits with an error when it cannot resolve the data root rather than writing elsewhere. The app reads the dated logs (`---` step, `!!!` failure and `===` start/done markers) and shows a banner while `run-daily.sh` is running. Tests and the e2e server use an in-memory fake (`CC_FAKE_LAUNCHD=1`, honored only under `NODE_ENV=test`), so no test touches the real launchd. The "daily job is running" probe (`pgrep -f custom/immigration/run-daily.sh`) is faked the same way: `CC_FAKE_DAILY=idle` or `running` (honored only under `NODE_ENV=test`, set to `idle` by the e2e config) answers it without looking at host processes.

## 7. Migration from `local/`

Already applied on the fork: `local/immigration` and `local/pipeline` moved to `custom/immigration` and `custom/pipeline`, the launchd job points at `custom/immigration/run-daily.sh`, and `custom/launchd/install.sh` (re)installs both jobs. The live cutover of launchd and `modes/_custom.md` on a machine still on `local/` is a user-run step after merge.

## 8. Development

Fixture files under `tests/fixtures/root/` share names with career-ops user-layer files (`cv.md`, `portals.yml`, `data/applications.md`), which the upstream root `.gitignore` ignores. They are tracked, so edits show up normally, but a NEW fixture file with such a name must be added with `git add -f`; the same goes for `tests/fixtures/media/*.mp4` (the root `.gitignore` ignores `*.mp4`). Do not edit the root `.gitignore`: it is an upstream file.

```bash
npm --prefix custom/control-center run typecheck
npm --prefix custom/control-center run lint        # eslint plus the no-em-dash check
npm --prefix custom/control-center test            # vitest: unit, API (fastify.inject) and web (jsdom)
npm --prefix custom/control-center run test:e2e    # Playwright against npm start with a tmp fixture root
npm --prefix custom/control-center run derive:modes
npm --prefix custom/control-center run probe:claude   # two real haiku calls; records CLI semantics
```

- The Tutorials e2e tests write their tutorial folders at setup (`tests/e2e/roots.ts`): the 2 second clip and the poster come from `ffmpeg` when it is installed, otherwise from the committed copies in `tests/fixtures/media/` (16 KB and 8 KB, same content). `CC_H1B_CHECK_SCRIPT` (honored only under `NODE_ENV=test`) points the Sponsorship lookup at `tests/fakes/h1b-check.mjs` instead of the real DOL index. `CC_E2E_PORT_BASE` (default 4399) moves the three e2e servers (base, base-1, base-2) when something else already listens on those ports.
- `tests/fixtures/root/` is a synthetic career-ops data root (no real names or companies). Every test copies it to a temp dir; nothing touches the real data root, `~/Library/LaunchAgents` or `~/.claude/projects`.
- `tests/fakes/claude.mjs` replays stream-json scenario files, honors `--session-id` / `--resume`, performs scripted writes and Bash steps and runs the real guard hook from `--settings`. Scenarios live in `tests/fixtures/scenarios/<mode>.json`.
- `tests/unit/inventory.test.ts` is the table-driven inventory: every capability id from spec section 1 names its API route, action, mode, component or e2e step, and the test proves it exists and is exercised.
- `tests/unit/no-native-dialogs.test.ts` fails if `window.confirm`, `alert` or `prompt` appears under `web/`; confirms use the Radix dialog, feedback uses sonner toasts.
- `server/core/contract.json` records the core CLI flags, pure exports and the Claude CLI probe results; `tests/unit/contract.test.ts` re-verifies them against the installed checkout and CLI on every run.

## 9. How the upstream weekly merge is protected

Only `server/core/adapter.ts` knows core script names and export names, and it is driven by `contract.json`. When upstream renames a flag or an export, the contract test fails loudly and the adapter is the one place to update. Everything under `custom/control-center` is self-contained; `config/local-paths.txt` lists `custom/` so upstream tooling leaves it alone.

Note: `custom/` is public. `custom/immigration/daily-prompt.md` describes the user's visa situation in general terms by the user's own choice.

## 10. Troubleshooting

- "Port 4317 is already in use": stop the other process or set `CC_PORT`.
- Locked page in the browser: open the `/auth?t=` link printed by `npm start` (the token changes on every start).
- `dist/index.html missing`: run `npm --prefix custom/control-center run build` before `start:built`.
- "launchctl bootstrap failed": the plist is written and linted first; check that `/bin/bash` has Full Disk Access when the checkout lives under `~/Desktop` or `~/Documents`.
- A structured save returns 409: the file changed on disk (another editor, Dev Chat or the daily job). Your pending edits stay in the form on top of the current version; review and save again, or discard.
- The usage meter says "No Claude Code logs": set `CC_CLAUDE_PROJECTS_DIR` if your Claude Code config lives elsewhere.

## 11. Tutorials

Tutorials are user data: each is a folder `data/control-center/tutorials/<id>/` in the data root (gitignored, never committed) with a `tutorial.json` that names its files. The folder name must equal `id`.

```json
{
  "id": "control-center-tour",
  "title": "career-ops Control Center tour",
  "description": "A narrated walk through every page.",
  "video": "tour.mp4",
  "subtitles": "tour.vtt",
  "poster": "poster.jpg",
  "transcript": "script.md",
  "guide": "guide.json",
  "chapters": [{ "title": "Intro", "start": 0 }, { "title": "Launching", "start": 130.2 }]
}
```

`video` is required (.mp4); `subtitles` is `.vtt` (served as-is) or `.srt` (converted to WebVTT on the fly for the `<track>`), `poster` is `.jpg`, `.jpeg` or `.png` (the video poster and the list thumbnail), `transcript` is `.md`, and `chapters` are `{ title, start }` with `start` in seconds. Every file is a plain name inside the folder. `GET /api/tutorials` validates each manifest with zod and lists the valid ones; an invalid folder is skipped with a visible warning on the page (bad JSON, missing video, path in a file name, id different from the folder). A missing optional file is dropped with a warning on that tutorial.

`guide` (optional, `.json`) adds a **Quick guide** tab next to **Video** for fast review of every feature. `guide.json`:

```json
{
  "sections": [
    {
      "id": "today",
      "title": "Today",
      "summary": "One or two sentences.",
      "route": "/today",
      "gif": "today.gif",
      "poster": "today.jpg",
      "steps": ["Open Today.", "Pick a row."],
      "tips": ["Optional hints."],
      "chapter": 2
    }
  ]
}
```

`sections` has 1 to 60 entries. Per section: `id` (unique, 1 to 64 letters, digits, `-` or `_`), `title` (up to 120 characters), `summary` (up to 600), `gif` (plain file name ending `.gif` or `.webp`), `steps` (1 to 12 strings, up to 500 characters each) are required; `route` (an app path such as `/tracker?status=Applied`: one leading `/`, no scheme, `//`, backslash, spaces or `..`), `poster` (`.jpg`, `.jpeg` or `.png`), `tips` (up to 6 strings) and `chapter` (0-based index into the tutorial's chapters, which must exist) are optional. The guide is all or nothing: if `guide.json` is missing, too large (over 1 MB), not valid JSON, fails validation or names a file that is missing or outside the folder, the tutorial still lists, the Quick guide tab is hidden and a warning naming the problem shows on the tutorial. `GET /api/tutorials` returns the parsed guide as `guide` (`null` when absent or invalid) with `gif` and `poster` as media urls.

In the Quick guide (`/tutorials?t=<id>&view=guide&section=<section id>`, so every state is a shareable link and back and forward work): a section list with a search box (title, summary, steps), the animation (click to pause on the poster, or on the current frame when there is no poster; with reduced motion it starts paused behind a play button), numbered steps, tips, **Open this page** (goes to `route` inside the app), **Watch this part** (switches to Video at the start of `chapter`), **Mark reviewed** with an "N of M reviewed" bar and Reset (kept in this browser's localStorage; the guide works when storage is blocked), and Previous and Next. `j` and `k` or Up and Down move between sections (not while typing in a field). On a phone the list becomes a select above the content.

`GET /api/tutorials/:id/media/:file` streams one file with HTTP Range support (206, `Accept-Ranges`, `Content-Range`, 416 for an unsatisfiable range) and the same session cookie as every other route. Only `.mp4`, `.vtt`, `.srt`, `.md`, `.jpg`, `.jpeg`, `.png`, `.gif` and `.webp` are served, `file` must be a plain name, and the real path (after symlinks) must stay inside that tutorial's own folder, which in turn must stay inside the tutorials folder, so `..`, absolute paths and symlinks that point out are refused.

Player keys (not while typing in a field): Space or `k` play/pause, `j` back 10 s, `l` forward 10 s, `c` captions, Up and Down previous and next chapter. Clicking a chapter seeks to it; the chapter that is playing is highlighted. The transcript is collapsible and searchable (rendered with the sanitizing markdown renderer, authoring comments hidden). Captions default to on and the choice is remembered in the browser.

To install a recording folder (or any folder that already has a `tutorial.json`):

```bash
node custom/control-center/scripts/install-tutorial.mjs <source-folder> [--data-root <dir>] [--id <id>] [--title <text>] [--description <text>] [--video <file>] [--force] [--dry-run]
```

With no `tutorial.json` in the folder it builds one from `chapters/toc.json` (`[{ number, id, title, start, duration }]`), the single `.mp4` at the root, a `.vtt` (preferred) or `.srt`, an optional `poster.jpg`, `tutorial/script.md` (installed as `script.md`) and an optional `guide/guide.json` with the gifs and posters it names next to it in `guide/` (the manifest then gets `"guide": "guide.json"`). With a `tutorial.json` it validates it and copies it unchanged (so `--id`, `--title`, `--description` and `--video` are refused). A guide is validated like the server does (schema, every named file present, `chapter` within the chapters) before anything is copied, and two different source files that would land on the same name are refused. Only `tutorial.json`, the files it names and, for a guide, the files `guide.json` names are copied, into a staging folder that replaces the destination in one rename; an installed tutorial is replaced only with `--force`, and `--dry-run` writes nothing. The data root defaults to `CC_DATA_ROOT`, then the career-ops data root. Example for the recording folder: `node custom/control-center/scripts/install-tutorial.mjs ~/Desktop/Divy/career-ops-tutorial --id control-center-tour --title "career-ops Control Center tour" --description "A narrated walk through every page."`.

## 12. Known limitations

- The session guard is defense in depth for sessions you start, not a sandbox. Dev Chat in particular edits and reloads this app's code, so it can always run code it writes; the guard stops accidents.
- `generate-latex.mjs`: the guard derives the compile's side files (`<base>.pdf`, aux files, tectonic files) from a fixed list rather than requiring the input's whole folder to be writable. Every scope that ships today allows the whole `output/` folder, so this only matters for a future narrower scope; inputs should end in `.tex`.
- `node build-cv-html.mjs --test` and `node build-cv-latex.mjs --test` are refused inside sessions, because the guard never lets a flag occupy a path slot of a script that reads paths by position. Run those self-tests from a terminal.
- `pipeline/prioritize.mjs` reads `data/scan-history.tsv` under the pipeline lock, but `scan.mjs` writes its history row after releasing it; a prioritize run in that gap can order a just-scanned job slightly lower. Nothing is lost.
- Playwright MCP has not been probed on this machine, so the Apply page drafts answers but does not fill the live form.
