# Apply page invariants

A tracker row number is not an identity: it is reused after a delete reindexes the tracker. The application a page
works for is its `RowIdentity` (company, role, report), or the typed posting URL on `/apply` with no row. Two
identities are one application by the server's rule (`sameApplication`, server/claude/sessions.ts): the same company and
role, and no two different reports. A report linked to a row in place (null, then 42) is the same application, so it
keeps the row's form, draft and CV session. `sameApplication` in `draftStore.ts` is the page's one copy of that rule;
every "is this the shown application" check on the page goes through it, and a test holds it equal to the server's.

1. **Form state belongs to one application.** The typed link, CV and cover picks, drafted and edited answers, the
   prefill summary, the action message and the documents listing live in one form instance, created for one
   application. When the identity shown under the number changes, that instance is dropped and a clean one starts;
   no value held for the earlier owner is shown, sent in a prompt, sent by Fill or passed to Prefill for the new one.
2. **A draft session belongs to the application it was started for.** The page writes the identity next to every
   session it starts or forks (`cc.apply.row.<sid>`). A remembered draft or CV session whose recorded application is
   not the one shown is never attached, linked or filled; the remembered pointer to it is forgotten. A CV session the
   server pinned (`target.row`) is judged by that pin first; one with neither pin nor marker is taken as the row's.
3. **Per-draft storage has one owner and one format.** `draftStore.ts` defines every per-session key
   (`cc.apply.typedUrl.<sid>`, `cc.apply.docs.<sid>`, `cc.apply.row.<sid>`), their parse and write, and
   `forgetDraft(sid)`, the only way a draft's kept keys are released. Every exit from a draft (New draft, the session
   reported gone, a Fill turn answered 404, a draft found to be another application's) goes through it, so none can
   leave a key behind that a later draft reads. A tailored CV session's row marker is not released when the page lets
   go of its pointer: the CV guard reads it to name an earlier owner's live run that the server did not pin.
4. **What a draft carries on.** A new session (start or fork) records the link and the user's own picks of the form it
   was sent from, the latest ones at the moment its id comes back (also picks made while the start was in flight). A
   fork of a re-attached draft inherits that draft's link and picks, an explicit "None" (`''`) included. A reply
   (same session id) changes neither. A preselected suggestion is not a pick (`null`).
5. **Writes and paid starts name the row shown.** Mark applied, Draft answers and Generate CV PDF send the shown
   identity with the row number (`expectCompany`/`expectRole`/`expectReport`, or the start's `target.expect`), so the
   server refuses a row a reindex moved under it instead of writing or starting a paid session for it. Mark applied is
   not offered on an Applied row, and asks before moving a row back from Responded, Interview, Offer, Hired or Rejected.
6. **Paid starts are single.** Generate CV PDF stays off while the row's CV run is starting, live, or not yet known to
   be absent (sessions list pending or failed); the session in the way is linked, and named as the earlier
   application's when its pin says so.
