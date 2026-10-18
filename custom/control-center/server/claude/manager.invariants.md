# Session manager invariants

What must always hold for `manager.ts`, `sessions.ts`, `process-claim.ts` and the session routes, on one data root
shared by any number of server processes (a blue/green handover runs two). Tests:
`tests/api/manager-invariants-r33.test.ts` plus the per-round suites under `tests/api/session*`.

## Ownership

Every piece of shared state has exactly one owner at a time, and the owner is recorded where every process can see it.

| State | Owner | Recorded in | Taken | Released |
|-------|-------|-------------|-------|----------|
| Preparing a session's next turn | the process starting it | `{guard}/turn.claim` | before the idle check is trusted | in the `finally` of send / fork / delete |
| Following and settling a session's latest turn | the one tracker | `{guard}/track.claim` + `active` | when `track()` starts or a standby takes over a gone holder | `untrack()`, the single exit of every settle path; `close()` |
| Starting an evaluation of a posting | the starting process | `posting-claims/*.claim` + `postingHolds` | before the duplicate check | once the session's turn runs (or the start fails) |
| A fan-out starting a posting | the fan-out | `batchStarting` | with its posting claim | when the fan-out returns |
| A session's report number | the session record | `meta.reportNum` | at reservation | `setReportNum(null)` before the first await of the release |

A process claim names a live process. One whose holder is dead or a reused PID is taken over; a live holder is never
displaced, however long it takes.

## Idle

A session may start a turn, be forked from, or be deleted only when all of these hold:

- no process holds its turn claim or its track claim (a holder may be this process or a peer);
- its status is not `running` or `queued`;
- its last turn's run is not still stopping (a cancelled Claude process lives until SIGKILL).

A tracker holds the track claim from the moment it starts following the turn until the turn's outcome, report number,
policy ack and kept reservation are all settled, so a run that ended while its turn is not yet settled is never idle.
Only the track-claim holder settles a turn; a second tracker waits until the holder is gone or the turn has ended.

## Records

- A session's `status` describes its last turn: ending turn n never changes `status`, `error` or `lastReason` once a
  later turn exists (`SessionStore.endTurn`). A turn ends once; its cost is counted once.
- A report number is released once, ownership-checked against when the session got it.

## Refusals

- `isStartingInBatch` is true only while a fan-out (Batch evaluate) is starting the posting; a single start, reply or
  fork holding a posting claim is not a batch.
- A live tailored CV (pdf) session holds its tracker row number for the application it pinned (`target.row`). One
  pinned to a different application than the one the request names does not hold it; one with no pin, or a request
  whose application cannot be told, holds it. The check and the session's create run with no await between them.
