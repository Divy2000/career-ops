# Fork additions (Divy2000/career-ops)

Everything this fork adds lives under `custom/`, plus one file outside it: [`.github/README.md`](../.github/README.md), the fork's landing page on GitHub. No upstream file is modified, so the weekly upstream merge stays conflict-free (if upstream ever ships its own `.github/README.md`, `upstream-sync/keep-fork-readme.sh` keeps the fork's version and blocks that week's auto-merge). Personal data (CV, profile, portals, pipeline, tracker, reports) stays gitignored and never reaches this public repo.

| Path | What it does |
|---|---|
| `immigration/` | Daily US work-visa policy watch: Federal Register + USCIS feeds (`watch.mjs`), a headless Claude pass that updates `data/immigration/policy-digest.md`, `policy-changes.tsv` and `company-alerts.tsv` (`daily-prompt.md`), and the per-company sponsorship refresh rule (`freshness.mjs`). |
| `pipeline/` | `prioritize.mjs` orders `data/pipeline.md` so new, fresh, backend/AI jobs are ranked first; `shortlist.mjs` combines the relevance rank with DOL sponsorship tiers and company alerts into `data/shortlist.md`. |
| `immigration/run-daily.sh` | The 8am job: policy watch, scan, prioritize, rank (top 100), shortlist. Log: `data/immigration/logs/<date>.log`. |
| `upstream-sync/` | Weekly job: merges career-ops-hq/career-ops `main` into this fork on a branch, lets headless Claude (Opus 5.5, 1M context) resolve conflicts and adapt `custom/`, verifies tests, opens a PR, merges it when green, and fast-forwards the local checkout. Log and report: `data/upstream-sync/<date>.*`. |
| `launchd/install.sh` | Installs the macOS launchd jobs for the current checkout (`--jobs daily` for the 8am job only, `--jobs all`, the default, for both). |
| `install/` | The installer for other users: `install.sh` (script install, Markdown resume), `ONBOARDING.md` (the procedure Claude Code follows to build a profile from documents in any format), `bootstrap.sh` and the shipped house-rule template. Start from the landing README, [`.github/README.md`](../.github/README.md). |

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
