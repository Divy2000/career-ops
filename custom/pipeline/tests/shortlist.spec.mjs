import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';
import { localToday } from '../../../lib/local-today.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHORTLIST = path.join(REPO, 'custom', 'pipeline', 'shortlist.mjs');

test('the shortlist is dated by the local day, also when the UTC date is already another day', () => {
  const { zone, localToday } = zoneOffUtcDay();
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  // Ranked below the cut, so no sponsorship lookup runs.
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | rank: 1.0/5 - weak fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, TZ: zone, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8').split('\n')[0], `# Shortlist - ${localToday}`);
});

test('the shortlist is written on a root with no data/immigration folder (the daily job never ran)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | rank: 1.0/5 - weak fit\n');
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
});

test('the shortlist is written, empty, on a root with no data/pipeline.md yet (a first scan that added nothing)', () => {
  const root = tempDir('shortlist-');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'portals.yml'), 'title_filter:\n  positive: []\n  negative: []\n');
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
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
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
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
  const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
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
    fs.writeFileSync(path.join(root, 'data', 'pipeline.md'), '# Pipeline\n\n## Pending\n\n- [ ] https://jobs.example.com/1 | Low Co | Data Analyst | Remote | rank: 1.0/5 - weak fit\n');
    write(root);
    const r = spawnSync(process.execPath, [SHORTLIST], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(root, 'data', 'shortlist.md'), 'utf8'), /^# Shortlist - \d{4}-\d{2}-\d{2}\n/);
  });
}
