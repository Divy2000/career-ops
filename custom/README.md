# Fork additions (Divy2000/career-ops)

Everything this fork adds lives under `custom/`, plus one file outside it: [`.github/README.md`](../.github/README.md), the fork's landing page on GitHub. No upstream file is modified, so the weekly upstream merge stays conflict-free (if upstream ever ships its own `.github/README.md`, `upstream-sync/keep-fork-readme.sh` keeps the fork's version and blocks that week's auto-merge). Personal data (CV, profile, portals, pipeline, tracker, reports) stays gitignored and never reaches this public repo.

| Path | What it does |
|---|---|
| `immigration/` | Daily US work-visa policy watch: Federal Register + USCIS feeds (`watch.mjs`), a headless Claude pass that updates `data/immigration/policy-digest.md`, `policy-changes.tsv` and `company-alerts.tsv` (`daily-prompt.md`), and the per-company sponsorship refresh rule (`freshness.mjs`). |
| `pipeline/` | `prioritize.mjs` orders `data/pipeline.md` so new, fresh, backend/AI jobs are ranked first; `shortlist.mjs` combines the relevance rank with DOL sponsorship tiers and company alerts into `data/shortlist.md`. |
| `immigration/run-daily.sh` | The 8am job: policy watch, scan, prioritize, rank (top 100), shortlist. Log: `data/immigration/logs/<date>.log`. |
| `projects/` | The projects library, `article-digest.md`: every project with copy-paste bullets, so a tailored CV can pick the 2 to 4 that fit a job while `cv.md` keeps only the default 2 or 3. `lib.mjs` parses, validates and edits it byte for byte, `rank.mjs` ranks it against a job description, `import.mjs` converts a projects JSON or another library into it. See [Projects library and CV build](#projects-library-and-cv-build). |
| `cv/` | The fork CV build: `build-html.mjs` checks a CV payload against `cv.md` and the library, then builds the HTML with the template pack in `cv/pack/`; `render-pdf.mjs` renders it and tightens the layout until it fits the page budget. Both hand off to the upstream scripts, whose checks still run. |
| `upstream-sync/` | Weekly job: merges career-ops-hq/career-ops `main` into this fork on a branch, lets headless Claude (Opus 5.5, 1M context) resolve conflicts and adapt `custom/`, verifies tests, opens a PR, merges it when green, and fast-forwards the local checkout. Log and report: `data/upstream-sync/<date>.*`. |
| `launchd/install.sh` | Installs the macOS launchd jobs for the current checkout (`--jobs daily` for the 8am job only, `--jobs all`, the default, for both). |
| `install/` | The installer for other users: `install.sh` (script install, Markdown resume), `ONBOARDING.md` (the procedure Claude Code follows to build a profile from documents in any format), `bootstrap.sh` and the shipped house-rule templates (`templates/_custom.md`, plus `_custom-projects.md` and `_custom-sponsorship.md`, which it adds under House Rules). Start from the landing README, [`.github/README.md`](../.github/README.md). |

## Projects library and CV build

`article-digest.md` (user layer, gitignored) holds one block per project:

```markdown
## Ticket Triage Bot -- https://github.com/you/ticket-triage
Tags: python, fastapi
- Built a FastAPI service that routes 2,000 support tickets a day.
- Cut first-response time from 9 to 2 hours.
```

The ` -- link` part, `Tags:` and `Dates:` are optional. A project needs 1 to 6 bullets (more than 6 is a warning, more than 8 an error). `Kind: publication` or `Kind: article` marks an entry that is not a project, so it is never offered as one. `Source: documents/projects/<file>` records the document an imported entry came from. Upstream digest blocks (`**Hero metrics:**`, `**Proof points:**`) are read too.

```bash
node custom/projects/rank.mjs jds/acme.md --json   # recommended 2-4, candidates, excluded, libraryCoverage
node custom/projects/rank.mjs --check              # validate article-digest.md
node custom/projects/import.mjs projects.json      # dry run; --write creates the file, --merge adds only new titles
```

`rank.mjs` is deterministic and spends no tokens: skill overlap with the job description plus tag keywords. Its `libraryCoverage` lists job skills that `cv.md` lacks but a library project shows, so they are not reported as gaps.

The always-on house rule (`install/templates/_custom-projects.md`, added to `modes/_custom.md` by the installer and onboarding) makes every `pdf`, `text`, `latex`, `cover`, `apply`, `oferta`, `auto-pipeline` and batch item pick projects from `rank.mjs` output, and build with the fork pipeline:

```bash
node custom/cv/build-html.mjs output/payload.json output/cv.html
node custom/cv/render-pdf.mjs output/cv.html output/cv.pdf --format=letter --report=012 --max-pages=1
```

`build-html.mjs` refuses a project that is in neither the library nor `cv.md`, a link its source does not give, and a paper listed under Projects. **Research papers and publications go in `cv.md` under `## Recent Achievements`** (after Education, newest first) and in the payload's `awards[]`, never in Projects. `render-pdf.mjs` tries four densities (10pt down to 8.5pt) and keeps the first whose PDF fits; without `--strict-pages` an overflow at the tightest density is a warning.

## Setup on a new machine

Other users: follow [`.github/README.md`](../.github/README.md) (Option 1, a Claude Code prompt, or Option 2, `custom/install/install.sh`). The manual steps below are the maintainer's.

```bash
gh repo clone Divy2000/career-ops && cd career-ops
git remote add upstream https://github.com/career-ops-hq/career-ops.git
npm install
claude setup-token   # then store it:
security add-generic-password -U -a "$USER" -s career-ops-claude-token -w
./custom/launchd/install.sh
```

If the checkout is under `~/Desktop` or `~/Documents`, give `/bin/bash` Full Disk Access (System Settings > Privacy & Security) so launchd can read it.

## Tests

```bash
node --test custom/*/tests/*.spec.mjs
```

Files are named `*.spec.mjs` because upstream's `test-all.mjs` rejects `*.test.mjs` files outside `tests/`.

## Do not

- Run `node update-system.mjs apply`: updates arrive through the weekly upstream-sync PR instead.
- Edit upstream files; add code under `custom/`.

## Known limitation

`pipeline/prioritize.mjs` reads `data/scan-history.tsv` under the pipeline lock, but `scan.mjs` writes its history row after releasing that lock. A prioritize run that lands in that gap can order a just-scanned job slightly lower. Nothing is lost; closing the gap would require changing upstream `scan.mjs`.
