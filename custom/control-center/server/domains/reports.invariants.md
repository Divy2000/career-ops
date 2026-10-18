# reports.ts invariants

What must always hold for reading evaluation reports under `reports/`. The tests in `tests/unit/parsers.test.ts`,
`tests/unit/upstream-formats.test.ts` and `tests/unit/reports-invariants.test.ts` encode them.

Writers this module agrees with: `modes/oferta.md` (header, Machine Summary, lettered blocks, archived JD last),
`batch/batch-prompt.md` (header, archived JD, then Machine Summary and the lettered blocks), the `*-eval.mjs` scripts
(header, `---`, free text) and `check-jd-archive.mjs` (where an archived JD ends: `NEXT_REPORT_SECTION_RE`).

## The index

1. **Only files are reports.** A report is a regular file under `reports/`, or a symlink to one, named
   `<digits>-*.md`, that is neither a `NNN-RESERVED.md` placeholder nor a bare `YYYY-MM-DD.md` digest. A folder named
   like a report is never indexed. When two files share a number, the number index holds the first by name.
2. **A known file is read by name.** A caller that knows the file (a tracker link, a new file a session wrote) reads
   that file (`readReportFile`); it never goes through the number, which another file can share.
3. **Every read ends in one of four results.** `ok`, `missing` (ENOENT, or not in the index), `reserved` or
   `malformed` (with a reason and, when known, a line). A listed file that cannot be read as text (EISDIR, EACCES,
   EPERM) is `malformed` with the OS reason, never an exception that fails the whole tracker. Any other error
   propagates.

## Who owns each line

4. **Every line has one owner: the report or an archived JD.** An archived JD owns every line after its
   `## Job Description` heading up to its end. Nothing a JD owns (a heading, a fence, a `**Key:**` line, a `# ` line,
   yaml) is ever a report section, header field, title, Machine Summary or Block A field.
5. **One rule decides where a JD ends.** In the batch layout (no Machine Summary or lettered block before the JD) the
   JD ends at the report's tail: the last `## A)` heading after it whose lettered headings run A), B), ... through at
   least F) in order without repeating or going back, taken from the `## Machine Summary` directly before it when there
   is one. Otherwise, and in the oferta layout, it ends at the first `##` report template heading
   (`REPORT_SECTION`), fenced or not, as `check-jd-archive.mjs` reads it.
6. **Fences belong to their owner.** A code fence is tracked only in report-owned text; a fence a JD opens never
   hides the report's headings after the JD ends.
7. **The report's own Machine Summary** is the first `## Machine Summary` before the first archived JD, else the
   batch tail's. Nothing else is: a batch report without a full A) to F) run after its JD reads `machine: null`
   (its score still comes from the header).
8. **Header fields and the title come from report-owned text** (first match), never from a JD.

## Format

9. **The Machine Summary YAML** is the first fence in its section. Invalid YAML is a `ParseError` whose line is the
   1-based line in the file where yaml reports the error.
10. **A report is recognized** by a `# Word: Company - Role` title and either a `**Score:**` header or its own Machine
    Summary, all in report-owned text; anything else is `malformed`.
11. **Encoding noise is not content.** A leading UTF-8 BOM is ignored; CRLF line ends parse as LF ends.
