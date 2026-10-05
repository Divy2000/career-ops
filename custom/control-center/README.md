# career-ops Control Center

A local web app (light, dark or auto theme) that sits next to the career-ops checkout and lets you see and drive every capability (web alpha, TUI, modes, scripts, the fork's add-ons, settings, schedule and AI sessions) from the browser. It lives entirely under `custom/control-center/` so the weekly upstream merge never conflicts with it.

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
- **Apply**: drafts answers from the `apply` mode as an editable form; "Fill real form" stays disabled until Playwright MCP is probed. "Zero-token prefill" runs `prepare-application.mjs` with a Greenhouse, Ashby or Lever apply link and a CV PDF from `output/` (the row's tailored CV is preselected, a `*cover*.txt`/`.md` letter is optional) and shows the summary inline; with no tailored CV yet the button stays disabled and "Generate CV PDF" starts the `pdf` session.
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
- **Tutorials** (`/tutorials`): plays the narrated tutorials in `data/control-center/tutorials/`, as one video or in parts with a playlist (see section 11).

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

- The Tutorials e2e tests write their tutorial folders at setup (`tests/e2e/roots.ts`): the 2 second clips (dark and light, `demo-tour.mp4` and `demo-tour-light.mp4`) and the posters come from `ffmpeg` when it is installed, otherwise from the committed copies in `tests/fixtures/media/` (16 KB and 22 KB for the clips, about 7 KB for each poster, same content). A `docs-tour` tutorial with a version 2 guide is written too; its dark and light PNG and GIF pairs are generated in code, so no image binaries are committed. A `parts-tour` tutorial in three parts reuses the 2 second clips for its last two parts; its first part is a 30 second, 1 frame per second pair (`part-30s.mp4` and `part-30s-light.mp4`, 34 KB and 53 KB in `tests/fixtures/media/`, also made by `ffmpeg` when it is installed) so a resume point fits. `CC_H1B_CHECK_SCRIPT` (honored only under `NODE_ENV=test`) points the Sponsorship lookup at `tests/fakes/h1b-check.mjs` instead of the real DOL index. `CC_E2E_PORT_BASE` (default 4399) moves the three e2e servers (base, base-1, base-2) when something else already listens on those ports.
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
  "videoLight": "tour-light.mp4",
  "subtitles": "tour.vtt",
  "poster": "poster.jpg",
  "posterLight": "poster-light.jpg",
  "transcript": "script.md",
  "guide": "guide.json",
  "chapters": [{ "title": "Intro", "start": 0 }, { "title": "Launching", "start": 130.2 }]
}
```

`video` is required (.mp4) unless the tutorial is in parts (below); `subtitles` is `.vtt` (served as-is) or `.srt` (converted to WebVTT on the fly for the `<track>`), `poster` is `.jpg`, `.jpeg` or `.png` (the video poster and the list thumbnail), `transcript` is `.md`, and `chapters` are `{ title, start }` with `start` in seconds. Every file is a plain name inside the folder. `GET /api/tutorials` validates each manifest with zod and lists the valid ones; an invalid folder is skipped with a visible warning on the page (bad JSON, missing video, path in a file name, id different from the folder). A missing optional file is dropped with a warning on that tutorial.

**Light and dark recordings.** `videoLight` (.mp4) is the same recording rendered for the light theme and `posterLight` (`.jpg`, `.jpeg` or `.png`) its poster; both are optional. A `videoLight` that is the same file as `video` (compared without case) is refused, so the tutorial is skipped with that reason. A light file that is missing, or that resolves outside the folder, is dropped with a warning (`light video file "x" not found, so it is ignored`) and the page falls back to the dark one. Subtitles, transcript and chapters are shared by both videos, so the light recording must keep the dark one's timeline (same chapter starts and cue times, same frame alignment); the page does not retime anything. `GET /api/tutorials` lists them on each part as `videoLight` (`{ file, url, bytes }`) and `posterLight` (`{ file, url }`), each `null` when there is none.

**A tutorial in parts.** A long recording can be split into parts, each its own video. A manifest has either `video` (one recording, as above) or `parts`, never both; with `parts`, a top-level `video`, `videoLight`, `subtitles`, `poster`, `posterLight` or `chapters` is refused with "move it into a part":

```json
{
  "id": "control-center-v2",
  "title": "career-ops Control Center tour",
  "description": "A narrated walk through every page.",
  "transcript": "script.md",
  "guide": "guide.json",
  "parts": [
    {
      "id": "start",
      "title": "Start here: safety and launch",
      "short": "Start here",
      "video": "p1-start.mp4",
      "videoLight": "p1-start-light.mp4",
      "subtitles": "p1-start.vtt",
      "poster": "p1-start-poster.jpg",
      "posterLight": "p1-start-poster-light.jpg",
      "duration": 263.2,
      "chapters": [{ "title": "Intro and safety model", "start": 0 }, { "title": "Launching and login token", "start": 148.734 }]
    }
  ]
}
```

Each part is strict (an unknown key is an error): `id` (1 to 64 letters, digits, `-` or `_`, unique), `title` (1 to 120 characters), `short` (optional, 1 to 24 characters and not blank, the playlist label; the title stands in when it is absent), `video` (required), `videoLight`, `subtitles`, `poster` and `posterLight` (optional, the same types as above), `duration` (required, seconds, more than 0) and `chapters` (at least one, each `start` counted from the start of the part and less than `duration`). No file name may appear twice in the manifest, compared without case. The Control Center trusts the declared lengths (it does not read the mp4 headers) and sets no length limit. Chapters keep one numbering across the parts, in part order, so a guide's `chapter` stays a 0-based index into all of them. A missing part video skips the folder with a warning that names the part; a missing optional file of a part is dropped with a warning that names it (`part "intel" light video file "x" not found, so it is ignored`).

`GET /api/tutorials` returns every tutorial as `parts` (a single-video manifest is one part, `main`, named after the tutorial, with `duration` `null`): each `{ id, title, short, duration, video, videoLight, subtitles, poster, posterLight, chapters }` with file urls, plus the tutorial's `transcript` and `chapters`, the chapters of every part in order, each `{ title, start, part }`.

`guide` (optional, `.json`) names a guide. There are two formats, told apart by `version`.

**Version 2: documentation guide** (`"version": 2`). Sections hold subsections, subsections hold blocks, and every image or clip has a dark file and a light file of the same size so the page can follow the theme:

```json
{
  "version": 2,
  "sections": [
    {
      "id": "tracking",
      "title": "Tracking",
      "short": "Track",
      "summary": "Keep the tracker current.",
      "subsections": [
        {
          "id": "change-status",
          "title": "Change a status",
          "short": "Status",
          "summary": "Move an application to its next state.",
          "route": "/tracker",
          "chapter": 1,
          "blocks": [
            { "type": "text", "text": "Pick a row, then choose the new status." },
            { "type": "steps", "items": ["Open Tracker.", "Pick a row."] },
            { "type": "tips", "items": ["Press j and k to move."] },
            { "type": "media", "kind": "image", "file": "tracker.dark.webp", "fileLight": "tracker.light.webp", "alt": "The tracker table.", "caption": "Optional.", "width": 1440, "height": 900 },
            { "type": "media", "kind": "gif", "file": "status.dark.webp", "fileLight": "status.light.webp", "poster": "status.dark.png", "posterLight": "status.light.png", "alt": "A status change.", "width": 960, "height": 540 }
          ]
        }
      ]
    }
  ]
}
```

Every object is strict: an unknown key is an error, not a dropped field. Limits: 1 to 12 sections; 1 to 8 subsections per section and at most 80 in total; 1 to 10 blocks per subsection; ids (section ids unique, subsection ids unique within their section) are 1 to 64 letters, digits, `-` or `_`; titles up to 120 characters; `short` (optional, on sections and subsections) is the 1 to 24 character label the contents panel shows instead of the title, not blank; section `summary` up to 300; subsection `summary` and `text` up to 600; `steps` 1 to 8 items and `tips` 1 to 4 items, up to 300 characters each; `alt` (required) and `caption` (optional) up to 200; `width` and `height` are the files' pixel size, whole numbers from 1 to 4096. `route` (optional) is an app path such as `/tracker?status=Applied` (one leading `/`, no scheme, `//`, backslash, spaces or `..`, also not when percent-encoded) and `chapter` (optional) is a 0-based index into the tutorial's chapters, which must exist. A block is `text`, `steps`, `tips` or `media`. `media` of kind `image` takes `.png`, `.jpg`, `.jpeg` or `.webp` files; kind `gif` (a clip) takes `.gif` or `.webp` (animated WebP is fine) plus a required `poster` and `posterLight` (`.png`, `.jpg` or `.jpeg`) shown until the clip plays. `fileLight` is required (use the same file name only if the image is genuinely theme neutral).

**Version 1: legacy quick guide** (no `version`). Still read, read-only, and adapted by the server into the version 2 view; new guides should use version 2.

```json
{
  "sections": [
    { "id": "today", "title": "Today", "summary": "One or two sentences.", "route": "/today", "gif": "today.gif", "poster": "today.jpg", "steps": ["Open Today.", "Pick a row."], "tips": ["Optional hints."], "chapter": 2 }
  ]
}
```

`sections` has 1 to 60 entries. Per section: `id` (unique), `title` (up to 120 characters), `summary` (up to 600), `gif` (`.gif` or `.webp`), `steps` (1 to 12 strings, up to 500 characters each) are required; `route`, `poster` (`.jpg`, `.jpeg` or `.png`), `tips` (up to 6 strings) and `chapter` are optional.

Both formats are all or nothing: if `guide.json` is missing, too large (over 1 MB, `MAX_GUIDE_BYTES`), not valid JSON, fails validation (a `version` other than 2 included) or names a file that is missing or outside the folder (for version 2 that includes every light file and poster), the tutorial still lists, the guide is hidden and a warning naming the problem shows on the tutorial. `GET /api/tutorials` returns two views of a valid guide:

- `guideDocs` (`null` when absent or invalid): `{ version: 1 | 2, legacy: boolean, sections }`, each section `{ id, title, short, summary, subsections }`, each subsection `{ id, title, short, summary, route, chapter, blocks }` (`short` is the title when the guide gives none, and always for a version 1 guide; `route` and `chapter` are `null` when absent), each block `{ type: 'text', text }`, `{ type: 'steps', items }`, `{ type: 'tips', items }` or `{ type: 'media', kind, alt, caption, width, height, url, urlLight, posterUrl, posterLightUrl }` with media urls (`null` where a file does not exist). A version 1 guide is adapted: each section becomes one section with one subsection (its summary as the first text block, then the clip, steps and tips), `legacy` is `true`, `width` and `height` are `null`, there is no light variant (`urlLight` is `null`, so the dark file shows) and the subsection `summary` is empty.
- `guide` (`null` when absent, invalid, or a version 2 guide): the legacy shape, `{ sections: [{ id, title, summary, route, gif, poster, steps, tips, chapter }] }` with `gif` and `poster` as `{ file, url }`. It exists only for the current Quick guide tab and will go away with it.

In the Quick guide (`/tutorials?t=<id>&view=guide&section=<section id>`, so every state is a shareable link and back and forward work): a section list with a search box (title, summary, steps), the animation (click to pause on the poster, or on the current frame when there is no poster; with reduced motion it starts paused behind a play button), numbered steps, tips, **Open this page** (goes to `route` inside the app), **Watch in video** (switches to Video at the start of `chapter`, in the part that holds it), **Mark reviewed** with an "N of M reviewed" bar and Reset (kept in this browser's localStorage; the guide works when storage is blocked), and Previous and Next. `j` and `k` or Up and Down move between sections (not while typing in a field). On a phone the list becomes a select above the content.

`GET /api/tutorials/:id/media/:file` streams one file with HTTP Range support (206, `Accept-Ranges`, `Content-Range`, 416 for an unsatisfiable range) and the same session cookie as every other route. Only `.mp4`, `.vtt`, `.srt`, `.md`, `.jpg`, `.jpeg`, `.png`, `.gif` and `.webp` are served, `file` must be a plain name, and the real path (after symlinks) must stay inside that tutorial's own folder, which in turn must stay inside the tutorials folder, so `..`, absolute paths and symlinks that point out are refused.

The Quick guide's contents panel shows the short labels on one line (the full title is the tooltip) in a two-level tree: a section with subsections has a chevron, only the section being read is open whenever it changes, and the chevrons open or close any other without navigating. Each subsection row starts with a tick: an empty circle, or a check once it is marked reviewed.

Player keys (not while typing in a field): Space or `k` play/pause, `j` back 10 s, `l` forward 10 s, `c` captions, Up and Down previous and next chapter. Clicking a chapter seeks to it; the chapter that is playing is highlighted. A tutorial in parts opens the part `?part=<id>` names (the first one for an unknown id) and its side panel becomes **Parts**: one link per part with its number (a check once watched), its short label, its length and a progress track, with the chapters of the part that is playing under it; the heading under the video reads "Part N of M". Choosing a part adds a history entry, so Back returns to the one before, and a theme change inside a part keeps its place. When a part ends, **Up next** offers the next one with an 8 second countdown, Play now and Cancel (Escape cancels); it is announced through a polite live region and does not take focus, only the countdown text runs under reduced motion, and a video in native full screen leaves it first. The last part shows no prompt. Progress per part (`{ at, max, done }`) is kept in this browser's localStorage under `cc.tutorials.progress.v1.<id>`: a part counts as watched within 3 s of its end, and an unwatched part resumes where it was left when that is more than 5 s in and more than 10 s before the end. A single-video tutorial keeps its Chapters panel. The transcript is collapsible and searchable (rendered with the sanitizing markdown renderer, authoring comments hidden). Captions default to on and the choice is remembered in the browser.

To install a recording folder (or any folder that already has a `tutorial.json`):

```bash
node custom/control-center/scripts/install-tutorial.mjs <source-folder> [--data-root <dir>] [--id <id>] [--title <text>] [--description <text>] [--video <file>] [--video-light <file>] [--strict-dims] [--force] [--dry-run]
```

With no `tutorial.json` in the folder it builds one from `chapters/toc.json` (`[{ number, id, title, start, duration }]`), the single `.mp4` at the root, a `.vtt` (preferred) or `.srt`, an optional `poster.jpg`, `tutorial/script.md` (installed as `script.md`) and an optional `guide/guide.json` with the media it names next to it in `guide/` (the manifest then gets `"guide": "guide.json"`). A light recording is paired by name: `<name>.mp4` with `<name>-light.mp4` becomes `video` and `videoLight` (the light file is not counted as a second video, an unrelated second `.mp4` is still refused and needs `--video`), and `poster-light.jpg`, `.jpeg` or `.png` becomes `posterLight`. `--video-light <file>` names the light video explicitly (any `.mp4` name in the folder, taking precedence over a paired one). With a `tutorial.json` it validates it and copies it unchanged, including the `videoLight` and `posterLight` files it names, or every part's files for a tutorial in parts (a missing one is named with its part: `part "intel" light video file "x" not found`), so `--id`, `--title`, `--description`, `--video` and `--video-light` are refused. A manifest built from a recording folder is always a single video. A guide is validated like the server does (schema, every named file present, `chapter` within the chapters) before anything is copied, and two different source files that would land on the same name are refused. `--strict-dims` also reads the header of every media file of a version 2 guide (dark, light and posters; PNG, GIF, JPEG, and WebP including lossless, extended and animated, where the canvas size counts; a JPEG is walked segment by segment to its frame header, looking through its first 16 MB) and refuses one whose size is not the `width` x `height` its block declares, or one whose header cannot be read; it also refuses a part whose dark and light posters differ in size, naming both files. A legacy guide declares no sizes, so the flag does nothing for its media. The command prints the number of parts and each part's length. Files are copied with copy-on-write where the filesystem supports it. Only `tutorial.json`, the files it names and, for a guide, the files `guide.json` names are copied, into a staging folder that replaces the destination in one rename; an installed tutorial is replaced only with `--force`, and `--dry-run` writes nothing. The data root defaults to `CC_DATA_ROOT`, then the career-ops data root. Example for the recording folder: `node custom/control-center/scripts/install-tutorial.mjs ~/Desktop/Divy/career-ops-tutorial --id control-center-tour --title "career-ops Control Center tour" --description "A narrated walk through every page."`.

## 12. Known limitations

- The session guard is defense in depth for sessions you start, not a sandbox. Dev Chat in particular edits and reloads this app's code, so it can always run code it writes; the guard stops accidents.
- `generate-latex.mjs`: the guard derives the compile's side files (`<base>.pdf`, aux files, tectonic files) from a fixed list rather than requiring the input's whole folder to be writable. Every scope that ships today allows the whole `output/` folder, so this only matters for a future narrower scope; inputs should end in `.tex`.
- `node build-cv-html.mjs --test` and `node build-cv-latex.mjs --test` are refused inside sessions, because the guard never lets a flag occupy a path slot of a script that reads paths by position. Run those self-tests from a terminal.
- `pipeline/prioritize.mjs` reads `data/scan-history.tsv` under the pipeline lock, but `scan.mjs` writes its history row after releasing it; a prioritize run in that gap can order a just-scanned job slightly lower. Nothing is lost.
- Playwright MCP has not been probed on this machine, so the Apply page drafts answers but does not fill the live form.
