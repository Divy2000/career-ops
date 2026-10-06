#!/usr/bin/env node
// Reorder the pending rows of data/pipeline.md so today's new jobs, fresh
// postings and backend/AI titles come first. rank-pipeline.mjs ranks in file
// order, so this decides what gets ranked. Only pending rows move; every other
// line keeps its position.
//
//   node custom/pipeline/prioritize.mjs [--today YYYY-MM-DD]

import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { orderPending, parseRow } from './lib.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { localToday } from '../../lib/local-today.mjs';
// Same resolved paths (data root + CAREER_OPS_* overrides) the scanner writes to.
import { PIPELINE_PATH as PIPELINE, SCAN_HISTORY_PATH as HISTORY, formatPipelineOffer } from '../../scan.mjs';

// scan.mjs stores the raw URL in scan-history.tsv but escapes it in pipeline.md ([ and ] backslashed, | as %7C), so a
// history URL is keyed by the form the pipeline row carries, made by the same writer.
const pipelineUrl = (url) => parseRow(formatPipelineOffer({ url, company: '-', title: '-' }))?.url ?? url;

async function readFirstSeen() {
  const firstSeen = new Map();
  let text;
  try {
    text = await readFile(HISTORY, 'utf8');
  } catch (err) {
    // URLs added by hand write no history, so a root that was never scanned has none: no first-seen dates.
    if (err.code === 'ENOENT') return firstSeen;
    throw err;
  }
  const lines = text.split('\n');
  // scan.mjs also accepts a headerless history (same column order); skip only a real header row.
  const header = lines[0]?.startsWith('url\t') ? lines.shift().split('\t') : null;
  const statusAt = header ? header.indexOf('status') : 5;
  for (const line of lines) {
    const cells = line.split('\t');
    const [url, seen] = cells;
    // Only an `added` row is the day the job entered the pipeline: skipped_location, age and cooldown rows never pin a
    // URL (scan.mjs), so a later added row for it is the date that counts. The latest added row wins.
    const status = statusAt >= 0 ? cells[statusAt] : undefined;
    if (url && seen && (status === undefined || status.trim() === 'added')) firstSeen.set(pipelineUrl(url), seen);
  }
  return firstSeen;
}

const USAGE = `Usage: node custom/pipeline/prioritize.mjs [--today YYYY-MM-DD]
Reorders the pending rows of data/pipeline.md: jobs first seen today, fresh postings and backend/AI titles first.
  --today YYYY-MM-DD   the day that counts as today (default: the local date)
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const ti = process.argv.indexOf('--today');
  // The local day, as scan.mjs stamps first-seen dates; the UTC day is already tomorrow on a US evening.
  const today = ti === -1 ? localToday() : process.argv[ti + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) throw new Error('--today needs a YYYY-MM-DD date');

  // Same lock scan.mjs and rank-pipeline.mjs hold, so a concurrent writer's
  // rows or rank annotations are never overwritten by a stale read.
  let firstSeen;
  const ordered = await withPipelineLock(PIPELINE, async () => {
    firstSeen = await readFirstSeen();
    let text;
    try {
      text = await readFile(PIPELINE, 'utf8');
    } catch (err) {
      // scan.mjs creates the file only once a scan adds an offer, so a fresh root has none yet: nothing to order.
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const lines = text.split('\n');
    const slots = lines.flatMap((l, i) => (l.startsWith('- [ ] ') ? [i] : []));
    const sorted = orderPending(slots.map((i) => lines[i]), { today, firstSeen });
    slots.forEach((slot, k) => { lines[slot] = sorted[k]; });
    await copyFile(PIPELINE, `${PIPELINE}.bak`);
    const tmp = `${PIPELINE}.tmp-${process.pid}`;
    await writeFile(tmp, lines.join('\n'));
    await rename(tmp, PIPELINE);
    return sorted;
  });
  if (ordered === null) {
    process.stdout.write('prioritized 0 pending rows: no data/pipeline.md yet\n');
    return;
  }
  const fresh = ordered.filter((l) => firstSeen.get(l.split(' | ')[0].slice(6)) === today).length;
  process.stdout.write(`prioritized ${ordered.length} pending rows (${fresh} first seen ${today}); backup at data/pipeline.md.bak\n`);
}

main().catch((err) => {
  process.stderr.write(`prioritize failed: ${err.message}\n`);
  process.exit(1);
});
