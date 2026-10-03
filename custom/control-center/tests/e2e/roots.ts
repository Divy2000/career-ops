// Extra synthetic data roots for the e2e suite, derived from the shared fixture root.
import fs from 'node:fs';
import path from 'node:path';

const EM_DASH = String.fromCharCode(0x2014);
const LONG_URL = 'https://www.federalregister.gov/documents/2026/09/30/2026-00001/weighted-selection-process-for-registrants-and-petitioners-seeking-to-file-cap-subject-h-1b-petitions-and-more-words';
const LOCATIONS = [
  'Hybrid · New York, NY, USA · Bellevue, WA, USA · Palo Alto, CA, USA · Los Angeles, CA, USA · San Francisco, CA, USA',
  'Remote or Hybrid · OH, USA · Columbus, OH, USA',
  'Europe, USA, UK, Canada, Australia, Ireland, Switzerland, Singapore, Mexico, Iceland, Norway',
  'New York, NY; Boston, MA; Miami, FL',
  'Austin, TX, USA',
];
const ROLES = [
  'Software Engineer III - AWS, Databricks, Python, Pyspark, Postgres and Kubernetes Platform',
  'Associate software Engineer (Python AI)',
  'Senior Backend Engineer (AI Agent)',
  'Machine Learning Engineer, Level 3',
  'Software Development Engineer, AWS Agentic AI',
];

/** Same data as the fixture, minus the tracker, follow-ups and status ledger: a new user's first launch with a header-only tracker. */
export function writeEmptyRoot(dir: string, fixtureRoot: string): void {
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  for (const rel of ['data/follow-ups.md', 'data/status-log.tsv']) fs.rmSync(path.join(dir, rel), { force: true });
  fs.writeFileSync(
    path.join(dir, 'data', 'applications.md'),
    '# Applications Tracker\n\n| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n',
  );
}

/** Real-world sized rows: long locations, long roles, long rank reasons and long URLs in the policy digest. */
export function writeStressRoot(dir: string, fixtureRoot: string): void {
  fs.cpSync(fixtureRoot, dir, { recursive: true });
  const rows = Array.from({ length: 15 }, (_, i) => {
    const role = ROLES[i % ROLES.length]!;
    const loc = LOCATIONS[i % LOCATIONS.length]!;
    return `| ${i + 1} | ${(5.1 - i * 0.1).toFixed(1)} | ${(4.6 - i * 0.05).toFixed(1)} | strong | Amazon Development Center U.S., Inc. | [${role}](https://jobs.example.com/${i}) | ${loc} | 2026-09-${String(10 + i).padStart(2, '0')} | long sponsorship-friendly reason that keeps going and going for several more words |`;
  });
  fs.writeFileSync(
    path.join(dir, 'data', 'shortlist.md'),
    `# Shortlist - 2026-10-03\n\nRanked rows with rank >= 3: 184. Score = rank + sponsorship adjustment (strong +0.5, moderate +0.2, unknown -0.3, weak -1.0, none/staffing-shop -1.5). Sponsorship tier is DOL filing history and lags policy changes.\n\n| # | Score | Rank | Sponsor | Company | Role | Location | Posted | Why |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
  );
  const pipeline = Array.from({ length: 30 }, (_, i) => {
    const role = ROLES[i % ROLES.length]!;
    const loc = LOCATIONS[i % LOCATIONS.length]!;
    return `- [ ] https://jobs.example.com/stress/${i} | Off Duty Management ${i} | ${role} | ${loc} | rank: 3.${i % 10}/5 ${EM_DASH} FastAPI backend in Texas, near Dallas. Python API match, but onsite in Katy means relocation or a long commute and more words | posted: 2026-09-${String(10 + (i % 15)).padStart(2, '0')}`;
  });
  fs.writeFileSync(path.join(dir, 'data', 'pipeline.md'), `# Pipeline - Pending URLs\n\n## Pending\n\n${pipeline.join('\n')}\n`);
  const bullet = (lead: string) => `- **${lead}.** Three older changes that are still in effect were added to policy-changes.tsv (below). Skipped: the FY2027 registration-opening alerts, and an H-1B fraud guilty-plea release (enforcement only). Sources: [cap reached](${LONG_URL}), [selection completed](${LONG_URL}-2).`;
  fs.writeFileSync(
    path.join(dir, 'data', 'immigration', 'policy-digest.md'),
    `# Immigration policy digest\n\n## 2026-10-02\n\n${bullet('Backfill run (official items from 2026-01 to 2026-09)')}\n${bullet('H-1B lottery is now wage-weighted (final rule published 2025-12-29)')}\n${bullet('Adjustment of status reframed as extraordinary discretionary relief')}\n${bullet('Public charge rule changed and a new Form I-485 is required')}\n${bullet('Fifth bullet that the compact summary must drop')}\n\n## 2026-09-30\n\n- Weekly check: no new rules.\n`,
  );
}
