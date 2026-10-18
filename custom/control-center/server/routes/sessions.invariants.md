# Invariants of the sessions routes (`sessions.ts`)

What must always hold for every route that starts work: `POST /api/sessions` (start), `POST /api/sessions/fanout`
(Batch evaluate), `POST /api/sessions/:id/turns` (reply) and `POST /api/sessions/:id/fork` (fork). Tests:
`tests/api/sessions-route-invariants.test.ts`.

## Admission

1. **One admission path per kind of start.** Every route that creates a session refuses an unknown or non-runnable
   mode through `modeRefused`; a single start is admitted by `admitNew`, a fan-out's postings by `processInboxHolds`
   and the manager's per-posting claims, and every reply or fork by `admitTurn`. No route runs its own copy of a guard.
2. **Check and act in one tick.** The last state check that admits a start and the session's create
   (`manager.start` records the session before its first await) run with no `await` between them. Every async input a
   check needs (the pinned tracker row, an extracted document, the daily-job probe, the prepared policy pass) is
   gathered before the checks run, never between them and the create.
3. **Rejected inputs.** A body naming `reportNum`; a URL target that is not a plain http(s) posting URL; a sponsorship
   check without a company target or with no company file; an unknown mode; a mode that never runs as a session; a
   fan-out of any mode that is not a posting evaluation; a blacklist unlock outside Dev Chat or without the
   `X-CC-Explicit: blacklist` header; Reply watch with no candidates file; an expected application (`target.expect`) on
   a target that is not a tracker row.
4. **Duplicate paid work is refused, never started twice.** One live (or starting, or still stopping) evaluation per
   posting and evaluation class, decided by the manager under its on-disk posting claim, so a second server process on
   the same roots is seen too (its `BusyError` is a 409). One Process inbox run at a time, and no evaluation of a
   pending Inbox row beside it. One tailored CV session per tracker row and pinned application. A session whose
   next turn or fork is starting counts as live for these holds (`turnsStarting`), from the admitting tick until the
   manager call returns or throws.

10. **A row start runs for the application it expects.** A tracker row number is reused after a reindex. A start whose
    `target.expect` names an application runs only when the row the server pins under that number is the same
    application (`sameApplication`); a number with no single row, or another application, is a 409 and nothing starts.
    The expectation is never stored; the stored `target.row` is always the tracker's pin, not the client's.

## The AI policy pass claim (`data/immigration/.policy-pass.claim`)

5. **One owner.** The claim is held by exactly one of `starting:<nonce>` (one request, while it creates a session),
   `session:<id>` or `daily:<pid>`. Only the request that wrote a `starting:` nonce moves or releases it.
6. **Every exit settles the starting claim, in one place.** `StartingClaim.settle` runs in a `finally` and leaves the
   claim in exactly one of three states: handed to the started session, which still runs; given back to the paused
   session a fork took it from; or released. This holds for a refusal, a throw while preparing, a throw from the
   manager, a lost claim, a session that ended before the handover, and a throw while handing over (the claim lock
   held past its wait, a batch write that failed). A cleanup write that throws is retried in the background until it
   goes through, because a `starting:` claim names this live process and is never taken over as stale.
7. **No unclaimed paid run.** A started session or fork that does not end up holding the claim is cancelled before
   the request answers; the answer is a 409 that names it.
8. **Batch ownership.** A fork receives the source's batch before the source gives it up, and the source gives it up
   only once the fork holds the claim; a fork that does not take the claim over holds no batch. A start that creates no
   session leaves no batch behind.
9. **Release on end.** A session's claim is released once the session is final (done, error, cancelled) or deleted
   and its last Claude run has exited.
