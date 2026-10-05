import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH = path.join(REPO, 'custom', 'immigration', 'watch.mjs');

const doc = (n, title) => ({ document_number: n, title, publication_date: '2026-10-01', html_url: `https://www.federalregister.gov/d/${n}`, type: 'Rule', agencies: [{ name: 'USCIS' }] });
const rssItem = (slug, title) => `<item><title>${title}</title><link>https://www.uscis.gov/news/${slug}</link><pubDate>Thu, 01 Oct 2026 12:00:00 GMT</pubDate></item>`;

/**
 * A data root and a fetch preload that answers both official sources offline from feeds.json, which a test rewrites
 * between runs. The Federal Register answers every search term with the same documents, as it does for a rule that
 * matches several of them.
 */
function watchWorld() {
  const root = tempDir('imm-watch-');
  const feeds = path.join(root, 'feeds.json');
  const preload = path.join(root, 'feeds.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';\nglobalThis.fetch = async (url) => {\n  const f = JSON.parse(fs.readFileSync(${JSON.stringify(feeds)}, 'utf8'));\n  return new Response(String(url).includes('federalregister') ? JSON.stringify({ results: f.fr }) : \`<rss><channel>\${f.rss.join('')}</channel></rss>\`, { status: 200 });\n};\n`);
  const imm = path.join(root, 'data', 'immigration');
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['--import', preload, WATCH, ...args], { cwd: REPO, env: { PATH: process.env.PATH, HOME: root, CAREER_OPS_ROOT: root, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return {
    imm,
    setFeeds: ({ fr = [], rss = [] }) => fs.writeFileSync(feeds, JSON.stringify({ fr, rss })),
    watch: () => JSON.parse(run()),
    ack: (batch) => {
      const file = path.join(root, `batch-${Date.now()}-${Math.random()}.json`);
      fs.writeFileSync(file, JSON.stringify(batch));
      return run('--ack', file);
    },
    pendingIds: () => JSON.parse(fs.readFileSync(path.join(imm, 'pending.json'), 'utf8')).map((i) => i.id),
    feedUrls: () => fs.readFileSync(path.join(imm, 'official-feed.tsv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split('\t')[4]),
  };
}

test('a relevant item is queued once and logged to the feed once, though several search terms return it', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [doc('2026-1', 'Modernizing H-1B Requirements'), doc('2026-2', 'Fisheries of the Exclusive Economic Zone')], rss: [rssItem('opt', 'USCIS updates Optional Practical Training guidance')] });
  const out = w.watch();
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1', 'https://www.uscis.gov/news/opt']);
});

test('an item not yet acknowledged is offered again on the next run, but never queued or logged twice', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [doc('2026-1', 'Modernizing H-1B Requirements')] });
  w.watch();
  const again = w.watch();
  assert.deepEqual(again.new_items.map((i) => i.id), ['fr:2026-1']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1']);
});

test('--ack drops only the items of the batch the pass was given, and an acknowledged item is never offered again', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [doc('2026-1', 'Modernizing H-1B Requirements')] });
  const batch = w.watch();
  // A later run queues another item before the pass for the first batch is acknowledged.
  w.setFeeds({ fr: [doc('2026-1', 'Modernizing H-1B Requirements'), doc('2026-3', 'Labor Certification for Permanent Employment')] });
  w.watch();
  assert.equal(w.ack(batch), 'acknowledged 1 item(s); 1 still pending\n');
  assert.deepEqual(w.pendingIds(), ['fr:2026-3']);
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-3']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1', 'https://www.federalregister.gov/d/2026-3']);
});

test('an item queued by a run that crashed before seen.json was written is not logged to the feed a second time', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [doc('2026-1', 'Modernizing H-1B Requirements')] });
  w.watch();
  fs.rmSync(path.join(w.imm, 'seen.json'));
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-1']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1']);
});
