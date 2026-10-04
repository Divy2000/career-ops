# Custom Instructions -- career-ops (H-1B-aware fork)

<!-- ============================================================
     THIS FILE IS YOURS. The fork installer created it from
     custom/install/templates/_custom.md and never overwrites it.

     Procedural house rules go here ("HOW I want things done").
     Who you are (archetypes, narrative, comp) belongs in
     modes/_profile.md.
     ============================================================ -->

## House Rules

<!-- The onboarding procedure (custom/install/ONBOARDING.md) appends a
     "Sponsorship check" section here when you told it you need visa
     sponsorship. Add your own rules below. -->

(none yet -- add yours above)

## Custom Workflows

### "today" / "show today's jobs"

The daily job (`custom/immigration/run-daily.sh`, when installed) already ran: policy watch, scan, prioritize, rank, shortlist. Its log is `data/immigration/logs/<today>.log`.

1. Check the log's last line. If it is missing or says `failed=1`, tell me which step failed (lines starting `!!!`) before anything else.
2. Show today's section of `data/immigration/policy-digest.md` in 2-4 bullets, plus any new rows in `data/immigration/company-alerts.tsv` dated today.
3. Show the top 15 rows of `data/shortlist.md` as a table (score, sponsor tier, company, role, location, link), then its "Excluded by sponsorship alerts" section.
4. Ask which ones to evaluate. For each pick, run the normal `oferta` evaluation. Aggregator links must be confirmed at the employer first, per AGENTS.md.
5. After evaluations, offer `pdf` / `cover` / `apply` for those scoring 4.0+. Never submit; I click Submit myself.

To rebuild the shortlist by hand: `node custom/pipeline/shortlist.mjs`. To rank more of the backlog: `node rank-pipeline.mjs --limit 100 --model sonnet`, then rebuild the shortlist.

## Output Preferences

(none yet -- add yours above)

## Off-Limits

- This checkout is a clone of the Divy2000/career-ops fork. Never run `node update-system.mjs apply` or offer it when the session-start update check reports a new version: update with `git pull --ff-only` (or re-run `custom/install/install.sh`). Put new code under `custom/`, never in upstream files.
- Never auto-fill or submit an application without showing me first.
