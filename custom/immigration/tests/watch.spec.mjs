import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../../test-support/tmp.mjs';
import { dayIn } from '../../test-support/local-day.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH = path.join(REPO, 'custom', 'immigration', 'watch.mjs');

const DAY_MS = 86_400_000;
// The zone watch.mjs runs in, given to it explicitly (TZ) so the dates it writes are computable here.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Clocks where the local day differs from the UTC day: a US evening and an Indian early morning.
const NEAR_MIDNIGHT = [
  { zone: 'America/Los_Angeles', at: '2026-10-07T03:30:00Z' },
  { zone: 'Asia/Kolkata', at: '2026-10-06T19:30:00Z' },
];

/**
 * A data root and a fetch preload that answers both official sources offline from feeds.json, which a test rewrites
 * between runs. The Federal Register answers every search term with the same documents, as it does for a rule that
 * matches several of them. Items are dated the world's now, never a fixed day: watch.mjs only reads the last 14 days,
 * so a fixed date would age out of the window. `daysAhead` moves watch.mjs's clock (and that now) into the future.
 */
function watchWorld({ daysAhead = 0, zone = ZONE, at = null } = {}) {
  const root = tempDir('imm-watch-');
  const feeds = path.join(root, 'feeds.json');
  const preload = path.join(root, 'feeds.mjs');
  const offset = at ? Date.parse(at) - Date.now() : daysAhead * DAY_MS;
  const now = new Date(Date.now() + offset);
  const clock = offset ? `const RealDate = Date;\nglobalThis.Date = class extends RealDate {\n  constructor(...a) { super(...(a.length ? a : [RealDate.now() + ${offset}])); }\n  static now() { return RealDate.now() + ${offset}; }\n};\n` : '';
  fs.writeFileSync(preload, `import fs from 'node:fs';\n${clock}globalThis.fetch = async (url) => {\n  const f = JSON.parse(fs.readFileSync(${JSON.stringify(feeds)}, 'utf8'));\n  const u = String(url);\n  if (u.includes('federalregister')) {\n    if (f.frStatus) return new Response('unavailable', { status: f.frStatus });\n    if (f.frPages) {\n      const page = Number(new URL(u).searchParams.get('page') ?? 0);\n      const next = f.frRepeat ? u : page + 1 < f.frPages.length ? \`https://www.federalregister.gov/api/v1/documents.json?page=\${page + 1}\` : null;\n      return new Response(JSON.stringify({ results: f.frPages[page], next_page_url: next }), { status: 200 });\n    }\n    return new Response(JSON.stringify({ results: f.fr }), { status: 200 });\n  }\n  if (f.rssStatus) return new Response('unavailable', { status: f.rssStatus });\n  return new Response(\`<rss><channel>\${f.rss.join('')}</channel></rss>\`, { status: 200 });\n};\n`);
  const imm = path.join(root, 'data', 'immigration');
  const runRaw = (...args) => spawnSync(process.execPath, ['--import', preload, WATCH, ...args], { cwd: REPO, env: { PATH: process.env.PATH, HOME: root, CAREER_OPS_ROOT: root, NO_COLOR: '1', TZ: zone }, encoding: 'utf8', timeout: 60_000 });
  const run = (...args) => {
    const r = runRaw(...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return {
    imm,
    doc: (n, title) => ({ document_number: n, title, publication_date: now.toISOString().slice(0, 10), html_url: `https://www.federalregister.gov/d/${n}`, type: 'Rule', agencies: [{ name: 'USCIS' }] }),
    rssItem: (slug, title) => `<item><title>${title}</title><link>https://www.uscis.gov/news/${slug}</link><pubDate>${now.toUTCString()}</pubDate></item>`,
    setFeeds: ({ fr = [], rss = [], ...failures }) => fs.writeFileSync(feeds, JSON.stringify({ fr, rss, ...failures })),
    watch: () => JSON.parse(run()),
    watchRaw: () => runRaw(),
    now,
    // The local day watch.mjs dates its run by (localToday() in its zone).
    today: dayIn(zone, now),
    seen: () => JSON.parse(fs.readFileSync(path.join(imm, 'seen.json'), 'utf8')),
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
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements'), w.doc('2026-2', 'Fisheries of the Exclusive Economic Zone')], rss: [w.rssItem('opt', 'USCIS updates Optional Practical Training guidance')] });
  const out = w.watch();
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1', 'https://www.uscis.gov/news/opt']);
});

test('an item not yet acknowledged is offered again on the next run, but never queued or logged twice', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')] });
  w.watch();
  const again = w.watch();
  assert.deepEqual(again.new_items.map((i) => i.id), ['fr:2026-1']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1']);
});

test('--ack drops only the items of the batch the pass was given, and an acknowledged item is never offered again', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')] });
  const batch = w.watch();
  // A later run queues another item before the pass for the first batch is acknowledged.
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements'), w.doc('2026-3', 'Labor Certification for Permanent Employment')] });
  w.watch();
  assert.equal(w.ack(batch), 'acknowledged 1 item(s); 1 still pending\n');
  assert.deepEqual(w.pendingIds(), ['fr:2026-3']);
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-3']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1', 'https://www.federalregister.gov/d/2026-3']);
});

test('an item queued by a run that crashed before seen.json was written is not logged to the feed a second time', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')] });
  w.watch();
  fs.rmSync(path.join(w.imm, 'seen.json'));
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-1']);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1']);
  assert.deepEqual(w.feedUrls(), ['https://www.federalregister.gov/d/2026-1']);
});

test('the feed items stay inside the watch window whatever the day: a run 40 days from now still queues them', () => {
  const w = watchWorld({ daysAhead: 40 });
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')], rss: [w.rssItem('opt', 'USCIS updates Optional Practical Training guidance')] });
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
});

// ---- a source that fails, and paging ----

const dayBefore = (at, days) => new Date(at.getTime() - days * DAY_MS).toISOString().slice(0, 10);
// A YYYY-MM-DD day `days` days before another, by UTC-midnight arithmetic on the date itself, as newsSince counts back.
const daysBefore = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
const H1B = 'Modernizing H-1B Requirements';
const OPT = 'USCIS updates Optional Practical Training guidance';

/** A world whose sources both last succeeded 20 days ago, so a cursor that moved is visible, with one item queued. */
function afterOutage() {
  const w = watchWorld();
  const old = dayBefore(w.now, 20);
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_run: old, last_success: { 'federal-register': old, uscis: old } }));
  w.setFeeds({ fr: [w.doc('2026-9', 'Labor Certification for Permanent Employment')] });
  w.watch();
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ...w.seen(), last_success: { 'federal-register': old, uscis: old } }));
  return { w, old };
}

test('when one source fails, only the healthy source\'s cursor moves, and its items are still queued', () => {
  const { w, old } = afterOutage();
  w.setFeeds({ fr: [w.doc('2026-1', H1B)], rss: [w.rssItem('opt', OPT)], frStatus: 503 });
  const out = w.watch();
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-9', 'uscis:https://www.uscis.gov/news/opt']);
  assert.match(out.source_errors.join('\n'), /^federal-register: .*HTTP 503/);
  const { last_success: cursors } = w.seen();
  assert.equal(cursors['federal-register'], old, 'the failed source resumes from its last success next time');
  assert.notEqual(cursors.uscis, old);
});

test('when every source fails, the run exits 1 and changes nothing', () => {
  const { w } = afterOutage();
  const snapshot = () => Object.fromEntries(fs.readdirSync(w.imm).sort().map((f) => [f, fs.readFileSync(path.join(w.imm, f), 'utf8')]));
  const before = snapshot();
  w.setFeeds({ fr: [w.doc('2026-1', H1B)], rss: [w.rssItem('opt', OPT)], frStatus: 503, rssStatus: 500 });
  const r = w.watchRaw();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /every source failed: federal-register: .*HTTP 503; uscis: .*HTTP 500/);
  assert.deepEqual(snapshot(), before);
});

test('every page of a Federal Register reply is read before the source counts as successful', () => {
  const w = watchWorld();
  w.setFeeds({ frPages: [[w.doc('2026-1', H1B)], [w.doc('2026-3', 'Labor Certification for Permanent Employment')]] });
  assert.deepEqual(w.watch().new_items.map((i) => i.id), ['fr:2026-1', 'fr:2026-3']);
});

test('a Federal Register reply whose next page repeats fails that source instead of looping, and its cursor stays put', () => {
  const { w, old } = afterOutage();
  w.setFeeds({ frPages: [[w.doc('2026-1', H1B)]], frRepeat: true, rss: [w.rssItem('opt', OPT)] });
  const out = w.watch();
  assert.match(out.source_errors.join('\n'), /^federal-register: Federal Register returned a repeating next_page_url/);
  assert.equal(w.seen().last_success['federal-register'], old);
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-9', 'uscis:https://www.uscis.gov/news/opt'], 'a failed source contributes nothing, not even its first page');
});

// ---- the news window follows the last successful pass (SW8-scripts-01) ----

for (const clock of [{}, ...NEAR_MIDNIGHT]) test(`acknowledging a pass records it as the last successful one, and a later run keeps that date${clock.zone ? ` (${clock.zone} at ${clock.at})` : ''}`, () => {
  const w = watchWorld(clock);
  w.setFeeds({ fr: [w.doc('2026-1', H1B)] });
  const batch = w.watch();
  w.ack(batch);
  assert.equal(w.seen().last_pass, w.today);
  w.watch();
  assert.equal(w.seen().last_pass, w.today, 'a fetch run does not drop it');
});

test('after days with no successful pass, the news window reaches back to the last one', () => {
  const w = watchWorld();
  const lastPass = daysBefore(w.today, 8);
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_run: lastPass, last_pass: lastPass }));
  w.setFeeds({});
  assert.equal(w.watch().news_since, lastPass);
});

for (const clock of [{}, ...NEAR_MIDNIGHT]) test(`with no successful pass recorded, the news window is the last 3 days${clock.zone ? ` (${clock.zone} at ${clock.at})` : ''}`, () => {
  const w = watchWorld(clock);
  w.setFeeds({});
  assert.equal(w.watch().news_since, daysBefore(w.today, 3));
});
