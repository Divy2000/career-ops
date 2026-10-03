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

Environment: `CC_PORT` (default 4317), `CC_DATA_ROOT` (defaults to the career-ops data root from `path-resolver.mjs`), `CC_CLAUDE_BIN`, `CC_NO_OPEN=1`, `CC_LAUNCH_AGENTS_DIR` (default `~/Library/LaunchAgents`), `CC_CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`, read-only usage meter).

## 3. Pages tour

Sidebar groups: Work (Today, Pipeline, Tracker, Apply, Follow-ups, Interviews), Intel (Discover, Sponsorship, Insights), System (Sessions, Runs & Schedule, Profile & CV, Settings, Dev Chat). The top bar has the command palette (Cmd+K), the daily-job chip, the Activity chip, the setup-health chip and the Ask drawer (Cmd+J). The sidebar footer shows the 5h/7d token meter.

- **Today**: shortlist top 15 with sponsor tiers, excluded-by-alert list, daily job result from the latest log, digest staleness, policy bullets, follow-ups due, decisions, fresh matches, quick evaluate (and the CV import hero when `cv.md` is missing).
- **Pipeline**: inbox with facets, skip/undo, add URLs, Evaluate visible (fan-out), Process inbox; shortlist with the excluded list; batch runner.
- **Tracker**: status tabs, Top 4+, search across company, role and notes, sorting on every column, grouped or flat view, column picker, keyboard navigation (`?` lists the keys), side preview, status control with discard reasons and the hired flow, multi-select with **Compare selected (ofertas)**, "Ask about tracker".
- **Application**: verdict callout, report sections, documents (PDFs, HTML twins, re-render), sponsorship panel, outreach, interview, offer and outcome modes, timeline, sessions, delete with dry-run preview.
- **Apply**: drafts answers from the `apply` mode as an editable form; "Fill real form" stays disabled until Playwright MCP is probed.
- **Follow-ups**: Cadence (log, pin, history, AI drafts), Replies (paste a reply, reply-watch digest, invite match, reply-watch session), Contacts (`data/contacts.tsv`, vCard export, LinkedIn join lookup).
- **Interviews**: active interviews, story bank with provenance counts, prep documents, weekly digest, process quality, rejection latency with explicit "Add to blacklist" buttons (they only open the Blacklist editor prefilled).
- **Discover**: network scan, portal scan, AI search, fresh matches, funded companies, reposts.
- **Sponsorship**: digest, policy changes, official feed, company alerts, company checks, H-1B lookup, tier cache, AI policy pass.
- **Insights**: Overview, Progress and Breakdown computed server-side; Funnel velocity, Patterns, Salary, Skills and Reposts & legitimacy run the core scripts (JSON, cached by input mtimes, with a run timestamp and Recompute); AI analyses launch patterns, calibrate, upskill and titles.
- **Sessions**: list, transcript, reply, fork, cancel, delete (dialog confirm); New session with any mode.
- **Runs & Schedule**: every run with its live log, cancel; both launchd jobs (daily `com.career-ops.immigration-watch`, weekly `com.career-ops.upstream-sync`) with loaded state, next fire, last exit, time editing, enable/disable and Run now; a log browser over `data/immigration/logs` and `data/upstream-sync`.
- **Profile & CV**: editors for the user markdown files, CV import, AI flows and exports.
- **Settings**: Portals (structured editor for every top-level key, raw YAML, health), Profile (form for every `profile.example.yml` section, follow-up cadence form, raw YAML), House rules, Blacklist, Plugins, AI engine (status, concurrency, model default, usage budgets, usage meter), Health, Updates (read-only, link to the sync PR), App (logos opt-in, run retention).
- **Dev Chat**: scoped edits with per-turn diffs and reverts.

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
| devchat | user layer and `custom/**` (never `supervisor/**`) | Dev Chat |

Every class is denied `data/blacklist.md`, direct edits to `data/applications.md`, git, network tools and shell operators in Bash. `server/claude/manager.ts` runs each turn through the detached runner (Claude slot cap from Settings > AI engine, default 2), reads the OAuth token from the Keychain at spawn (never written to disk; the wrapper redacts it from stored logs), normalizes stream-json into `events.ndjson` and applies the honesty gate. The model default from app settings is used when a session does not pick one.

## 5. Dev Chat scope, diffs and recovery

Dev Chat (`/dev`) edits the user layer and `custom/**` (never `supervisor/**`, `node_modules`, `applications.md`, or the blacklist unless the checkbox is ticked for that turn). The Changes panel shows per-turn unified diffs with Revert file / Revert turn (dialog confirm). Server edits trigger a blue/green restart; a failed restart keeps the old server and shows a banner. `/__recovery` (served by the supervisor, token or cookie gated) offers the same reverts even when the server child is broken.

## 6. Daily job and schedule

The launchd jobs `com.career-ops.immigration-watch` (daily, `custom/immigration/run-daily.sh`) and `com.career-ops.upstream-sync` (weekly, `custom/upstream-sync/sync.sh`) are read with `plutil -convert json` and `launchctl print`, and written by rendering the plist, `plutil -lint`, `launchctl bootout` and `launchctl bootstrap` (bootout only when disabling). `ProgramArguments` always points at the fork script. The app reads the dated logs (`---` step, `!!!` failure and `===` start/done markers) and shows a banner while `run-daily.sh` is running. Tests and the e2e server use an in-memory fake (`CC_FAKE_LAUNCHD=1`, honored only under `NODE_ENV=test`), so no test touches the real launchd.

## 7. Migration from `local/`

Already applied on the fork: `local/immigration` and `local/pipeline` moved to `custom/immigration` and `custom/pipeline`, the launchd job points at `custom/immigration/run-daily.sh`, and `custom/launchd/install.sh` (re)installs both jobs. The live cutover of launchd and `modes/_custom.md` on a machine still on `local/` is a user-run step after merge.

## 8. Development

```bash
npm --prefix custom/control-center run typecheck
npm --prefix custom/control-center run lint        # eslint plus the no-em-dash check
npm --prefix custom/control-center test            # vitest: unit, API (fastify.inject) and web (jsdom)
npm --prefix custom/control-center run test:e2e    # Playwright against npm start with a tmp fixture root
npm --prefix custom/control-center run derive:modes
npm --prefix custom/control-center run probe:claude   # two real haiku calls; records CLI semantics
```

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
