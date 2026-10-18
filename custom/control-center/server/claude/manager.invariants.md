# Session manager invariants

What must always hold for `manager.ts`, `sessions.ts`, `process-claim.ts` and the session routes, on one data root
shared by any number of server processes (a blue/green handover runs two). Tests:
`tests/api/manager-invariants-r33.test.ts` plus the per-round suites under `tests/api/session*`.

## Ownership

Every piece of shared state has exactly one owner at a time, and the owner is recorded where every process can see it.

| State | Owner | Recorded in | Taken | Released |
|-------|-------|-------------|-------|----------|
| Preparing a session's next turn | the process starting it | `{guard}/turn.claim` | before the idle check is trusted | in the `finally` of send / fork / delete / `whileIdle` |
| Following and settling a session's latest turn | the one tracker | `{guard}/track.claim` + `active` | when `track()` starts or a standby takes over a gone holder, always under the turn claim (see Claim order) | `untrack()`, the single exit of every settle path; `close()` |
| Starting an evaluation of a posting | the starting process | `posting-claims/*.claim` + `postingHolds` | before the duplicate check | once the session's turn runs (or the start fails) |
| A fan-out starting a posting | the fan-out | `batchStarting` | with its posting claim | when the fan-out returns |
| A session's report number | the session record | `meta.reportNum` | at reservation | `setReportNum(null)` before the first await of the release |
| A report number a session reserved itself | the session | `{guard}/held-report-nums.log` (`+N=<sentinel key>;`) | when its `reserve-report-num.mjs` output is read | the session's own release (`-N`), or the sentinel no longer being that reservation |

### Claim order

The two session claims are taken in one order: the turn claim, then the track claim. Every idle check (send, fork,
delete, `whileIdle`) holds the turn claim while it trusts that no track claim is held, and no tracker starts without
the turn claim: a turn this process just spawned is tracked under the turn claim its start still holds, and any other
tracker (a reconcile, a standby taking over) takes the turn claim first, takes the track claim, then lets the turn claim
go. While another process holds the turn claim, such a tracker stands by and asks again. So no tracker can start
between an idle check and its act. A reconcile that ends a running session in error because its run record is missing
does so under the turn claim too, after checking the track claim and reading the record again under it; it leaves the
session alone while another process holds either claim.

A track claim that cannot be written (a full disk, a read-only guard folder) is never read as held: a reconcile or a
standby stands by and asks again, and only a turn this process just spawned is followed without one, unless a live
tracker holds it (or that cannot be told either).

A process claim names a live process. One whose holder is dead or a reused PID is taken over; a live holder is never
displaced, however long it takes.

## Idle

A session may start a turn, be forked from, be deleted, or have a Dev Chat turn reverted only when all of these hold:

- no process holds its turn claim or its track claim (a holder may be this process or a peer);
- its status is not `running` or `queued`;
- its last turn's run is not still stopping (a cancelled Claude process lives until SIGKILL).

A Dev Chat revert runs through `SessionManager.whileIdle`: the check and the revert run under the turn claim, on the
record read under it, with no await between them, and a busy session is refused (409).

A tracker holds the track claim from the moment it starts following the turn until the turn's outcome, report number,
policy ack and kept reservation are all settled, so a run that ended while its turn is not yet settled is never idle.
Only the track-claim holder settles a turn; a second tracker waits until the holder is gone or the turn has ended, and
never claims a turn that has ended. A standby that cannot read the session warns, holds no claim and asks again on
its next try; nothing it reads throws out of its timer. The duplicate-evaluation checks count a session that is still finishing as live,
wherever it finishes.

## Records

- A session's `status` describes its last turn: ending turn n never changes `status`, `error` or `lastReason` once a
  later turn exists (`SessionStore.endTurn`). A turn ends once; its cost is counted once.
- A report number is released once, ownership-checked against when the session got it.
- Release report numbers (`pipeline.releaseReportNums`) refuses any number a session holds by either record above,
  read through `heldReportNumsOf` (the guard-hook's record rules); without the guard root it refuses everything.

## Refusals

- `isStartingInBatch` is true only while a fan-out (Batch evaluate) is starting the posting; a single start, reply or
  fork holding a posting claim is not a batch.
- A live tailored CV (pdf) session holds its tracker row number for the application it pinned (`target.row`). One
  pinned to a different application than the one the request names (another company or role, or two different
  reports) does not hold it; one with no pin, one pinned before its report was linked, or a request whose application
  cannot be told, holds it. The check and the session's create run with no await between them.

## Resources

- A documents-class turn (pdf, cover, latex, ...), or one whose mode file runs a `data/pdf-index.tsv` writer, holds
  the runner's `pdf-index` resource, as `docs.renderPdf` and `docs.coverPdf` do, so no two of them rewrite the manifest
  at once. Other turns hold no resource, so a fan-out's evaluations run side by side; an evaluation that runs
  generate-pdf.mjs can still overlap a re-render (generate-pdf.mjs takes no manifest lock).
