// Extra synthetic data roots for the e2e suite, derived from the shared fixture root.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  writeDemoTutorials(dir, { long: true });
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
    return `- [ ] https://jobs.example.com/stress/${i} | Example Logistics ${i} | ${role} | ${loc} | rank: 3.${i % 10}/5 ${EM_DASH} FastAPI backend role. Python API match, but fully onsite in another city means relocation or a long commute and more words | posted: 2026-09-${String(10 + (i % 15)).padStart(2, '0')}`;
  });
  fs.writeFileSync(path.join(dir, 'data', 'pipeline.md'), `# Pipeline - Pending URLs\n\n## Pending\n\n${pipeline.join('\n')}\n`);
  const bullet = (lead: string) => `- **${lead}.** Three older changes that are still in effect were added to policy-changes.tsv (below). Skipped: the FY2027 registration-opening alerts, and an H-1B fraud guilty-plea release (enforcement only). Sources: [cap reached](${LONG_URL}), [selection completed](${LONG_URL}-2).`;
  fs.writeFileSync(
    path.join(dir, 'data', 'immigration', 'policy-digest.md'),
    `# Immigration policy digest\n\n## 2026-10-02\n\n${bullet('Backfill run (official items from 2026-01 to 2026-09)')}\n${bullet('H-1B lottery is now wage-weighted (final rule published 2025-12-29)')}\n${bullet('Adjustment of status reframed as extraordinary discretionary relief')}\n${bullet('Public charge rule changed and a new Form I-485 is required')}\n${bullet('Fifth bullet that the compact summary must drop')}\n\n## 2026-09-30\n\n- Weekly check: no new rules.\n`,
  );
}

const MEDIA_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'media');

/** Writes a 2 second H.264 clip with ffmpeg when it is installed; otherwise copies the committed fixture of the same clip. */
function writeClip(dest: string, ffmpegArgs: string[], fixture: string): void {
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...ffmpegArgs, dest], { stdio: 'ignore' });
  if (run.status !== 0 || !fs.existsSync(dest)) fs.copyFileSync(path.join(MEDIA_FIXTURES, fixture), dest);
}

const DEMO_SRT = '1\n00:00:00,100 --> 00:00:00,900\nHello, this is the first cue.\n\n2\n00:00:01,000 --> 00:00:01,900\nAnd this is the second cue.\n';
const DEMO_SCRIPT = '# Demo tour script\n\n## 1. Intro [intro]\n\n<!-- title card -->\nWelcome to the demo. The shortlist lives on Today.\n\n## 2. Middle [middle]\n\nThe tracker holds every application.\n\nFollow-ups keep the cadence.\n';

/**
 * A tutorial folder like the ones the Tutorials page reads (plus one broken folder, which must show up as a warning).
 * `long` swaps in a title, description and chapter names of real-world length for the layout checks.
 * `padding` adds a large sparse .mp4 that no manifest names, for tests that abort a long download.
 */
export function writeDemoTutorials(dir: string, opts: { long?: boolean; padding?: boolean } = {}): void {
  const root = path.join(dir, 'data', 'control-center', 'tutorials');
  const demo = path.join(root, 'demo-tour');
  fs.mkdirSync(demo, { recursive: true });
  writeClip(path.join(demo, 'demo-tour.mp4'), ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '5', '-movflags', '+faststart'], 'tiny-tutorial.mp4');
  writeClip(path.join(demo, 'poster.jpg'), ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1:duration=1', '-frames:v', '1', '-q:v', '5'], 'poster.jpg');
  fs.writeFileSync(path.join(demo, 'demo-tour.srt'), DEMO_SRT);
  fs.writeFileSync(path.join(demo, 'script.md'), DEMO_SCRIPT);
  const longTitle = 'Control Center end to end: from the first launch and login token to sponsorship intelligence, insights, scheduled jobs and Dev Chat';
  const chapters = opts.long
    ? [
        { title: 'Intro and safety model: what the Control Center can and cannot do on your behalf', start: 0 },
        { title: 'Launching and the one-time login token that is printed in your terminal at start', start: 0.5 },
        { title: 'Tracker and application detail, with the verdict, report sections and timeline', start: 1.5 },
      ]
    : [{ title: 'Intro', start: 0 }, { title: 'Middle', start: 0.5 }, { title: 'Outro', start: 1.5 }];
  fs.writeFileSync(
    path.join(demo, 'tutorial.json'),
    JSON.stringify({
      id: 'demo-tour',
      title: opts.long ? longTitle : 'Demo tour',
      description: opts.long ? `${longTitle}. ${longTitle}.` : 'A two second synthetic clip.',
      video: 'demo-tour.mp4',
      subtitles: 'demo-tour.srt',
      poster: 'poster.jpg',
      transcript: 'script.md',
      chapters,
    }),
  );
  if (opts.padding) {
    fs.writeFileSync(path.join(demo, 'padding.mp4'), '');
    fs.truncateSync(path.join(demo, 'padding.mp4'), 128 * 1024 * 1024);
  }
  const second = path.join(root, 'second-tour');
  fs.mkdirSync(second, { recursive: true });
  fs.copyFileSync(path.join(demo, 'demo-tour.mp4'), path.join(second, 'second.mp4'));
  fs.writeFileSync(path.join(second, 'tutorial.json'), JSON.stringify({ id: 'second-tour', title: 'Second tour', video: 'second.mp4' }));
  const broken = path.join(root, 'broken-demo');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'tutorial.json'), '{ "id": "broken-demo", ');
}
