# App settings tabs: invariants

What must always hold for `AppTab.tsx` (`useAppSettings`, `useSaveSettings`, `AppTab`, `EngineSettings`). Tests:
`tests/web/app-settings-*.test.tsx`; `app-settings-invariants.test.tsx` checks them over table cases and seeded
random operation sequences.

1. **Save order.** Writes of one browser reach the server one at a time, in the order the user made them: in a tab
   through the module's write queue, across tabs through the `career-ops-app-settings-write` Web Lock. The latest
   choice is always the last one written. (R32-feat-c-X-01, R33-feat-c-X-01)
2. **Shown value is the latest choice.** Every view shows the server's last read with every unanswered patch of its
   tab on top, oldest first. A patch is added when its save starts and removed in one `finally` on every exit of that
   save, so none is left behind and none is removed early. A control computes its next value from that view, never
   from the bare read. (R33-feat-c-L1-01)
3. **A draft is cleared only by the answer to what it sent.** After a save is taken, a field's draft is cleared only
   if it still equals the value sent; a newer draft stays.
4. **Never defaults over an unreadable file.** When settings.json could not be read, both tabs show the problem with
   the defaults. A save sends only the patch, never the reset opt-in; the reset opt-in is sent only by the user's
   "Replace settings.json" action, with the very patch the server refused. (R33-feat-c-L2-01)
5. **Version ownership.** This browser's own writes are one record, `{ n, writes }`: a counter of its taken writes
   and the latest of them, each with the version it was sent against and the version it left. Only a write, while it
   holds the Web Lock, reads and replaces it (localStorage, or this tab's copy when storage is blocked). Every read put
   in the query cache carries `ownAt`, the counter when that read was asked for (for a write's answer or refusal: the
   counter it was answered at).
6. **If-Match is a pure function of (base read, record).** The base read is the cached read when the save starts,
   the one its patch was made from; the record is read when the write holds the Web Lock. A read the cache gets in
   between (a refusal's current values, a refetch) never becomes the base of a patch made before it, so a save queued
   behind a `settings-changed` refusal is refused too. (R37-feat-c-L1-01) A read is behind only this browser when an
   own write since it (counter above `ownAt`) was sent against the read's version and no later own write was sent against a
   version other than the one its predecessor left; it is then sent against the latest own write's version. Any other
   read is sent against its own version, so a change made elsewhere that a sibling tab wrote on top of is still
   refused for a tab that never showed it. Versions are content hashes and repeat (A-B-A, a deleted or restored file),
   so only the counter orders reads and writes. A read without a version sends no If-Match.
7. **Liveness.** A save from a read asked for after the file's last outside change (another browser or device, a
   hand edit, a restore) is taken. After a `settings-changed` refusal the current values are shown, the drafts kept,
   and the next save from them is taken unless the file changes outside again. (R34-feat-c-L1-01)
8. **Safety.** A save is refused when the file changed outside since the latest read or own write this browser bases
   it on; the outside change is never overwritten silently.
