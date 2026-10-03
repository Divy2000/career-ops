# career-ops Control Center

A local, dark-mode web app that sits next to the career-ops checkout and lets you see and drive every capability (web alpha, TUI, modes, scripts, the fork's add-ons, settings, schedule and AI sessions) from the browser. It lives entirely under `custom/control-center/` so the weekly upstream merge never conflicts with it.

## Safety guarantees

- Listens on `127.0.0.1` only. Every request must carry a `Host` of `127.0.0.1:PORT` or `localhost:PORT`; anything else gets 403 (DNS-rebinding defense).
- A one-time token is generated per start and printed as `http://127.0.0.1:4317/auth?t=...`. Redeeming it sets an HttpOnly, SameSite=Strict cookie; every `/api/*` and SSE route requires that cookie.
- Mutating requests additionally need a same-origin `Origin` header and `X-CC: 1`.
- Responses carry `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'` (the dev client relaxes script/style for Vite HMR only).
- No shell: every child process is `spawn(cmd, args[], { shell: false })` from a static action registry. The client never sends a command string.
- AI sessions never submit or send anything. Writes are scoped per mode by permission rules plus a PreToolUse guard hook; `data/blacklist.md` and direct edits to `data/applications.md` are denied for every session.
- User data (CV, profile, portals, tracker, reports, immigration files) stays in the data root and is never committed. Test fixtures are synthetic.

## Install and launch

```bash
# from the career-ops root, first run only
npm --prefix custom/control-center ci

# start (opens the browser on the token URL)
npm --prefix custom/control-center start
# or
custom/control-center/bin/cc
```

Preflight fails with an actionable message when Node is below 22.6, the `claude` binary is missing, or the Keychain item `career-ops-claude-token` is absent (it prints the `claude setup-token` / `security add-generic-password` steps from `custom/immigration/run-daily.sh`). It warns when `ANTHROPIC_API_KEY` is set, because sessions force it empty.

Environment: `CC_PORT` (default 4317), `CC_DATA_ROOT` (defaults to the career-ops data root from `path-resolver.mjs`), `CC_CLAUDE_BIN`, `CC_NO_OPEN=1`.

## Pages

Work: Today, Pipeline, Tracker, Apply, Follow-ups, Interviews. Intel: Discover, Sponsorship, Insights. System: Sessions, Runs & Schedule, Profile & CV, Settings, Dev Chat. See `../../../.cc-build-SPEC.md` style notes in the repo spec for the full inventory; pages fill in phase by phase.

## AI sessions and permissions

Sessions run `claude -p` headless with `--permission-mode dontAsk`, path-scoped `Edit(...)` rules (which also cover Write and MultiEdit), a `--settings` PreToolUse/PostToolUse guard hook and `--strict-mcp-config`. Policy classes live in `server/claude/modes.ts`; the mode list is derived from `modes/**/*.md` by `scripts/derive-mode-policies.ts` and frozen in `modes.generated.json`. A test fails when the modes tree drifts.

## Daily job and schedule

The launchd job `com.career-ops.immigration-watch` runs `custom/immigration/run-daily.sh`. The app reads its dated logs (`---` step, `!!!` failure and `===` start/done markers) and will expose Run now / schedule edits through `launchctl` in a later phase.

## Development

```bash
npm --prefix custom/control-center run typecheck
npm --prefix custom/control-center run lint        # eslint plus the no-em-dash check
npm --prefix custom/control-center test            # vitest: unit and API (fastify.inject)
npm --prefix custom/control-center run test:e2e    # Playwright against npm start with a tmp fixture root
npm --prefix custom/control-center run derive:modes
npm --prefix custom/control-center run probe:claude   # two real haiku calls; records CLI semantics
```

- `tests/fixtures/root/` is a synthetic career-ops data root (no real names or companies). Every test copies it to a temp dir; nothing touches the real data root.
- `tests/fakes/claude.mjs` replays stream-json scenario files (`CC_FAKE_SCENARIO`), honors `--session-id` / `--resume`, performs scripted writes and runs the real guard hook from `--settings`.
- `server/core/contract.json` records the core CLI flags, pure exports and the Claude CLI probe results; `tests/unit/contract.test.ts` re-verifies them against the installed checkout and CLI on every run.

## How the weekly upstream merge is protected

Only `server/core/adapter.ts` knows core script names and export names, and it is driven by `contract.json`. When upstream renames a flag or an export, the contract test fails loudly and the adapter is the one place to update.

Note: `custom/` is public. `custom/immigration/daily-prompt.md` describes the user's visa situation in general terms by the user's own choice.

## Troubleshooting

- "Port 4317 is already in use": stop the other process or set `CC_PORT`.
- Locked page in the browser: open the `/auth?t=` link printed by `npm start` (the token changes on every start).
- `dist/index.html missing`: run `npm --prefix custom/control-center run build` before `start:built`.
