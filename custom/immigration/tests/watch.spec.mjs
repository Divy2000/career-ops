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

/** Noon of the local day `ms` falls on in `zone` (an hour off on a daylight-saving change day, still mid-day). */
function noonIn(zone, ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return ms - ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + DAY_MS / 2;
}

/**
 * A data root and a fetch preload that answers both official sources offline from feeds.json, which a test rewrites
 * between runs. The Federal Register answers every search term with the same documents, as it does for a rule that
 * matches several of them, but only those published inside the window asked for. Items are dated the world's now
 * unless a test gives a day relative to it, never a fixed day: watch.mjs only reads the last 14 days, so a fixed date
 * would age out of the window. watch.mjs's clock starts at `at`, or else at noon of today in `zone`
 * moved `daysAhead` days on, and runs from there: never from the real clock, so local midnight cannot pass between
 * computing the expected day here and watch.mjs dating its run. `root` reuses another world's data root, a later day.
 */
function watchWorld({ daysAhead = 0, zone = ZONE, at = null, root = tempDir('imm-watch-') } = {}) {
  const feeds = path.join(root, 'feeds.json');
  const preload = path.join(root, 'feeds.mjs');
  const frSince = path.join(root, 'fr-since.json');
  const start = at ? Date.parse(at) : noonIn(zone, Date.now()) + daysAhead * DAY_MS;
  const now = new Date(start);
  const clock = `const RealDate = Date;\nconst t0 = RealDate.now();\nglobalThis.Date = class extends RealDate {\n  constructor(...a) { super(...(a.length ? a : [${start} + RealDate.now() - t0])); }\n  static now() { return ${start} + RealDate.now() - t0; }\n};\n`;
  // Like the real API, the Federal Register returns only documents published on or after the window's first day
  // (conditions[publication_date][gte]), so a run that asks for the wrong window misses the documents before it. Every
  // run records the windows it asked for in fr-since.json.
  fs.writeFileSync(preload, `import fs from 'node:fs';
${clock}const asked = [];
globalThis.fetch = async (url) => {
  const f = JSON.parse(fs.readFileSync(${JSON.stringify(feeds)}, 'utf8'));
  const u = String(url);
  if (u.includes('federalregister')) {
    const params = new URL(u).searchParams;
    const since = params.get('conditions[publication_date][gte]');
    asked.push(since);
    fs.writeFileSync(${JSON.stringify(frSince)}, JSON.stringify(asked));
    if (f.frStatus) return new Response('unavailable', { status: f.frStatus });
    const inWindow = (docs) => docs.filter((d) => since !== null && d.publication_date >= since);
    if (f.frPages) {
      const page = Number(params.get('page') ?? 0);
      const next = f.frRepeat ? u : page + 1 < f.frPages.length ? \`https://www.federalregister.gov/api/v1/documents.json?conditions%5Bpublication_date%5D%5Bgte%5D=\${since}&page=\${page + 1}\` : null;
      return new Response(JSON.stringify({ results: inWindow(f.frPages[page]), next_page_url: next }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: inWindow(f.fr) }), { status: 200 });
  }
  if (f.rssStatus) return new Response('unavailable', { status: f.rssStatus });
  return new Response(\`<rss><channel>\${f.rss.join('')}</channel></rss>\`, { status: 200 });
};
`);
  const imm = path.join(root, 'data', 'immigration');
  const runRaw = (...args) => {
    fs.rmSync(frSince, { force: true });
    return spawnSync(process.execPath, ['--import', preload, WATCH, ...args], { cwd: REPO, env: { PATH: process.env.PATH, HOME: root, CAREER_OPS_ROOT: root, NO_COLOR: '1', TZ: zone }, encoding: 'utf8', timeout: 60_000 });
  };
  const run = (...args) => {
    const r = runRaw(...args);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return {
    root,
    imm,
    // A document or news item published `day` (YYYY-MM-DD), or else on the world's now.
    doc: (n, title, day = now.toISOString().slice(0, 10)) => ({ document_number: n, title, publication_date: day, html_url: `https://www.federalregister.gov/d/${n}`, type: 'Rule', agencies: [{ name: 'USCIS' }] }),
    rssItem: (slug, title, day = null) => `<item><title>${title}</title><link>https://www.uscis.gov/news/${slug}</link><pubDate>${(day ? new Date(`${day}T12:00:00Z`) : now).toUTCString()}</pubDate></item>`,
    setFeeds: ({ fr = [], rss = [], ...failures }) => fs.writeFileSync(feeds, JSON.stringify({ fr, rss, ...failures })),
    watch: (...args) => JSON.parse(run(...args)),
    watchRaw: (...args) => runRaw(...args),
    // The distinct publication_date windows the last run asked the Federal Register for.
    frSince: () => [...new Set(fs.existsSync(frSince) ? JSON.parse(fs.readFileSync(frSince, 'utf8')) : [])],
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
  w.setFeeds({ fr: [w.doc('2026-1', H1B)] });
  w.watch();
  assert.deepEqual(w.frSince(), [old], 'the next run asks the failed source for everything since its last success');
});

test('after an outage longer than the 14-day lookback, each source is read from its own last success, so items published during the outage are still queued (R35-tests-custom-L2-01)', () => {
  const w = watchWorld();
  const frCursor = dayBefore(w.now, 20);
  const uscisCursor = dayBefore(w.now, 25);
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_run: frCursor, last_success: { 'federal-register': frCursor, uscis: uscisCursor } }));
  w.setFeeds({
    fr: [w.doc('2026-1', H1B, dayBefore(w.now, 18)), w.doc('2026-2', 'Labor Certification for Permanent Employment', dayBefore(w.now, 22))],
    rss: [w.rssItem('opt', OPT, dayBefore(w.now, 23)), w.rssItem('h1b-cap', 'USCIS announces H-1B cap season', dayBefore(w.now, 27))],
  });
  const out = w.watch();
  assert.deepEqual(w.frSince(), [frCursor], 'the Federal Register is asked for everything since its own last success');
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt'], 'outage items past the lookback are queued, items before each cursor are not');
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

test('a --since run fetches the explicit window but leaves the per-source cursor, so a later normal run still backfills the outage (R17-scripts-a-L2-01)', () => {
  const w = watchWorld();
  const old = dayBefore(w.now, 20);
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_run: old, last_success: { 'federal-register': old, uscis: old } }));
  w.setFeeds({ fr: [w.doc('2026-1', H1B, dayBefore(w.now, 3)), w.doc('2026-2', 'Labor Certification for Permanent Employment', dayBefore(w.now, 8))], rss: [w.rssItem('opt', OPT, dayBefore(w.now, 3)), w.rssItem('h1b-cap', 'USCIS announces H-1B cap season', dayBefore(w.now, 8))] });
  const out = w.watch('--since', dayBefore(w.now, 5));
  assert.deepEqual(w.frSince(), [dayBefore(w.now, 5)], 'a --since run asks for exactly the window it was given');
  assert.deepEqual(out.new_items.map((i) => i.id), ['fr:2026-1', 'uscis:https://www.uscis.gov/news/opt']);
  const { last_success } = w.seen();
  assert.equal(last_success['federal-register'], old, 'a --since run must not advance the cursor');
  assert.equal(last_success.uscis, old);
  assert.equal(w.seen().last_run, old, 'a --since run must not advance the legacy last_run cursor');
});

test('a --since run on a fresh root writes no normal-run date, so a later run backfills from the floor', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', H1B)] });
  w.watch('--since', dayBefore(w.now, 5));
  const seen = w.seen();
  assert.equal(seen.last_run, null, 'a --since run must not record a normal-run date');
  assert.deepEqual(seen.last_success, {}, 'no per-source cursor is advanced on a --since run');
});

test('an unknown flag such as --dry-run is refused before any fetch or write, and --help prints usage and touches nothing (R17-scripts-a-L2-02)', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', H1B)] });
  const dry = w.watchRaw('--dry-run');
  assert.equal(dry.status, 1, dry.stderr);
  assert.match(dry.stderr, /unrecognized flag\(s\): --dry-run/);
  assert.equal(fs.existsSync(path.join(w.imm, 'seen.json')), false, 'the live watcher did not write seen.json');
  assert.equal(fs.existsSync(path.join(w.imm, 'pending.json')), false);
  const help = w.watchRaw('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: node custom\/immigration\/watch\.mjs/);
  assert.equal(fs.existsSync(path.join(w.imm, 'seen.json')), false);
});

test('--since -h treats -h as its date operand, not a help request (R17-scripts-a-L2-02)', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', H1B)] });
  const r = w.watchRaw('--since', '-h');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--since needs a YYYY-MM-DD date/);
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

test('a batch acknowledged days after its pass records the pass\'s day, so the next run still searches the news since then (R21-srv-dom-b-L1-01)', () => {
  const w = watchWorld();
  const passDay = daysBefore(w.today, 3);
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_pass: daysBefore(w.today, 10) }));
  w.setFeeds({});
  w.ack({ date: passDay, new_items: [] });
  assert.equal(w.seen().last_pass, passDay);
  // Ten days on the window floor is a week past the pass day: only the recorded day reaches back to it.
  const later = watchWorld({ root: w.root, daysAhead: 10 });
  later.setFeeds({});
  assert.equal(later.watch().news_since, passDay);
});

test('acknowledging an older batch never moves the last successful pass back, and a batch with no date leaves it as it was (R21-srv-dom-b-L1-01)', () => {
  const w = watchWorld();
  fs.mkdirSync(w.imm, { recursive: true });
  fs.writeFileSync(path.join(w.imm, 'seen.json'), JSON.stringify({ ids: [], last_pass: daysBefore(w.today, 1) }));
  w.ack({ date: daysBefore(w.today, 2), new_items: [] });
  assert.equal(w.seen().last_pass, daysBefore(w.today, 1));
  w.ack({ new_items: [] });
  assert.equal(w.seen().last_pass, daysBefore(w.today, 1));
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

for (const file of ['pending.json', 'seen.json']) test(`a ${file} write that fails leaves no temp file behind in data/immigration/ (R25-scripts-a-L1-01)`, () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')] });
  const preload = path.join(w.root, 'rename-fails.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const real = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  if (String(to).endsWith(${JSON.stringify(file)})) { const err = new Error('disk full'); err.code = 'ENOSPC'; throw err; }
  return real(from, to);
};
syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ['--import', path.join(w.root, 'feeds.mjs'), '--import', preload, WATCH], { cwd: REPO, env: { PATH: process.env.PATH, HOME: w.root, CAREER_OPS_ROOT: w.root, NO_COLOR: '1', TZ: ZONE }, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /disk full/);
  assert.deepEqual(fs.readdirSync(w.imm).filter((f) => f.includes('.tmp-')), []);
});

test('given an --ack whose pending.json rename fails and whose temp cleanup also fails, when it fails, then the rename error is reported and the cleanup failure is only noted (R28-scripts-a-L1-01)', () => {
  const w = watchWorld();
  w.setFeeds({ fr: [w.doc('2026-1', 'Modernizing H-1B Requirements')] });
  const batch = w.watch();
  const file = path.join(w.root, 'batch.json');
  fs.writeFileSync(file, JSON.stringify(batch));
  const failing = path.join(w.root, 'eio-eacces.mjs');
  fs.writeFileSync(failing, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realRename = fs.promises.rename;
const realRm = fs.promises.rm;
fs.promises.rename = async (from, to) => {
  if (String(from).includes('pending.json.tmp-')) { const err = new Error('i/o error'); err.code = 'EIO'; throw err; }
  return realRename(from, to);
};
fs.promises.rm = async (target, opts) => {
  if (String(target).includes('pending.json.tmp-')) { const err = new Error('permission denied'); err.code = 'EACCES'; throw err; }
  return realRm(target, opts);
};
syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ['--import', failing, WATCH, '--ack', file], { cwd: REPO, env: { PATH: process.env.PATH, HOME: w.root, CAREER_OPS_ROOT: w.root, NO_COLOR: '1', TZ: ZONE }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /immigration-watch failed: i\/o error/);
  assert.doesNotMatch(r.stderr, /immigration-watch failed: permission denied/);
  assert.match(r.stderr, /could not remove .*pending\.json\.tmp-\d+: permission denied/);
  assert.deepEqual(w.pendingIds(), ['fr:2026-1']);
});
