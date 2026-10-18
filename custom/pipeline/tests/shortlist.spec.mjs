import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { rootEnv } from '../../test-support/root-env.mjs';
import { formatRankSegment } from '../../../rank-pipeline.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';
import { localToday } from '../../../lib/local-today.mjs';
import { cacheKey } from '../../../plugins/h1b-sponsor/lib/cache.mjs';
import { spawnCpuLimited } from '../../test-support/cpu-limit.mjs';

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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { TZ: zone }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8').split('\n')[0], `# Shortlist - ${localToday}`);
});

test('the shortlist is written on a root with no data/immigration folder (the daily job never ran)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
});

test('the shortlist is written, empty, on a root with no data/pipeline.md yet (a first scan that added nothing)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /shortlist: 0 kept, 5 excluded/);
});

// One ranked pipeline row per company, fresh 'strong' tier cache entries (no network lookup) and the given alert rows.
function alertWorld(companies, alertRows) {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${companies.map((c, i) => `- [ ] https://jobs.example.com/${i} | ${c} | Backend Engineer | Remote | rank: 4.2/5 — fit`).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const tier = { tier: 'strong', matched: 'X', checked: localToday() };
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify(Object.fromEntries(companies.map((c) => [c, tier]))));
  fs.writeFileSync(
    path.join(root, 'data', 'immigration', 'company-alerts.tsv'),
    `date\tcompany\tslug\tstatus\theadline\turl\n${alertRows.map(([date, company, slug, status]) => `${date}\t${company}\t${slug}\t${status}\t${company} ${status} sponsorship\thttps://news.example/${slug}`).join('\n')}\n`,
  );
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { stdout: r.stdout, md: fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8') };
}

test('the newest alert that names a company applies, whether it matches by slug or by normalized name (R11-scripts-a-L3-01)', () => {
  // The older pause matches by slug, the newer resume by name once "Group" and "Holdings" are dropped.
  const r = alertWorld(['Globex Group'], [['2026-09-01', 'Globex Group', 'globex-group', 'paused'], ['2026-10-01', 'Globex Holdings', 'globex-holdings', 'resumed']]);
  assert.match(r.stdout, /shortlist: 1 kept, 0 excluded/, r.md);
  assert.match(r.md, /strong; resumed 2026-10-01/);
});

test('a pause filed under the legal name excludes the rows that carry the name without its corporate suffix (R11-scripts-a-L3-01)', () => {
  const r = alertWorld(['Acme Robotics'], [['2026-10-01', 'Acme Robotics, Inc.', 'acme-robotics-incorporated', 'paused']]);
  assert.match(r.stdout, /shortlist: 0 kept, 1 excluded/, r.md);
});

test('a pause filed under a dotted domain name excludes the rows that carry the bare brand name (R11-scripts-a-L3-01)', () => {
  const r = alertWorld(['Amazon'], [['2026-10-01', 'Amazon.com, Inc.', 'amazon-com', 'paused']]);
  assert.match(r.stdout, /shortlist: 0 kept, 1 excluded/, r.md);
});

test('an alert for a longer name does not exclude a company whose name is its first word (R11-scripts-a-L3-01)', () => {
  const r = alertWorld(['Meta'], [['2026-10-01', 'Meta Labs', 'meta-labs', 'paused']]);
  assert.match(r.stdout, /shortlist: 1 kept, 0 excluded/, r.md);
});

test('an alert for a shorter name does not exclude a company whose name extends it (R11-scripts-a-L3-01)', () => {
  // A standalone "AI" is part of the name, unlike a dotted ".ai" domain suffix.
  for (const [company, alert, slug] of [['ABC Labs', 'ABC', 'abc'], ['X-Ray Labs', 'X Corp', 'x'], ['Acme AI', 'Acme', 'acme']]) {
    const r = alertWorld([company], [['2026-10-01', alert, slug, 'paused']]);
    assert.match(r.stdout, /shortlist: 1 kept, 0 excluded/, `${company} vs ${alert}\n${r.md}`);
  }
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
    const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
  });
}

test('--help prints the usage and touches nothing: no lookups, no shortlist, no tier cache (SW-libs-05)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  const text = '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Data Analyst | Remote\n';
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), text);
  const r = spawnCpuLimited(process.execPath, [SHORTLIST, '--help'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST, '--min-rank', '1'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /Ranked rows with rank >= 1: 1\./);
});

test('the shortlist reads --min-rank in the --min-rank=N form too (SW6-libs-02)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Low Co': { tier: 'strong', matched: 'Low Co', checked: localToday() } }));
  const r = spawnCpuLimited(process.execPath, [SHORTLIST, '--min-rank=1'], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /Ranked rows with rank >= 1: 1\./);
});

test('the shortlist refuses an unknown flag such as --dry-run before any lookup or write (SW6-libs-02)', () => {
  const root = rankedRoot();
  const r = spawnCpuLimited(process.execPath, [SHORTLIST, '--dry-run'], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unrecognized flag\(s\): --dry-run/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
});

test('the shortlist refuses an empty --min-rank= or --top= instead of reading it as 0 (SW6-libs-02)', () => {
  for (const flag of ['--min-rank=', '--top=']) {
    const root = rankedRoot();
    const r = spawnCpuLimited(process.execPath, [SHORTLIST, flag], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
    assert.equal(r.status, 1, flag);
    assert.match(r.stderr, new RegExp(`${flag.slice(0, -1)} needs a number`));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
  }
});

test('the shortlist refuses a stray operand, such as a rank given without --min-rank, before any lookup or write (SW7-libs-02)', () => {
  for (const args of [['4'], ['--top', '10', 'extra']]) {
    const root = rankedRoot();
    const r = spawnCpuLimited(process.execPath, [SHORTLIST, ...args], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, new RegExp(`unexpected argument\\(s\\): ${args[args.length - 1]}`));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), ['pipeline.md']);
  }
});

test('the shortlist refuses a --top that is not a positive whole number and a --min-rank outside 0 to 5, before any lookup or write (SW7-libs-02)', () => {
  for (const args of [['--top', '-5'], ['--top=0'], ['--top=2.5'], ['--min-rank', '-1'], ['--min-rank=6']]) {
    const root = rankedRoot();
    const r = spawnCpuLimited(process.execPath, [SHORTLIST, ...args], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env, encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^tier lookup failed for Acme: fetch failed$/m);
  assert.match(r.stderr, /^tier lookup failed for Globex: fetch failed$/m);
  assert.deepEqual(sponsorCells(root), [['4', '4', 'lookup failed'], ['3.5', '3.5', 'lookup failed']]);
  const again = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
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
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'nothing was looked up');
  assert.match(r.stdout, /\(0 tier lookups\)/);
  assert.deepEqual(sponsorCells(root), [['4', '4', 'no company name'], ['3.5', '3.5', 'no company name']]);
});

test('a row with no usable company name reads the same without a backend, and triggers no install warning', () => {
  const root = namelessRoot();
  const env = rootEnv(root, { H1B_INDEX_PATH: path.join(root, 'no-index.db') });
  delete env.H1B_API_BASE;
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(sponsorCells(root), [['4', '4', 'no company name'], ['3.5', '3.5', 'no company name']]);
});

// ---- tier cache is persisted incrementally and atomically (R17-scripts-a-L1-01) ----

const waitFor = async (check, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('a run killed mid-lookup keeps the tier lookups already done and leaves no torn cache (R17-scripts-a-L1-01)', async () => {
  let globexSeen = false;
  const server = http.createServer((req, res) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') ?? '').toLowerCase();
    if (q.startsWith('globex')) {
      globexSeen = true;
      return; // hang: Globex never answers, so the run stays in its lookup
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = rankedRoot();
  try {
    const child = spawn(process.execPath, [SHORTLIST], {
      cwd: REPO,
      env: rootEnv(root, { H1B_API_BASE: `http://127.0.0.1:${server.address().port}` }),
      stdio: 'ignore',
      // Its own process group, so the kill below also reaps the check.mjs subprocess it spawned for the hung lookup.
      detached: true,
    });
    const exited = new Promise((r) => child.on('exit', r));
    await waitFor(() => globexSeen, 'the Globex lookup, meaning Acme was already looked up');
    process.kill(-child.pid, 'SIGKILL');
    await exited;
    const cachePath = path.join(root, 'data', 'immigration', 'sponsor-tiers.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.ok(cache['Acme'], `Acme was persisted before the kill:\n${JSON.stringify(cache)}`);
    assert.equal(cache['Globex'], undefined, 'the never-finished Globex lookup is not cached');
    assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'immigration')).filter((f) => f.includes('.tmp-')), [], 'no torn temp file is left behind');
  } finally {
    server.close();
  }
});

// ---- concurrent runs merge their tier lookups into the cache (R20-scripts-a-X-01) ----

test('two overlapping shortlist runs both keep their tier lookups: the slower write does not drop the faster one (R20-scripts-a-X-01)', async () => {
  let releaseAcme = null;
  let acmeSeen = false;
  const server = http.createServer((req, res) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') ?? '').toLowerCase();
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
    };
    // The first Acme lookup is held until the other run has finished, so this run read the cache before that run wrote it.
    if (q.startsWith('acme') && !acmeSeen) {
      acmeSeen = true;
      releaseAcme = answer;
      return;
    }
    answer();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = rankedRoot();
  const pipeline = path.join(root, 'data', 'pipeline.md');
  const row = (n, company) => `- [ ] https://jobs.example.com/${n} | ${company} | Backend Engineer | Remote | rank: 4.0/5 — fit\n`;
  const env = rootEnv(root, { H1B_API_BASE: `http://127.0.0.1:${server.address().port}` });
  try {
    fs.writeFileSync(pipeline, `# Pipeline\n\n## Pending\n\n${row(1, 'Acme')}`);
    const slow = spawn(process.execPath, [SHORTLIST], { cwd: REPO, env, stdio: 'ignore' });
    const slowExit = new Promise((r) => slow.on('exit', r));
    await waitFor(() => acmeSeen, 'the slow run to start its Acme lookup');
    fs.writeFileSync(pipeline, `# Pipeline\n\n## Pending\n\n${row(2, 'Globex')}`);
    // Not spawnSync: the stand-in API answers from this process, whose event loop must keep running.
    const fast = spawn(process.execPath, [SHORTLIST], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let fastErr = '';
    fast.stderr.setEncoding('utf8').on('data', (d) => { fastErr += d; });
    assert.equal(await new Promise((r) => fast.on('exit', r)), 0, fastErr);
    releaseAcme();
    assert.equal(await slowExit, 0);
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), 'utf8'));
    assert.ok(cache['Acme'], `the slow run's lookup is cached:\n${JSON.stringify(cache)}`);
    assert.ok(cache['Globex'], `the fast run's lookup survives the slow run's write:\n${JSON.stringify(cache)}`);
  } finally {
    server.close();
  }
});

test('a shortlist run whose pipeline changed during its lookups does not overwrite the newer shortlist with the old rows (R32-scripts-a-X-01)', async () => {
  let releaseAcme = null;
  let acmeSeen = false;
  const server = http.createServer((req, res) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') ?? '').toLowerCase();
    const answer = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
    };
    // The slow run's Acme lookup is held until a newer run has written its shortlist.
    if (q.startsWith('acme') && !acmeSeen) {
      acmeSeen = true;
      releaseAcme = answer;
      return;
    }
    answer();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = rankedRoot();
  const pipeline = path.join(root, 'data', 'pipeline.md');
  const out = path.join(root, 'data', 'shortlist.md');
  const row = (n, company) => `- [ ] https://jobs.example.com/${n} | ${company} | Backend Engineer | Remote | rank: 4.0/5 — fit\n`;
  const env = rootEnv(root, { H1B_API_BASE: `http://127.0.0.1:${server.address().port}` });
  const runShortlist = () => {
    const child = spawn(process.execPath, [SHORTLIST], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    return new Promise((r) => child.on('exit', (code) => r({ code, err })));
  };
  try {
    fs.writeFileSync(pipeline, `# Pipeline\n\n## Pending\n\n${row(1, 'Acme')}`);
    const slow = runShortlist();
    await waitFor(() => acmeSeen, 'the slow run to start its Acme lookup');
    fs.writeFileSync(pipeline, `# Pipeline\n\n## Pending\n\n${row(2, 'Globex')}`);
    const fast = await runShortlist();
    assert.equal(fast.code, 0, fast.err);
    assert.match(fs.readFileSync(out, 'utf8'), /\| Globex \|/);
    releaseAcme();
    const s = await slow;
    assert.equal(s.code, 0, s.err);
    const md = fs.readFileSync(out, 'utf8');
    assert.match(md, /\| Globex \|/, `the newer pipeline's row is still listed:\n${md}`);
    assert.doesNotMatch(md, /\| Acme \|/, `the old pipeline's row is not published:\n${md}`);
  } finally {
    server.close();
  }
});

test('a lookup that fails in one run does not replace the entry an overlapping run has just cached (R20-scripts-a-X-01)', async () => {
  let failAcme = null;
  let acmeSeen = false;
  const server = http.createServer((req, res) => {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') ?? '').toLowerCase();
    if (q.startsWith('acme') && !acmeSeen) {
      acmeSeen = true;
      failAcme = () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
      };
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = rankedRoot();
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Backend Engineer | Remote | rank: 4.0/5 — fit\n');
  const env = rootEnv(root, { H1B_API_BASE: `http://127.0.0.1:${server.address().port}` });
  const runShortlist = () => {
    const child = spawn(process.execPath, [SHORTLIST], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    return new Promise((r) => child.on('exit', (code) => r({ code, err })));
  };
  try {
    const slow = runShortlist();
    await waitFor(() => acmeSeen, 'the slow run to start its Acme lookup');
    const fast = await runShortlist();
    assert.equal(fast.code, 0, fast.err);
    failAcme();
    const s = await slow;
    assert.equal(s.code, 0, s.err);
    assert.match(s.err, /^tier lookup failed for Acme/m, 'the slow run did fail its lookup');
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), 'utf8'));
    assert.equal(cache['Acme'].error, undefined, `the fast run's answer is kept:\n${JSON.stringify(cache)}`);
    assert.equal(cache['Acme'].searched, true);
  } finally {
    server.close();
  }
});

// ---- the excluded bullet escapes a markdown-linked headline (R17-scripts-a-L3-02) ----

// The Control Center's greedy parse of `- Company - [Title](url) - label` (custom/control-center/server/domains/shortlist.ts).
const EXCLUDED_BULLET = /^- (.+?) - \[(.*)\]\((\S*)\) - (.*)$/;

test('an alert headline with a markdown link is written so the excluded bullet still parses (R17-scripts-a-L3-02)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Backend Engineer | Remote | rank: 4.2/5 — fit\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Acme': { tier: 'strong', matched: 'Acme', checked: localToday() } }));
  fs.writeFileSync(
    path.join(root, 'data', 'immigration', 'company-alerts.tsv'),
    `date\tcompany\tslug\tstatus\theadline\turl\n2026-10-01\tAcme\tacme\tpaused\tSee [the announcement](https://news.example/a) - more details\thttps://news.example/a\n`,
  );
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8');
  const line = md.split('\n').find((l) => l.startsWith('- Acme - '));
  assert.ok(line, `excluded bullet present in:\n${md}`);
  const m = line.match(EXCLUDED_BULLET);
  assert.ok(m, `excluded bullet parses:\n${line}`);
  assert.equal(m[1].trim(), 'Acme');
  assert.equal(m[2], 'Backend Engineer');
  assert.equal(m[3], 'https://jobs.example.com/1');
  assert.match(m[4], /^paused \(2026-10-01\): See the announcement - more details$/);
});

test('an alert headline keeps its pipe and a nested link still parses (R17-scripts-a-L3-02 edge cases)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Acme | Backend Engineer | Remote | rank: 4.2/5 — fit\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'sponsor-tiers.json'), JSON.stringify({ 'Acme': { tier: 'strong', matched: 'Acme', checked: localToday() } }));
  fs.writeFileSync(
    path.join(root, 'data', 'immigration', 'company-alerts.tsv'),
    `date\tcompany\tslug\tstatus\theadline\turl\n2026-10-01\tAcme\tacme\tpaused\tH-1B | OPT [[update]](https://news.example/b)\thttps://news.example/b\n`,
  );
  const r = spawnCpuLimited(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8');
  const line = md.split('\n').find((l) => l.startsWith('- Acme - '));
  assert.ok(line, `excluded bullet present in:\n${md}`);
  const m = line.match(EXCLUDED_BULLET);
  assert.ok(m, `excluded bullet parses:\n${line}`);
  assert.equal(m[2], 'Backend Engineer');
  assert.equal(m[3], 'https://jobs.example.com/1');
  assert.ok(m[4].includes('H-1B | OPT'), `pipe preserved (not a table cell): ${m[4]}`);
  assert.ok(m[4].includes('update'), `nested link text kept: ${m[4]}`);
  assert.ok(!m[4].includes('H-1B / OPT'), `pipe is not rewritten to a slash: ${m[4]}`);
});

test('a reader during the shortlist write sees the previous complete shortlist, never a truncated one (R24-scripts-a-L1-02)', async () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const out = path.join(root, 'data', 'shortlist.md');
  const previous = '# Shortlist - 2026-01-01\n\nthe previous complete shortlist\n';
  fs.writeFileSync(out, previous);
  const held = path.join(root, 'held');
  const release = path.join(root, 'release');
  // Writes any shortlist.md* file in two halves and holds between them, as a slow disk or a large table would.
  const preload = path.join(root, 'slow-write.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.promises.writeFile;
fs.promises.writeFile = async (file, data, ...rest) => {
  if (!path.basename(String(file)).startsWith('shortlist.md')) return real(file, data, ...rest);
  const text = String(data);
  const fh = await fs.promises.open(file, 'w');
  try {
    await fh.write(text.slice(0, text.length >> 1));
    fs.writeFileSync(${JSON.stringify(held)}, '');
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 20));
    await fh.write(text.slice(text.length >> 1));
  } finally {
    await fh.close();
  }
};
syncBuiltinESMExports();
`);
  const child = spawn(process.execPath, ['--import', preload, SHORTLIST], { cwd: REPO, env: rootEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exit = new Promise((resolve) => child.on('exit', resolve));
  let midWrite;
  try {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(held)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the shortlist write\n${stderr}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    midWrite = fs.readFileSync(out, 'utf8');
  } finally {
    fs.writeFileSync(release, '');
  }
  assert.equal(await exit, 0, stderr);
  assert.equal(midWrite, previous);
  assert.match(fs.readFileSync(out, 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n[\s\S]*## Excluded by sponsorship alerts/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')).filter((f) => f.startsWith('shortlist.md.')), []);
});

test('a shortlist write that fails leaves no temp file behind in data/ (R24-scripts-a-L1-02 review)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n${LOW_RANKED}\n`);
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const preload = path.join(root, 'rename-fails.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (String(to).endsWith('shortlist.md')) { const err = new Error('disk full'); err.code = 'ENOSPC'; throw err; }
  return real(from, to);
};
syncBuiltinESMExports();
`);
  const r = spawnCpuLimited(process.execPath, ['--import', preload, SHORTLIST], { cwd: REPO, env: rootEnv(root), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /disk full/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')).filter((f) => f.startsWith('shortlist.md')), []);
});

test('a tier cache write that fails leaves no temp file behind in data/immigration/ (R25-scripts-a-L1-01)', () => {
  const root = rankedRoot();
  const preload = path.join(root, 'rename-fails.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (String(to).endsWith('sponsor-tiers.json')) { const err = new Error('disk full'); err.code = 'ENOSPC'; throw err; }
  return real(from, to);
};
syncBuiltinESMExports();
`);
  const r = spawnCpuLimited(process.execPath, ['--import', preload, SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: 'http://127.0.0.1:9' }), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /disk full/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'immigration')).filter((f) => f.includes('.tmp-')), []);
});

// ---- H-1B lookup cache follows the data root (R31-tests-custom-X-01) ----

test('a tier lookup caches its H-1B answer under the data root, never in the checkout data/cache/h1b (R31-tests-custom-X-01)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = rankedRoot();
  // A name no real cache holds, so a leftover entry can only have come from this run.
  const company = `Shortlist Cache Probe ${process.pid}`;
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | ${company} | Backend Engineer | Remote | ${formatRankSegment(4.0, 'fit')}\n`);
  const entry = `${cacheKey(company)}.json`;
  try {
    const child = spawn(process.execPath, [SHORTLIST], { cwd: REPO, env: rootEnv(root, { H1B_API_BASE: `http://127.0.0.1:${server.address().port}` }), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    assert.equal(await new Promise((r) => child.on('exit', r)), 0, err);
    assert.ok(fs.existsSync(path.join(root, 'data', 'cache', 'h1b', entry)), 'the lookup is cached under the data root');
    assert.equal(fs.existsSync(path.join(REPO, 'data', 'cache', 'h1b', entry)), false, 'the checkout data/cache/h1b is untouched');
  } finally {
    server.close();
    fs.rmSync(path.join(REPO, 'data', 'cache', 'h1b', entry), { force: true });
  }
});
