# claude-probe-reads.mjs invariants

What must always hold for `npm run probe:reads` (and, where marked, `npm run probe:claude`). The tests in
`tests/unit/claude-probe.test.ts` and `tests/unit/claude-probe-invariants.test.ts` encode them.

## Inputs

1. **Same binary as the app (both probes).** `CC_CLAUDE_BIN` (blank means unset) resolves exactly as
   `supervisor/preflight.ts` `resolveClaudeBin` does: absolute as given, relative-with-slash joined textually to
   `INIT_CWD` (else the cwd), a bare name through PATH, `~/.local/bin`, then for `claude` only Homebrew and
   `/usr/local`. One function, `probe-cli.mjs` `resolveClaudeBin`, owns this; no probe resolves on its own.
2. **Keychain errors are not absence (both probes).** The token read is bounded (8 s, SIGKILL). Only exit 44
   (errSecItemNotFound) or a blank value on exit 0 is "not found"; a timeout, a missing `security`, a spawn error,
   a signal or any other exit is "could not be read" with the unlock hint. One classifier,
   `probe-cli.mjs` `keychainOutcome`, owns this. No layout, canary or call exists before the token is read.
3. **A CLI that cannot report its version runs nothing.** A `--version` spawn error (ENOENT), a timeout (30 s), a
   non-zero exit, a process group left running or no `x.y.z` in its output stops the run before any case call and
   before any record, naming the binary.

## State and ownership

4. **The token reaches only the child environment.** Never argv, a file or a log; everything printed or written
   passes `redact()`.
5. **Every call settles exactly once and settling never throws.** `runGroup` resolves once per call, after a spawn
   failure ('error' with no pid) or once the call's process group is gone (invariant 11); `runClaude` makes the result
   from that in one place, and every file read or write it does reports a failure into the case's stderr instead of
   throwing. A settled call is out of `running`.
6. **The run knows which calls did not run to their end.** `runClaude` adds a call to `incomplete` when its spawn
   failed, it timed out, it was killed (exit status null), its process group outlived 5 s of kills, or it was never
   started (stopping); the main flow adds every group that threw, and C13 adds the half `--raw-only` or `--guarded-only`
   leaves out.

## Exit and cleanup

7. **One owner for the end of the run.** Once the layout may exist, `finish()` is the only path to `process.exit`
   except a second signal: it stops every running call's process group (retrying until the groups are gone or 5 s
   pass), then runs `cleanup()` once. A first signal's code (130, 143, 129) is the exit code, even when the normal
   `finish()` is already under way; a second signal cleans up and exits at once. Cleanup runs every step even when
   one fails and names what may remain; a failed step makes a normal exit status 1.
8. **Cleanup removes only what this run created**: the home canary dir, the `~/.claude` canary file and other-project
   folder, transcripts whose project folder carries this layout's unique name, and the temp layout (unless --keep).
   Resources a case group acquires (the local WebFetch server) are released in that group's `finally`.

## The --record write

9. **Only a complete, uninterrupted run is recorded.** `probe-reads-record.mjs` `recordReadProbe` is the one decision:
   it refuses when a signal stopped the run, when `incomplete` is not empty (invariant 6), or for
   `--only` unless the existing record has the same version, model and invocation shape (compared key-order
   independently; a record without a shape never matches), because its old cases say nothing about another shape.
   Otherwise it merges (`--only`) or replaces the record,
   adds the version to `approvedVersions` only when every non-C0 case is `pass` or `info`, and recomputes C0.
10. **contract.json is the old bytes or the new record, never a torn file.** The write goes to a sibling temp file
    and is renamed over it; a failed write removes the temp file and leaves contract.json untouched. The record names
    no local path: the whole recorded run passes through `scrubPaths` first, which puts `$TMPDIR/cc-reads-probe-XXXXXX`,
    `$PACKAGE_ROOT`, `$NODE` and `$HOME` for the layout, the checkout, the node binary and the home folder (as spelled,
    symlink-free and in the CLI's dashed project-folder form), and a tool result is scrubbed before it is truncated.

## Child processes

11. **No process a probe starts outlives its result (both probes).** Every CLI process (each case call, `--version`,
    both of claude-probe.mjs's calls) leads its own process group, is started only through `probe-proc.mjs`
    `runGroup`, and is not reported until its group has no member left. One routine, `probe-proc.mjs` `stopGroups`,
    ends a group: it repeats SIGKILL until the group is gone or 5 s pass, and the call's own end, its timeout and a
    signal all use it. A group still there after 5 s is named. Once a signal is stopping a probe, no new process
    starts. The Keychain read is the one bounded `spawnSync`: `security` forks nothing.
