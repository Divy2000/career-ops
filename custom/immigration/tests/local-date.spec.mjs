import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { zoneOffUtcDay } from '../../test-support/local-day.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const run = (script, args, env) => spawnSync(process.execPath, [...(env.preload ? ['--import', env.preload] : []), path.join(REPO, 'custom', 'immigration', script), ...args], { cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: env.root, TZ: env.zone, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });

test('the official-feed watcher dates its run and each source\'s last success by the local day', () => {
  const { zone, localToday } = zoneOffUtcDay();
  const root = tempDir('imm-watch-');
  // Both feeds answer with nothing new, offline.
  const preload = path.join(root, 'offline-feeds.mjs');
  fs.writeFileSync(preload, "globalThis.fetch = async (url) => new Response(String(url).includes('federalregister') ? JSON.stringify({ results: [] }) : '<rss><channel></channel></rss>', { status: 200 });\n");
  const r = run('watch.mjs', [], { root, zone, preload });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).date, localToday);
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'data', 'immigration', 'seen.json'), 'utf8'));
  assert.equal(seen.last_run, localToday);
  assert.deepEqual(seen.last_success, { 'federal-register': localToday, uscis: localToday });
});

test('the sponsorship freshness check counts the policy changes up to the local today', () => {
  const { zone, localToday, utcToday } = zoneOffUtcDay();
  const root = tempDir('imm-fresh-');
  fs.mkdirSync(path.join(root, 'data', 'immigration'), { recursive: true });
  // A change dated on the later of the two days: it has happened only where that day has begun.
  const later = localToday > utcToday ? localToday : utcToday;
  fs.writeFileSync(path.join(root, 'data', 'immigration', 'policy-changes.tsv'), `detected_date\tannounced_date\tsource\ttitle\turl\timpact\n${later}\t${later}\tUSCIS\tA change\thttps://example.gov/1\tmedium\n`);
  const r = run('freshness.mjs', ['Acme Robotics'], { root, zone });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).policy_changes_count, later <= localToday ? 1 : 0);
});
