#!/usr/bin/env node
// Reorder the pending rows of data/pipeline.md so today's new jobs, fresh
// postings and backend/AI titles come first. rank-pipeline.mjs ranks in file
// order, so this decides what gets ranked. Only pending rows move; every other
// line keeps its position.
//
//   node custom/pipeline/prioritize.mjs [--today YYYY-MM-DD]

import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { orderPending } from './lib.mjs';
import { withPipelineLock } from '../../pipeline-lock.mjs';
import { localToday } from '../../lib/local-today.mjs';
// Same resolved paths (data root + CAREER_OPS_* overrides) the scanner writes to.
import { PIPELINE_PATH as PIPELINE, SCAN_HISTORY_PATH as HISTORY } from '../../scan.mjs';

async function readFirstSeen() {
  const firstSeen = new Map();
  const lines = (await readFile(HISTORY, 'utf8')).split('\n');
  // scan.mjs also accepts a headerless history; skip only a real header row.
  if (lines[0]?.startsWith('url\t')) lines.shift();
  for (const line of lines) {
    const [url, seen] = line.split('\t');
    if (url && seen && !firstSeen.has(url)) firstSeen.set(url, seen);
  }
  return firstSeen;
}

async function main() {
  const ti = process.argv.indexOf('--today');
  // The local day, as scan.mjs stamps first-seen dates; the UTC day is already tomorrow on a US evening.
  const today = ti === -1 ? localToday() : process.argv[ti + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) throw new Error('--today needs a YYYY-MM-DD date');

  // Same lock scan.mjs and rank-pipeline.mjs hold, so a concurrent writer's
  // rows or rank annotations are never overwritten by a stale read.
  let firstSeen;
  const ordered = await withPipelineLock(PIPELINE, async () => {
    firstSeen = await readFirstSeen();
    const lines = (await readFile(PIPELINE, 'utf8')).split('\n');
    const slots = lines.flatMap((l, i) => (l.startsWith('- [ ] ') ? [i] : []));
    const sorted = orderPending(slots.map((i) => lines[i]), { today, firstSeen });
    slots.forEach((slot, k) => { lines[slot] = sorted[k]; });
    await copyFile(PIPELINE, `${PIPELINE}.bak`);
    const tmp = `${PIPELINE}.tmp-${process.pid}`;
    await writeFile(tmp, lines.join('\n'));
    await rename(tmp, PIPELINE);
    return sorted;
  });
  const fresh = ordered.filter((l) => firstSeen.get(l.split(' | ')[0].slice(6)) === today).length;
  process.stdout.write(`prioritized ${ordered.length} pending rows (${fresh} first seen ${today}); backup at data/pipeline.md.bak\n`);
}

main().catch((err) => {
  process.stderr.write(`prioritize failed: ${err.message}\n`);
  process.exit(1);
});
