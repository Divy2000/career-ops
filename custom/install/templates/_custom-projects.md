### Projects library (every `pdf`, `text`, `latex`, `cover`, `apply`, `oferta`, `auto-pipeline` and batch item)

- My full project list is `article-digest.md`: one `## Title -- link` block per project with copy-paste bullets. Entries marked `Kind: publication` or `Kind: article` are not projects. `cv.md`'s Projects section holds only my default 2-3.
- Choosing projects (pdf step 11 and its text/latex equivalents): after the JD is saved under `jds/`, run `node custom/projects/rank.mjs jds/<slug>.md --json`. Pick 2-4 from `candidates`, starting from `recommended`; any swap needs a one-line reason. Take name, url and bullets from that output. Reorder, trim or reword toward JD keywords, but never add a fact, number or tool.
- Never put a research paper or publication in Projects. Papers live in `cv.md` under `## Recent Achievements` and go in the payload's `awards[]` (paper title as `title`, journal as `org`, date as `year`).
- A jd-skill-gap `gap` that rank.mjs lists in `libraryCoverage` is covered by that library project, not a gap.
- Build with `node custom/cv/build-html.mjs <payload.json> <html-path>` instead of step 18, and render with `node custom/cv/render-pdf.mjs <html-path> <pdf-path> --format=<letter|a4> --report=<NNN> --max-pages=1` instead of step 21. Steps 19, 20 and 22 are unchanged. If it still overflows at the tightest density, drop the lowest-ranked project first, then older roles' bullets, and rebuild.
- `add` for a project: write a block in the shape above to `article-digest.md`, then run `node custom/projects/rank.mjs --check`; add it to `cv.md` only if I ask. `add` for a paper: `cv.md` under `## Recent Achievements`.
- If `article-digest.md` is missing or `rank.mjs` fails, say so and pick projects from `cv.md` by judgment.
