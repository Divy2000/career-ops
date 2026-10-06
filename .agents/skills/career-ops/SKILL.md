---
name: career-ops
description: >-
  AI job search command center -- evaluate offers, generate CVs, scan portals,
  track applications. Use when the user pastes a job URL or JD, asks to scan
  portals, generate a CV/PDF, track applications, prepare for interviews, draft
  outreach/emails, or run any career-ops mode.
arguments: mode
user_invocable: true
user-invocable: true
argument-hint: "[scan | discover | deep | pdf | text | latex | latex-tex | cover | email | add | expand | eu-swe | oferta | ofertas | apply | batch | tracker | agent-inbox | pipeline | contacto | training | project | interview-prep | interview | master-profile | interview/plan | interview/practice | interview/debrief | interview-redflag | patterns | offer-prep | titles | upskill | followup | reply-watch | outcome | update]"
license: MIT
---

# career-ops -- Router

career-ops is a job-search command center that runs on several agent CLIs. This router picks a mode, loads its context, and runs it; the routing is the same on every CLI, whatever the entrypoint looks like.

## Project Root Resolution

Derive `PROJECT_ROOT` from this loaded `SKILL.md` before reading any repo-relative path: start at the skill file's directory and walk upward to the nearest directory that contains both `AGENTS.md` and `modes/`. Resolve every path in this router (`modes/`, `config/`, `data/`, scripts, templates, and output paths) against `PROJECT_ROOT`, never against the process's current working directory. This holds when the checkout is nested (for example `Development\\career-ops`) and when the command starts from a subdirectory. If no directory has both markers, locate the career-ops checkout before reading or writing any file.

## Invocation Notes

- CLIs with slash-command registration can expose this router as `/career-ops`.
- Cursor auto-discovers this skill at `.cursor/skills/career-ops/`; ask for a mode by name, or paste a JD/URL to trigger auto-pipeline.
- Pi auto-discovers it at `.agents/skills/career-ops/` and exposes it as `/skill:career-ops`; `AGENTS.md` loads from the repo root as project context, so there is no wrapper file. Headless Pi workers use `pi -p "prompt"`. Project skill discovery follows Pi's per-folder trust decision: `/trust` applies to future Pi processes, so restart `pi` before invoking `/skill:career-ops` (`-a` trusts a single run and needs no restart).
- Interactive Codex sessions run `codex` in the repo root. Slash commands are not guaranteed in Codex, so if `/career-ops` is unavailable, ask Codex to run the same mode by name.
- Headless Codex workers use `codex exec "prompt"`.
- Routing is identical whether the entrypoint is a slash command or a natural-language prompt.

Codex prompts that map to the same routing:

```text
Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123
Run the career-ops scan mode and summarize new matches.
Run the career-ops pipeline mode for data/pipeline.md.
Run the career-ops pdf mode for the latest evaluated role.
Run the career-ops tracker mode and summarize the current statuses.
```

## Mode Routing

Pick the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| JD text or URL (no sub-command) | **`auto-pipeline`** |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `interview-prep` | `interview-prep` |
| `interview` | `interview` |
| `master-profile` | `master-profile` |
| `eu-swe` | `regional/eu-swe` |
| `interview/plan` | `interview/plan` |
| `interview/practice` | `interview/practice` |
| `interview/debrief` | `interview/debrief` |
| `pdf` | `pdf` |
| `text` | `text` |
| `latex` | `latex` |
| `latex-tex` | `latex-tex` |
| `email` | `email` |
| `add` | `add` |
| `expand` | `expand` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `agent-inbox` | `agent-inbox` |
| `inbox` | `agent-inbox` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `discover` | `discover` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `offer-prep` | `offer-prep` |
| `titles` | `titles` |
| `upskill` | `upskill` |
| `followup` | `followup` |
| `reply-watch` | `reply-watch` |
| `outcome` | `outcome` |
| `interview-redflag` | `interview-redflag` |
| `update` | `update` |
| `cover` | `cover` |
| `triage` | `triage` |
| `ats` | `ats` |
| `calibrate` | `calibrate` |
| `intake` | `intake` |

When `$mode` is not a known sub-command, run `auto-pipeline` if it contains JD text (cues: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", a company name plus a role) or a URL to a JD. Otherwise show discovery.

---

## Output Language Directive

Before running any mode, read `config/profile.yml` if it exists and resolve:

- `language.output`: ISO language code for human-facing output. Default `en`.
- `language.modes_dir`: optional market-mode directory. It controls market vocabulary and local evaluation rules only, and takes one of two shapes:
  - A single string: one declared market (the historical default).
  - A list of declared candidate markets, for a candidate genuinely running parallel campaigns in several markets at once (#3793), e.g. `modes_dir: [modes/de, modes/zh]`. The first entry is primary and supplies the evaluation-mode file, since Block A-F rules run from one market's file at a time; every declared market's `_shared.md` is loaded into context. `modes` is a valid entry for a market with no localized directory; when first, it supplies `modes/oferta.md`, and its baseline `modes/_shared.md` is loaded once.

  For each posting, decide which declared market applies from the JD's market signals (hiring-entity jurisdiction, currency, benefits/legal vocabulary), not from the JD's language. If it is genuinely ambiguous, an interactive session asks and waits before writing a report or tracker entry; an unattended worker uses the primary market and records that fallback in the report header or Block G.

After loading the mode instructions and before producing any user-visible content, inject this directive:

> Write all human-facing output in `{language.output}` regardless of the language of these instructions or of the job description. This includes reports, tracker notes, PDFs, cover letters, outreach, interview prep, form answers, and summaries. If `language.modes_dir` supplies market-specific vocabulary (one market, or several declared at once), keep the market logic but explain terms in `{language.output}` when needed.

`language.output` decides the prose language. `modes_dir` only adds market context and never sets the prose language.

---

## Discovery Mode (no arguments)

On CLIs that support `/career-ops`, show the menu below. In Codex, present the same options in plain text and map the chosen one the same way:

```text
/career-ops {JD}           ↔ "Evaluate this JD with career-ops auto-pipeline: {JD or URL}"
/career-ops scan           ↔ "Run the career-ops scan mode and summarize new matches."
/career-ops pipeline       ↔ "Run the career-ops pipeline mode for data/pipeline.md."
/career-ops pdf            ↔ "Run the career-ops pdf mode for the latest evaluated role."
/career-ops email          ↔ "Run the career-ops email mode for the latest evaluated role."
/career-ops tracker        ↔ "Run the career-ops tracker mode and summarize the current statuses."
```

Menu:

```
career-ops -- Command Center

Available commands:
  /career-ops {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker (paste text or URL)
  /career-ops pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /career-ops triage    → Fast first-pass go/no-go score before a full evaluation
  /career-ops oferta    → Evaluation only A-F (no auto PDF)
  /career-ops ofertas   → Compare and rank multiple offers
  /career-ops contacto  → LinkedIn power move: find contacts + draft message
  /career-ops deep      → Deep research prompt about company
  /career-ops interview-prep → Generate company-specific interview prep doc
  /career-ops interview    → Interactive profile/CV onboarding interview
  /career-ops master-profile → Import, review, and validate your Master Career Profile
  /career-ops eu-swe    → Calibrate a European SWE application before CV/apply/interview
  /career-ops interview/plan → Time-blocked prep plan for an upcoming interview
  /career-ops interview/practice → Practice interview, one question at a time with feedback
  /career-ops interview/debrief → Post-interview debrief: close gaps, predict next round
  /career-ops pdf       → PDF only, ATS-optimized CV
  /career-ops ats       → Check a generated CV for ATS parseability (score + issues)
  /career-ops text      → Tailored markdown CV (mirrors cv.md, no PDF)
  /career-ops latex     → Export CV as LaTeX/Overleaf .tex
  /career-ops latex-tex → Tailor your own resume.tex in place (opt-in; cv.md stays default)
  /career-ops cover     → Cover letter: standalone JD paste or /career-ops cover {slug}
  /career-ops email     → Formal application email draft (draft-only; never sends, submits, or clicks)
  /career-ops add       → Add a project/paper/role to your CV (fetch + preview + confirm)
  /career-ops intake    → Build or enrich your profile from documents/ (proposes, writes only on confirm)
  /career-ops expand    → Auto-discover and add missing competencies from profile links
  /career-ops training  → Evaluate course/cert against North Star
  /career-ops project   → Evaluate portfolio project idea
  /career-ops tracker   → Application status overview
  /career-ops agent-inbox → Queue/drain requests for the next session (data/agent-inbox.md)
  /career-ops apply     → Live application assistant (reads form + generates answers)
  /career-ops scan      → Scan portals and discover new offers
  /career-ops discover  → Resolve a company list to scannable ATS boards + append to portals.yml (zero-token)
  /career-ops batch     → Batch processing with parallel workers
  /career-ops patterns  → Analyze rejection patterns and improve targeting
  /career-ops calibrate → Check whether evaluation scores predict your real outcomes (advisory)
  /career-ops offer-prep → Read a received offer/contract with the candidate: clause walk + lawyer questions (not legal advice)
  /career-ops titles    → Suggest adjacent job titles from your CV to broaden the search
  /career-ops upskill   → Aggregate skill-gap analysis from your evaluated reports
  /career-ops followup  → Follow-up cadence tracker: flag overdue, generate drafts
  /career-ops outcome   → Record application outcome & archive artifacts
  /career-ops update    → Update career-ops system files with diff preview + compat check

Inbox: add URLs to data/pipeline.md → /career-ops pipeline
Or paste a JD directly to run the full pipeline.
```

---

## Context Loading by Mode

Once the mode is known, load its files before running it.

`modes/_custom.md`, when it exists, holds the user's house rules and procedural preferences. Read it after `modes/_profile.md` and before the selected mode file. It may override workflow and style defaults but never adds factual claims about the candidate.

Resolve `language.modes_dir` before applying the path shorthand below:

- Not set: use `modes`.
- A single directory: use that directory's `_shared.md`, and its localized mode file where it provides one.
- A list: load every declared directory's `_shared.md` exactly once (including the baseline `modes/_shared.md` when `modes` is listed), and take the Blocks A-F evaluation-mode file only from the first entry; later entries add context, never a competing evaluation file.

User-layer `_profile.md` and `_custom.md` always stay under `modes/`.

### Modes that require `_shared.md` + their mode file

Read the resolved shared context (default `modes/_shared.md`) + `modes/_profile.md` (if exists) + `modes/_custom.md` (if exists) + the resolved selected mode file (default `modes/{mode}.md`). For an A-F evaluation the selected file is the primary directory's evaluation mode; do not also load an evaluation file from a secondary directory.

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `text`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes with profile and custom context

Read `modes/_profile.md` (if exists) + `modes/_custom.md` (if exists) + `modes/{mode}.md`

Applies to: `tracker`, `agent-inbox`, `deep`, `interview-prep`, `interview`, `master-profile`, `regional/eu-swe`, `interview/plan`, `interview/practice`, `interview/debrief`, `latex`, `latex-tex`, `training`, `project`, `patterns`, `titles`, `upskill`, `followup`, `reply-watch`, `outcome`, `cover`, `email`, `add`, `offer-prep`, `discover`

### Self-contained modes

Read only `modes/{mode}.md`; each of these names its own context, and `triage` deliberately skips the full profile to stay cheap.

Applies to: `triage`, `ats`, `calibrate`, `intake`

### Modes delegated to subagent

Run `scan`, `apply` (with Playwright), and `pipeline` (3+ URLs) in a worker/subagent, injecting the resolved shared context + `_profile.md` (if exists) + `_custom.md` (if exists) + the resolved selected mode file into the worker prompt. On a CLI with an `Agent(...)` primitive, the call looks like this:

```python
Agent(
  subagent_type="general-purpose",
  prompt="[output language directive]\n\n[content of modes/_shared.md, or resolved shared context: every declared _shared.md once]\n\n[content of modes/_profile.md if exists]\n\n[content of modes/_custom.md if exists]\n\n[content of modes/{mode}.md, or resolved selected mode file; primary evaluation file for Blocks A-F]\n\n[invocation-specific data]",
  description="career-ops {mode}"
)
```

Execute the instructions from the loaded mode file.
