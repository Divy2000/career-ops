#!/usr/bin/env node
// Should this company's saved sponsorship check be refetched today?
//
//   node custom/immigration/freshness.mjs "<Company name>" [--today YYYY-MM-DD]
//
// Prints JSON: { company, slug, file, checked_at, policy_changes_count, refresh, reason }.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { companySlug, parsePolicyChanges, readCheckedAt, readSeenChangeCount, decideRefresh } from './lib.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { localToday } from '../../lib/local-today.mjs';
import { validateFlags, flagValue, hasFlag } from '../../lib/cli-flags.mjs';

const ROOT = getCareerOpsRoot();
const CHANGES = path.join(ROOT, 'data/immigration/policy-changes.tsv');

const USAGE = `Usage: node custom/immigration/freshness.mjs "<Company name>" [--today YYYY-MM-DD]
Prints whether the company's saved sponsorship check should be refetched today.
  --today YYYY-MM-DD   the day that counts as today (default: the local date)
`;

async function main() {
  const args = process.argv.slice(2);
  // An unknown flag (--json) is refused rather than checked as a company name.
  validateFlags(args, ['--today', '--help', '-h'], USAGE, { valueFlags: ['--today'], requireOperand: true });
  const operands = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--today');
  if (operands.length !== 1) throw new Error(`expected exactly one company name, got ${operands.length}\n${USAGE}`);
  const [company] = operands;
  const today = hasFlag(args, '--today') ? flagValue(args, '--today') : localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) throw new Error('--today needs a YYYY-MM-DD date');

  const slug = companySlug(company);
  const rel = `data/immigration/companies/${slug}.md`;
  const file = path.join(ROOT, rel);
  const saved = existsSync(file) ? await readFile(file, 'utf8') : '';
  const checkedAt = saved ? readCheckedAt(saved) : null;
  const seenChangeCount = saved ? readSeenChangeCount(saved) : null;
  const changes = existsSync(CHANGES) ? parsePolicyChanges(await readFile(CHANGES, 'utf8')) : [];
  const decision = decideRefresh({ today, checkedAt, changes, seenChangeCount });

  // policy_changes_count goes into the saved file as `policy_changes_seen:` on refresh.
  process.stdout.write(JSON.stringify({ company, slug, file: rel, checked_at: checkedAt, policy_changes_count: changes.filter((c) => c.detected <= today && c.announced <= today).length, ...decision }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`freshness check failed: ${err.message}\n`);
  process.exit(1);
});
