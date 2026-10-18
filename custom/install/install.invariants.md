# install.sh invariants

What must always hold for `custom/install/install.sh`, whatever a later change adds. Each line names the owner of a
piece of state and what may never happen to it. `tests/install-invariants.spec.mjs` encodes them; the other
`install*.spec.mjs` files cover the behavior around them.

## Process-owned state and cleanup

1. Every temp file or folder the run creates is made by `make_temp` and registered there; `drop_temp` is the only
   other way one is removed. Nothing else calls `mktemp`.
2. `cleanup` is the single exit owner and runs on every exit: normal end, `exit`/`die`, `set -e` failure, and the
   signals a terminal or launcher sends (HUP, INT, QUIT, TERM). It stops the queued lockf waiter, releases every daily
   lock this run holds and waits for its holder to end, then removes every registered temp path. When it returns, the
   lock is free, `.live-update.pid` is gone, and no process this run started for the lock is left.
3. The final `exec` of the Control Center runs `cleanup` first: exec keeps the PID, so a lock holder polling for it
   would otherwise live as long as the Control Center.
4. A daily-lock holder never outlives the installer and never writes for an installer that is gone.

## Data root

5. `DATA` has one writer, `set_data_root`, which resolves the root and refuses an unconfinable one (the filesystem root,
   home, or a folder containing home) in the same call. No log, lock, directory or user-layer file is created under a
   root that has not passed that refusal since it was last resolved, and it is resolved again whenever node, the marker
   or the environment can make it differ (after the prerequisites, after the checkout, after the marker is written).

## Claude Code and credentials

6. The headless Claude, and every `--version` probe that vouches for it, starts through `claude_child`: inherited
   `ANTHROPIC_*` variables and `CLAUDE_CODE_*` variables with a credential name segment are unset (the rule of
   child-env.ts `isCredential`, run-daily.sh and sync.sh), and the autoupdater is off. It gets one token, the Keychain
   one, only through its environment. The user's own interactive `claude` (setup-token, interactive onboarding) gets
   no token from the installer and keeps the user's environment.
7. A version is judged by one parser and one rule, the gate (`headless_claude_gate`): `parseClaudeVersion` from
   confinement.mjs reads the output, `versionAtLeast` from lib.mjs applies the floor (a pre-release sorts below its
   release), and the contract's `claude.approvedVersions` decides approval. A build the daily job and the Control
   Center accept is never refused for its spelling, and the binary that runs is the approved real path, re-checked
   just before the token is handed over.

## Ordering

8. Headless onboarding changes nothing on disk (earlier drafts stay where "Resume from drafts" looks) until every check
   that can refuse it has passed: Claude found, Keychain item present and readable and non-empty, version floor,
   approval, unchanged identity.
9. The Keychain secret of an item that existed before this run is never read outside headless onboarding (a read can
   prompt); only an item this run created is read back, so an empty paste counts as missing.

## Output

10. A URL shown or logged loses its userinfo, everything between `scheme://` and the last `@` of the authority, so no
    part of a credential reaches the screen or the install log.
