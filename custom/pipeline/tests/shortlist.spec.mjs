import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';
import { formatRankSegment } from '../../../rank-pipeline.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';
import { localToday } from '../../../lib/local-today.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHORTLIST = path.join(REPO, 'custom', 'pipeline', 'shortlist.mjs');
// A row rank-pipeline.mjs ranked 1.0, below the default --min-rank 3, in the writer's own format (an em dash before the reason).
const LOW_RANKED = `- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | ${formatRankSegment(1.0, 'weak fit')}`;

test('the shortlist is dated by the local day, also when the UTC date is already another day', () => {
  const { zone, localToday } = zoneOffUtcDay();
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  // Ranked below the cut, so no sponsorship lookup runs.
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { TZ: zone }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8').split('\n')[0], `# Shortlist - ${localToday}`);
});

test('the shortlist is written on a root with no data/immigration folder (the daily job never ran)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
});

test('the shortlist is written, empty, on a root with no data/pipeline.md yet (a first scan that added nothing)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shortlist: 0 kept, 0 excluded/);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^Ranked rows with rank >= 3: 0\./m);
  assert.equal(fs.existsSync(path.join(root, 'data', 'pipeline.md')), false);
});

test('URL-only pipeline rows each get a shortlist row whose link reads as the URL', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  const urls = ['https://jobs.example.com/1', 'https://jobs.example.com/2', 'https://jobs.example.com/3'];
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${urls.map((u) => `- [ ] ${u} | rank: 4.0/5 — fit`).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8');
  for (const u of urls) assert.ok(md.includes(`[${u}](${u})`), `${u} in\n${md}`);
});

test('a paused sponsor is excluded whatever slug the alert row carries, keyed by its company name like the pipeline row (R8-05)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  const companies = ['AT&T', 'Acme Corporation', 'Globex Co', 'Initech plc', 'Umbrella GmbH'];
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${companies.map((c, i) => `- [ ] https://jobs.example.com/${i} | ${c} | Backend Engineer | Remote | rank: 4.0/5 — fit`).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  // Fresh tier cache entries, so the run looks nothing up over the network.
  const tier = { tier: 'strong', matched: 'X', checked: localToday() };
  const tiers = Object.fromEntries(companies.map((c) => [c, tier]));
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify(tiers));
  // Slugs as a session following the old prompt rule wrote them: & became a hyphen, only inc/llc/corp/ltd dropped.
  const slugs = ['at-t', 'acme-corporation', 'globex-co', 'initech-plc', 'umbrella-gmbh'];
  fs.writeFileSync(
    path.join(root, 'data', 'immigration', 'company-alerts.tsv'),
    `date\tcompany\tslug\tstatus\theadline\turl\n${companies.map((c, i) => `2026-09-29\t${c}\t${slugs[i]}\tpaused\t${c} pauses sponsorship\thttps://news.example/${i}`).join('\n')}\n`,
  );
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shortlist: 0 kept, 5 excluded/);
});

for (const [what, write] of [
  ['no portals.yml (the pasted-URL workflow)', () => {}],
  ['an empty portals.yml', (root) => fs.writeFileSync(path.join(root, 'portals.yml'), '')],
  ['a portals.yml with no title_filter', (root) => fs.writeFileSync(path.join(root, 'portals.yml'), 'tracked_companies: []\n')],
]) {
  test(`the shortlist is written with no title negatives on a root with ${what} (R8-13)`, () => {
    const root = tempDir('shortlist-');
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
    write(root);
    const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
  });
}

test('--help prints the usage and touches nothing: no lookups, no shortlist, no tier cache (SW-libs-05)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  const text = '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Data Analyst | Remote\n';
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), text);
  const r = spawnSync(process.execPath, [SHORTLIST, '--help'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node custom\/pipeline\/shortlist\.mjs \[--min-rank 3\] \[--top 40\]/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
});

test('the low-ranked fixture row reads as ranked, so the tests above cover the --min-rank cut, not an unranked row (SW-tests-16)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  // A fresh tier cache entry, so the run looks nothing up.
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Low Co': { tier: 'strong', matched: 'Low Co', checked: localToday() } }));
  const r = spawnSync(process.execPath, [SHORTLIST, '--min-rank', '1'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /Ranked rows with rank >= 1: 1\./);
});

test('the shortlist reads --min-rank in the --min-rank=N form too (SW6-libs-02)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Low Co': { tier: 'strong', matched: 'Low Co', checked: localToday() } }));
  const r = spawnSync(process.execPath, [SHORTLIST, '--min-rank=1'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /Ranked rows with rank >= 1: 1\./);
});

test('the shortlist refuses an unknown flag such as --dry-run before any lookup or write (SW6-libs-02)', () => {
  const root = rankedRoot();
  const r = spawnSync(process.execPath, [SHORTLIST, '--dry-run'], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unrecognized flag\(s\): --dry-run/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
});

test('the shortlist refuses an empty --min-rank= or --top= instead of reading it as 0 (SW6-libs-02)', () => {
  for (const flag of ['--min-rank=', '--top=']) {
    const root = rankedRoot();
    const r = spawnSync(process.execPath, [SHORTLIST, flag], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, flag);
    assert.match(r.stderr, new RegExp(`${flag.slice(0, -1)} needs a number`));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
  }
});

test('the shortlist refuses a stray operand, such as a rank given without --min-rank, before any lookup or write (SW7-libs-02)', () => {
  for (const args of [['4'], ['--top', '10', 'extra']]) {
    const root = rankedRoot();
    const r = spawnSync(process.execPath, [SHORTLIST, ...args], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, new RegExp(`unexpected argument\\(s\\): ${args[args.length - 1]}`));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
  }
});

test('the shortlist refuses a --top that is not a positive whole number and a --min-rank outside 0 to 5, before any lookup or write (SW7-libs-02)', () => {
  for (const args of [['--top', '-5'], ['--top=0'], ['--top=2.5'], ['--min-rank', '-1'], ['--min-rank=6']]) {
    const root = rankedRoot();
    const r = spawnSync(process.execPath, [SHORTLIST, ...args], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, args[0].startsWith('--top') ? /--top needs a positive whole number/ : /--min-rank needs a number from 0 to 5/, args.join(' '));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
  }
});

/** A root with two companies ranked above the cut, and nothing cached, so the run must look both up. */
function rankedRoot() {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Backend Engineer | Remote | rank: 4.0/5 — fit\n- [ ] https://jobs.example.com/2 | Globex | Data Engineer | Remote | rank: 3.5/5 — fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  return root;
}
const sponsorCells = (root) => fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8').split('\n').filter((l) => /^\| \d/.test(l)).map((l) => l.split(' | ').slice(1, 4));

test('with no H-1B index and no H1B_API_BASE, one warning says how to install it, and no row reads as the DOL tier unknown (SW2-libs-02)', () => {
  const root = rankedRoot();
  const env = rootEnv(root, { H1B_INDEX_PATH: path.join(root, 'no-index.db') });
  delete env.H1B_API_BASE;
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /no local H-1B index.*node plugins\/h1b-sponsor\/install-h1b-index\.mjs/);
  assert.doesNotMatch(r.stderr, /Command failed/);
  assert.match(r.stdout, /\(0 tier lookups\)/);
  assert.deepEqual(sponsorCells(root), [['4', '4', 'lookup unavailable'], ['3.5', '3.5', 'lookup unavailable']]);
  assert.equal(fs.existsSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json')) && Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), 'utf8'))).length, false, 'nothing cached, so the next run after an install looks them up');
});

test('a lookup that fails names check.mjs\'s reason and marks the row lookup failed, not the DOL tier unknown (SW2-libs-02)', () => {
  const root = rankedRoot();
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^tier lookup failed for Acme: fetch failed$/m);
  assert.match(r.stderr, /^tier lookup failed for Globex: fetch failed$/m);
  assert.deepEqual(sponsorCells(root), [['4', '4', 'lookup failed'], ['3.5', '3.5', 'lookup failed']]);
  const again = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 120_000 });
  assert.match(again.stdout, /\(2 tier lookups\)/, 'a failed lookup is retried on the next run, never cached as an answer');
});

// ---- rows with no usable company name (SW3-libs-03) ----

/** A root with a URL-only row and a row whose company is only a legal suffix, ranked above the cut, and an old cache entry. */
function namelessRoot() {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | rank: 4.0/5 — fit\n- [ ] https://jobs.example.com/2 | Inc. | Data Engineer | Remote | rank: 3.5/5 — fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  // What earlier versions cached for a nameless row: the DOL tier "unknown".
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ '': { tier: 'unknown', matched: null, checked: localToday(), note: 'no usable company name' } }));
  return root;
}

test('a row with no usable company name is labelled as such and left unadjusted, with a lookup backend present', () => {
  const root = namelessRoot();
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'nothing was looked up');
  assert.match(r.stdout, /\(0 tier lookups\)/);
  assert.deepEqual(sponsorCells(root), [['4', '4', 'no company name'], ['3.5', '3.5', 'no company name']]);
});

test('a row with no usable company name reads the same without a backend, and triggers no install warning', () => {
  const root = namelessRoot();
  const env = rootEnv(root, { H1B_INDEX_PATH: path.join(root, 'no-index.db') });
  delete env.H1B_API_BASE;
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(sponsorCells(root), [['4', '4', 'no company name'], ['3.5', '3.5', 'no company name']]);
});
