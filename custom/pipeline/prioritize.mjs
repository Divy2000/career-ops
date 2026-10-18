#!/usr/bin/env node
// Reorder the pending rows of data/pipeline.md so today's new jobs, fresh
// postings and backend/AI titles come first. rank-pipeline.mjs ranks in file
// order, so this decides what gets ranked. Only pending rows move, each within
// its own section; every other line keeps its position.
//
//   node custom/pipeline/prioritize.mjs [--today YYYY-MM-DD]

import { readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { orderPending, parseRow, strayOperands } from './lib.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { localToday } from '../../lib/local-today.mjs';
import { validateFlags, flagValue, hasFlag } from '../../lib/cli-flags.mjs';
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

// A row's section is part of its meaning: scan.mjs and the Control Center read any row under `## Processed` as finished
// work, so a row must never cross a heading. Returns the line indexes of the `- [ ]` rows, one group per run between two
// headings (a `###` subgroup keeps its rows too), leaving out every run inside a Processed section. Section boundaries
// follow scan.mjs collectSeenUrls: a heading of level <= 2 ends a section, and only a `## Processed` one opens a done one.
function pendingRuns(lines) {
  const runs = [];
  let run = [];
  let inProcessed = false;
  for (const [i, line] of lines.entries()) {
    const heading = line.match(/^(#+)\s+(.*)$/);
    if (heading) {
      if (run.length) runs.push(run);
      run = [];
      if (heading[1].length <= 2) inProcessed = heading[1].length === 2 && /^processed\b/i.test(heading[2].trim());
    } else if (!inProcessed && line.startsWith('- [ ] ')) {
      run.push(i);
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

const USAGE = `Usage: node custom/pipeline/prioritize.mjs [--today YYYY-MM-DD]
Reorders the pending rows of data/pipeline.md: jobs first seen today, fresh postings and backend/AI titles first.
  --today YYYY-MM-DD   the day that counts as today (default: the local date)
`;

async function main() {
  const args = process.argv.slice(2);
  // An unknown flag (--dry-run) is refused before anything is rewritten.
  validateFlags(args, ['--today', '--help', '-h'], USAGE, { valueFlags: ['--today'], requireOperand: true });
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    process.stdout.write(USAGE);
    return;
  }
  // A date without --today is refused too, rather than ignored for the local date.
  const stray = strayOperands(args, ['--today']);
  if (stray.length) throw new Error(`unexpected argument(s): ${stray.join(' ')}\n${USAGE}`);
  // The local day, as scan.mjs stamps first-seen dates; the UTC day is already tomorrow on a US evening.
  const today = hasFlag(args, '--today') ? flagValue(args, '--today') : localToday();
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
    const sorted = [];
    for (const slots of pendingRuns(lines)) {
      const run = orderPending(slots.map((i) => lines[i]), { today, firstSeen });
      slots.forEach((slot, k) => { lines[slot] = run[k]; });
      sorted.push(...run);
    }
    await copyFile(PIPELINE, `${PIPELINE}.bak`);
    const tmp = `${PIPELINE}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, lines.join('\n'));
      await rename(tmp, PIPELINE);
    } finally {
      await rm(tmp, { force: true });
    }
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
