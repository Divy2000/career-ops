#!/usr/bin/env node
// Zero-token check of official US sources for work-visa policy items.
// Appends never-seen items to data/immigration/official-feed.tsv and prints
// them as JSON on stdout, so the daily Claude run only reads what is new.
//
//   node custom/immigration/watch.mjs [--since YYYY-MM-DD]

import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseRssItems, isRelevantPolicyItem, sinceForSource, sourceCursor, mergePending } from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const DIR = path.join(getCareerOpsRoot(), 'data/immigration');
const SEEN = path.join(DIR, 'seen.json');
const FEED = path.join(DIR, 'official-feed.tsv');
const PENDING = path.join(DIR, 'pending.json');

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
const FEED_HEADER = 'first_seen\tpublished\tsource\ttitle\turl\n';
// Readers also accept headerless files; creating the headers keeps them self-describing.
const HEADERS = {
  'policy-changes.tsv': 'detected_date\tannounced_date\tsource\ttitle\turl\timpact\n',
  'company-alerts.tsv': 'date\tcompany\tslug\tstatus\theadline\turl\n',
};

const FR_TERMS = ['H-1B', 'nonimmigrant workers', 'labor certification', 'employment-based immigrant', 'optional practical training'];
const USCIS_RSS = 'https://www.uscis.gov/news/rss-feed/59144';
const TIMEOUT_MS = 30000;

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'career-ops immigration-watch' } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

async function federalRegister(since) {
  const items = [];
  for (const term of FR_TERMS) {
    const q = new URLSearchParams({
      'conditions[term]': term,
      'conditions[publication_date][gte]': since,
      order: 'newest',
      per_page: '1000', // the API maximum; one page covers any realistic gap
    });
    for (const f of ['title', 'publication_date', 'html_url', 'document_number', 'type', 'agencies']) q.append('fields[]', f);
    // Follow every page before the source counts as successful, so a catch-up
    // run after an outage cannot advance the cursor past unread results.
    let url = `https://www.federalregister.gov/api/v1/documents.json?${q}`;
    const visited = new Set();
    while (url) {
      if (visited.has(url)) throw new Error(`Federal Register returned a repeating next_page_url for "${term}"`);
      visited.add(url);
      const data = JSON.parse(await fetchText(url));
      for (const d of data.results ?? []) {
        const agencies = (d.agencies ?? []).map((a) => a.name).join(', ');
        items.push({ id: `fr:${d.document_number}`, source: `Federal Register (${d.type}; ${agencies})`, title: d.title, url: d.html_url, published: d.publication_date });
      }
      url = data.next_page_url ?? null;
    }
  }
  return items;
}

async function uscis(since) {
  return parseRssItems(await fetchText(USCIS_RSS))
    .filter((i) => i.date >= since)
    .map((i) => ({ id: `uscis:${i.url}`, source: 'USCIS news', title: i.title, url: i.url, published: i.date }));
}

function parseArgs(argv) {
  const a = argv.indexOf('--ack');
  if (a !== -1) {
    if (!argv[a + 1]) throw new Error('--ack needs the path of the watch JSON that was processed');
    return { ack: argv[a + 1] };
  }
  const i = argv.indexOf('--since');
  if (i === -1) return { since: null };
  const since = argv[i + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) throw new Error('--since needs a YYYY-MM-DD date');
  return { since };
}

// Called after the AI pass succeeded: drop the items it was given from the queue.
async function ack(file) {
  const done = new Set(JSON.parse(await readFile(file, 'utf8')).new_items.map((i) => i.id));
  const pending = existsSync(PENDING) ? JSON.parse(await readFile(PENDING, 'utf8')) : [];
  const left = pending.filter((i) => !done.has(i.id));
  await writeAtomic(PENDING, JSON.stringify(left, null, 2) + '\n');
  process.stdout.write(`acknowledged ${pending.length - left.length} item(s); ${left.length} still pending\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ack) return ack(args.ack);
  const sinceArg = args.since;
  await mkdir(DIR, { recursive: true });
  for (const [name, header] of Object.entries(HEADERS)) {
    const file = path.join(DIR, name);
    if (!existsSync(file)) await writeFile(file, header);
  }
  const seen = existsSync(SEEN) ? JSON.parse(await readFile(SEEN, 'utf8')) : { ids: [] };
  const lastSuccess = { ...(seen.last_success ?? {}) };
  const today = new Date().toISOString().slice(0, 10);
  // Each source keeps its own last-success date, so a long outage of one source
  // is backfilled from where it stopped instead of only the default lookback.
  const sinceFor = (source) => sinceArg ?? sinceForSource({ lastSuccess: sourceCursor(seen, source), today });

  const sources = { 'federal-register': federalRegister, uscis };
  const names = Object.keys(sources);
  const results = await Promise.allSettled(names.map((n) => sources[n](sinceFor(n))));
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') lastSuccess[names[i]] = today;
    else errors.push(`${names[i]}: ${r.reason.message}`);
  });
  if (errors.length === results.length) throw new Error(`every source failed: ${errors.join('; ')}`);

  // Items still queued count as known: a crash after the queue write but
  // before seen.json must not append them to the feed log a second time.
  const queued = existsSync(PENDING) ? JSON.parse(await readFile(PENDING, 'utf8')) : [];
  const known = new Set([...seen.ids, ...queued.map((i) => i.id)]);
  const fresh = [];
  for (const item of results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))) {
    if (known.has(item.id) || !isRelevantPolicyItem(item.title)) continue;
    known.add(item.id);
    fresh.push(item);
  }

  // Queue first, then mark seen: a crash in between re-queues on the next run
  // (mergePending dedupes) instead of losing the item.
  const pending = mergePending(queued, fresh);
  await writeAtomic(PENDING, JSON.stringify(pending, null, 2) + '\n');
  // Audit log before seen, deduplicated by URL: a crash anywhere in this
  // sequence can neither drop nor duplicate a feed line on the next run.
  if (!existsSync(FEED)) await writeFile(FEED, FEED_HEADER);
  const logged = new Set((await readFile(FEED, 'utf8')).split('\n').slice(1).map((l) => l.split('\t')[4]).filter(Boolean));
  const clean = (s) => String(s ?? '').replace(/[\t\n]/g, ' ');
  const toLog = pending.filter((i) => !logged.has(clean(i.url)));
  if (toLog.length) {
    await appendFile(FEED, toLog.map((i) => [today, i.published, i.source, i.title, i.url].map(clean).join('\t')).join('\n') + '\n');
  }
  await writeAtomic(SEEN, JSON.stringify({ ids: [...known], last_run: today, last_success: lastSuccess }, null, 2) + '\n');

  const since = Object.fromEntries(names.map((n) => [n, sinceFor(n)]));
  // new_items is everything not yet acknowledged, including leftovers from failed runs.
  process.stdout.write(JSON.stringify({ date: today, since, new_items: pending, source_errors: errors }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`immigration-watch failed: ${err.message}\n`);
  process.exit(1);
});
