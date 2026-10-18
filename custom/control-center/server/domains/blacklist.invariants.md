# data/blacklist.md invariants (blacklist.ts)

What must always hold for the Control Center's reader and writer of `data/blacklist.md`. The reader that decides what
the file means is `scan.mjs` `parseBlacklist`; this module only lists and rewrites it. Encoded as tests in
`tests/unit/blacklist-invariants.test.ts`.

1. **Ownership.** The file is user layer. Its only writer in the Control Center is `writeBlacklist`, called by
   `PUT /api/blacklist` after the ETag and explicit-gate checks, with no `await` between the read the checks use and
   the atomic write (`writeFileAtomic`, temp file plus rename, so no exit path leaves a partial file).
2. **One table model.** The managed columns are Company, Since, Scope, Reason at positions 0 to 3, as the scanner reads
   every `|` line. `extraColumns` are the file's other columns: column 3 under its own name when its header is not
   Scope, then every header cell past Reason. The parser reads and the renderer writes cells through that one layout.
3. **Reader parity.** Every `|` line the scanner reads (first cell not blank, not only dashes, colons and spaces, not
   `company` in any case), in the table or not, is listed as exactly one row whose company, since, scope and reason
   equal what the scanner reads. Lines the scanner skips are never listed.
4. **Fixed point.** A save of the listed rows rewrites the file into the layout of rule 2; parsing that output gives
   the same rows (extra cells padded to the file's columns), the same `extraColumns`, no `unkept`, the same scanner
   entries in the same order, and saving it again changes nothing.
5. **No silent loss.** A save writes the preamble and postamble back verbatim (minus the `|` lines it moves into the
   table and the blank lines they leave) plus the rows it was sent. Every non-empty cell that would not survive (a line
   with no company, a cell past the last column, a third cell that is neither `company` nor `domain` while column 3 is
   Scope) is listed in `unkept`, and the route refuses every save while `unkept` is not empty.
6. **Existing data stays savable.** The listed rows sent back unchanged, in any order, pass every check: the schema puts
   no cap on the number of extra cells, length caps and the date and host rules exempt a value the same column of the
   file already holds, and the unread rule exempts rows the file already holds.
7. **No new dead row.** A save never adds a row the scanner never reads. A row whose key is empty, and every row of a
   key more than one sent row shares, must match a (scope, company) the file already holds, one for one. A key with a
   single row is always read, so it needs nothing.
8. **Rejected input.** A pipe or line break in any cell; a company the scanner skips (rule 3); a scope other than
   `company` or `domain`; more extra cells than the file has columns.
