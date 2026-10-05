// Extra synthetic data roots for the e2e suite, derived from the shared fixture root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

/**
 * One parent dir for every e2e temp root. The Playwright process makes it and gets `cleanup`; workers
 * and spec files re-import the config and find it through CC_E2E_TMP, so they make nothing.
 */
export function e2eTempParent(env: NodeJS.ProcessEnv = process.env, base = os.tmpdir()): { dir: string; cleanup: (() => void) | null } {
  if (env.CC_E2E_TMP) return { dir: env.CC_E2E_TMP, cleanup: null };
  const dir = fs.mkdtempSync(path.join(base, 'cc-e2e-'));
  env.CC_E2E_TMP = dir;
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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

/** Writes a 2 second H.264 clip (or one JPEG frame) with ffmpeg when it is installed; otherwise copies the committed fixture of the same clip. */
function writeClip(dest: string, ffmpegArgs: string[], fixture: string): void {
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...ffmpegArgs, dest], { stdio: 'ignore' });
  if (run.status !== 0 || !fs.existsSync(dest)) fs.copyFileSync(path.join(MEDIA_FIXTURES, fixture), dest);
}

const DEMO_SRT = '1\n00:00:00,100 --> 00:00:00,900\nHello, this is the first cue.\n\n2\n00:00:01,000 --> 00:00:01,900\nAnd this is the second cue.\n';
const DEMO_SCRIPT = '# Demo tour script\n\n## 1. Intro [intro]\n\n<!-- title card -->\nWelcome to the demo. The shortlist lives on Today.\n\n## 2. Middle [middle]\n\nThe tracker holds every application.\n\nFollow-ups keep the cadence.\n';

/**
 * A small valid animated GIF (every frame one flat colour from a 4 colour palette), built byte by byte so no binary is committed.
 * The LZW stream emits a clear code every second pixel, which keeps the code size at 3 bits for any decoder.
 */
export function tinyGif(frameColours: number[], width = 32, height = 18): Buffer {
  const palette = [0x8b, 0x9d, 0xff, 0x3e, 0xcf, 0x8e, 0xf5, 0xb9, 0x4a, 0x5a, 0xb8, 0xf0];
  const parts: number[][] = [
    [...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0x81, 0, 0, ...palette],
    [0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0],
  ];
  for (const colour of frameColours) {
    const codes: number[] = [];
    for (let i = 0; i < width * height; i++) {
      if (i % 2 === 0) codes.push(4);
      codes.push(colour);
    }
    codes.push(5);
    const bytes: number[] = [];
    let bits = 0;
    let have = 0;
    for (const code of codes) {
      bits |= code << have;
      have += 3;
      while (have >= 8) {
        bytes.push(bits & 255);
        bits >>= 8;
        have -= 8;
      }
    }
    if (have > 0) bytes.push(bits & 255);
    const blocks: number[] = [];
    for (let i = 0; i < bytes.length; i += 255) blocks.push(Math.min(255, bytes.length - i), ...bytes.slice(i, i + 255));
    parts.push([0x21, 0xf9, 0x04, 0x04, 25, 0, 0, 0], [0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2, ...blocks, 0]);
  }
  parts.push([0x3b]);
  return Buffer.from(parts.flat());
}

/** A solid-colour PNG, built with zlib so no binary is committed. */
export function tinyPng(rgb: [number, number, number], width = 64, height = 36): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb)))]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const DEMO_GUIDE = {
  sections: [
    {
      id: 'today',
      title: 'Today',
      summary: 'The daily shortlist, ranked, with the one next action.',
      route: '/today',
      gif: 'today.gif',
      poster: 'poster.jpg',
      steps: ['Open Today to see the ranked shortlist.', 'Pick a row to open its report.'],
      tips: ['Rows refresh whenever the scan finishes.'],
      chapter: 0,
    },
    {
      id: 'tracker',
      title: 'Tracker',
      summary: 'Every application in one table, filterable by status.',
      route: '/tracker',
      gif: 'tracker.gif',
      steps: ['Filter by status.', 'Open a row for its timeline.', 'Change a status from the action bar.'],
      chapter: 1,
    },
    {
      id: 'followups',
      title: 'Follow-ups',
      summary: 'Who to nudge next, and when.',
      route: '/followups',
      gif: 'followups.gif',
      steps: ['Log a follow-up.'],
      tips: ['Cadence comes from your profile.', 'Overdue ones sort first.'],
    },
  ],
};

/** Paragraphs long enough that a subsection is taller than the viewport, so the scroll-spy has something to track. */
const filler = (topic: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    type: 'text',
    text: `Paragraph ${i + 1} about the ${topic}. The quiet routine keeps every step small and every screen predictable, so a first time reader can follow along without guessing what the next click will do or where the data went afterward.`,
  }));

/**
 * A version 2 (documentation) guide: still images and a clip, each as a dark and light pair of the same size.
 * Subsection ids repeat across sections on purpose (`safety`), and the later subsections are far enough down to be lazy.
 */
export const DOCS_GUIDE = {
  version: 2,
  sections: [
    {
      id: 'getting-started',
      title: 'Getting started',
      summary: 'Launch the app and find your way around.',
      subsections: [
        {
          id: 'launch',
          title: 'Launch and sign in',
          summary: 'Open the app with the token the launcher prints.',
          blocks: [
            { type: 'text', text: 'Run the launcher, then open the printed link.' },
            { type: 'steps', items: ['Open a terminal in the repo.', 'Run npm start.', 'Open the link it prints.'] },
            { type: 'media', kind: 'image', file: 'launch.dark.png', fileLight: 'launch.light.png', alt: 'The Today page after signing in.', caption: 'Today, right after sign in.', width: 320, height: 180 },
            ...filler('first launch', 6),
          ],
        },
        {
          id: 'safety',
          title: 'Safety model',
          summary: 'The app never submits an application for you.',
          blocks: [{ type: 'text', text: 'Everything that writes asks first.' }, { type: 'tips', items: ['Read the confirmation dialog before you accept.'] }, ...filler('safety model', 8)],
        },
        {
          id: 'navigate',
          title: 'Find your way around',
          short: 'Layout',
          summary: 'The sidebar groups every page.',
          blocks: [...filler('sidebar', 4), { type: 'media', kind: 'image', file: 'navigate.dark.png', fileLight: 'navigate.light.png', alt: 'The sidebar with its groups.', caption: 'The sidebar.', width: 320, height: 180 }],
        },
        {
          id: 'appearance',
          title: 'Appearance',
          summary: 'Pick light, dark or follow the system.',
          blocks: [{ type: 'text', text: 'The theme switcher sits in the top bar.' }, ...filler('theme', 6)],
        },
      ],
    },
    {
      id: 'tracking',
      title: 'Tracking',
      summary: 'Keep the tracker current.',
      subsections: [
        {
          id: 'change-status',
          title: 'Change a status',
          summary: 'Move an application to its next state.',
          route: '/tracker',
          chapter: 1,
          blocks: [
            { type: 'text', text: 'Pick a row, then choose the new status.' },
            { type: 'media', kind: 'gif', file: 'status.dark.gif', fileLight: 'status.light.gif', poster: 'status.dark.png', posterLight: 'status.light.png', alt: 'A status being changed.', caption: 'Changing a status.', width: 320, height: 180 },
            ...filler('status', 3),
          ],
        },
        {
          id: 'follow-ups',
          title: 'Follow-ups and replies',
          summary: 'Who to nudge next, and when.',
          blocks: [{ type: 'text', text: 'Cadence comes from your profile.' }, { type: 'steps', items: ['Open Follow-ups.', 'Log a message.'] }, ...filler('cadence', 3)],
        },
        {
          id: 'safety',
          title: 'Safety of the data',
          summary: 'Nothing leaves the machine.',
          blocks: [{ type: 'text', text: 'Files stay in your data root.' }],
        },
      ],
    },
    {
      id: 'automation',
      title: 'Automation',
      summary: 'Let the machine do the routine work.',
      subsections: [{ id: 'sessions', title: 'Sessions', summary: 'Run a mode in the background.', blocks: [{ type: 'text', text: 'A session streams its output as it runs.' }] }],
    },
  ],
};

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
  writeClip(path.join(demo, 'demo-tour-light.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2', '-c:v', 'libx264', '-crf', '34', '-pix_fmt', 'yuv420p', '-g', '5', '-movflags', '+faststart'], 'tiny-tutorial-light.mp4');
  writeClip(path.join(demo, 'poster.jpg'), ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1:duration=1', '-frames:v', '1', '-q:v', '5'], 'poster.jpg');
  writeClip(path.join(demo, 'poster-light.jpg'), ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1:duration=1', '-frames:v', '1', '-q:v', '5'], 'poster-light.jpg');
  fs.writeFileSync(path.join(demo, 'demo-tour.srt'), DEMO_SRT);
  fs.writeFileSync(path.join(demo, 'script.md'), DEMO_SCRIPT);
  fs.writeFileSync(path.join(demo, 'guide.json'), JSON.stringify(DEMO_GUIDE));
  fs.writeFileSync(path.join(demo, 'today.gif'), tinyGif([0, 1]));
  fs.writeFileSync(path.join(demo, 'tracker.gif'), tinyGif([1, 2]));
  fs.writeFileSync(path.join(demo, 'followups.gif'), tinyGif([2, 3]));
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
      videoLight: 'demo-tour-light.mp4',
      subtitles: 'demo-tour.srt',
      poster: 'poster.jpg',
      posterLight: 'poster-light.jpg',
      transcript: 'script.md',
      guide: 'guide.json',
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
  // A tutorial with a guide whose optional transcript is missing: the page must say so in every view.
  const warn = path.join(root, 'warn-tour');
  fs.mkdirSync(warn, { recursive: true });
  fs.copyFileSync(path.join(demo, 'demo-tour.mp4'), path.join(warn, 'warn.mp4'));
  fs.copyFileSync(path.join(demo, 'today.gif'), path.join(warn, 'today.gif'));
  fs.writeFileSync(path.join(warn, 'guide.json'), JSON.stringify({ sections: [{ ...DEMO_GUIDE.sections[0], poster: undefined, chapter: undefined }] }));
  fs.writeFileSync(path.join(warn, 'tutorial.json'), JSON.stringify({ id: 'warn-tour', title: 'Warning tour', video: 'warn.mp4', transcript: 'missing.md', guide: 'guide.json' }));
  // A tutorial with a version 2 guide (dark and light media) and no light video.
  const docs = path.join(root, 'docs-tour');
  fs.mkdirSync(docs, { recursive: true });
  fs.copyFileSync(path.join(demo, 'demo-tour.mp4'), path.join(docs, 'docs.mp4'));
  fs.writeFileSync(path.join(docs, 'guide.json'), JSON.stringify(DOCS_GUIDE));
  const dark: [number, number, number] = [0x1b, 0x1f, 0x2a];
  const light: [number, number, number] = [0xf4, 0xf6, 0xfa];
  for (const name of ['launch', 'navigate', 'status']) {
    fs.writeFileSync(path.join(docs, `${name}.dark.png`), tinyPng(dark, 320, 180));
    fs.writeFileSync(path.join(docs, `${name}.light.png`), tinyPng(light, 320, 180));
  }
  fs.writeFileSync(path.join(docs, 'status.dark.gif'), tinyGif([0, 1], 320, 180));
  fs.writeFileSync(path.join(docs, 'status.light.gif'), tinyGif([2, 3], 320, 180));
  fs.writeFileSync(path.join(docs, 'tutorial.json'), JSON.stringify({ id: 'docs-tour', title: 'Docs tour', video: 'docs.mp4', guide: 'guide.json', chapters: [{ title: 'Intro', start: 0 }, { title: 'Middle', start: 0.5 }] }));
  writePartsTour(root, demo);
  const broken = path.join(root, 'broken-demo');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'tutorial.json'), '{ "id": "broken-demo", ');
}

const partSrt = (text: string) => `1\n00:00:00,100 --> 00:00:00,900\n${text}\n`;

/**
 * A tutorial in three parts, each with a dark and a light recording, subtitles and posters. Part a is 30 seconds long so a resume
 * point fits (more than 5 s in, more than 10 s before the end); parts b and c are the 2 second demo clips.
 * Its guide points one subsection at a chapter in part a and one at a chapter in part c. Only part b has a description of its own.
 */
function writePartsTour(root: string, demo: string): void {
  const dir = path.join(root, 'parts-tour');
  fs.mkdirSync(dir, { recursive: true });
  const long = (source: string) => ['-f', 'lavfi', '-i', `${source}=size=320x180:rate=1:duration=30`, '-c:v', 'libx264', '-crf', '48', '-pix_fmt', 'yuv420p', '-g', '1', '-movflags', '+faststart'];
  writeClip(path.join(dir, 'a.mp4'), long('testsrc'), 'part-30s.mp4');
  writeClip(path.join(dir, 'a-light.mp4'), long('testsrc2'), 'part-30s-light.mp4');
  for (const id of ['b', 'c']) {
    fs.copyFileSync(path.join(demo, 'demo-tour.mp4'), path.join(dir, `${id}.mp4`));
    fs.copyFileSync(path.join(demo, 'demo-tour-light.mp4'), path.join(dir, `${id}-light.mp4`));
  }
  for (const id of ['a', 'b', 'c']) {
    fs.copyFileSync(path.join(demo, 'poster.jpg'), path.join(dir, `${id}-poster.jpg`));
    fs.copyFileSync(path.join(demo, 'poster-light.jpg'), path.join(dir, `${id}-poster-light.jpg`));
    fs.writeFileSync(path.join(dir, `${id}.srt`), partSrt(`Part ${id} begins.`));
  }
  const part = (id: string, title: string, short: string, duration: number, chapters: Array<{ title: string; start: number }>, description?: string) => ({
    id,
    title,
    short,
    ...(description ? { description } : {}),
    video: `${id}.mp4`,
    videoLight: `${id}-light.mp4`,
    subtitles: `${id}.srt`,
    poster: `${id}-poster.jpg`,
    posterLight: `${id}-poster-light.jpg`,
    duration,
    chapters,
  });
  fs.writeFileSync(
    path.join(dir, 'guide.json'),
    JSON.stringify({
      version: 2,
      sections: [
        {
          id: 'basics',
          title: 'Basics',
          summary: 'The first steps, across the parts.',
          subsections: [
            { id: 'launch', title: 'Launching the app', short: 'Launch', summary: 'Start it up.', chapter: 1, blocks: [{ type: 'text', text: 'Run the launcher.' }] },
            { id: 'detail', title: 'Application detail', short: 'Detail', summary: 'One application, in full.', chapter: 5, blocks: [{ type: 'text', text: 'Open a row.' }] },
          ],
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'tutorial.json'),
    JSON.stringify({
      id: 'parts-tour',
      title: 'Parts tour',
      description: 'A tour in three parts.',
      guide: 'guide.json',
      parts: [
        part('a', 'Start here: safety and launch', 'Start here', 30, [{ title: 'Intro and safety', start: 0 }, { title: 'Launch and token', start: 12 }]),
        part('b', 'Today and the inbox', 'Today & inbox', 2, [{ title: 'Today', start: 0 }, { title: 'Pipeline', start: 1 }], 'Where new roles land, and how to sort them.'),
        part('c', 'The tracker', 'Tracker', 2, [{ title: 'Tracker', start: 0 }, { title: 'Application detail', start: 1 }]),
      ],
    }),
  );
}
