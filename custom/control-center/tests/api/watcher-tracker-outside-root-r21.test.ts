import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BusEvent, EventBus } from '../../server/watch/bus.js';
import { startWatcher } from '../../server/watch/watcher.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';
import { copyFixtureRoot, makeTestApp, type TestApp } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';

type Changed = { domain: string; paths: string[] };

describe('the watcher with CAREER_OPS_TRACKER outside the data root (FU-trkwatch-01)', () => {
  let before: string | undefined;
  let t: TestApp | null = null;
  beforeEach(() => {
    before = process.env.CAREER_OPS_TRACKER;
  });
  afterEach(async () => {
    await t?.close();
    t = null;
    if (before === undefined) delete process.env.CAREER_OPS_TRACKER;
    else process.env.CAREER_OPS_TRACKER = before;
  });

  /**
   * Writes `file` until the app's watcher reports it, as set-status.mjs would rewrite it, and returns the events that
   * name it. Other events are ignored: FSEvents can replay the fixture copy made just before the watcher started.
   */
  async function reported(app: TestApp, file: string, write: (i: number) => string): Promise<Changed[]> {
    // Compared by real folder and name: the watcher may report a symlinked folder's other spelling (/var vs /private/var).
    const spelling = (p: string) => {
      try {
        return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
      } catch (err) {
        // A reported unlink can name a folder that is already gone.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return p;
        throw err;
      }
    };
    const target = spelling(file);
    const names = (ev: Changed) => ev.paths.some((p) => spelling(path.resolve(app.cfg.dataRoot, p)) === target);
    const seen: Changed[] = [];
    const off = app.bus.onEvent((ev: BusEvent) => {
      if (ev.type === 'data.changed' && names(ev.payload as Changed)) seen.push(ev.payload as Changed);
    });
    try {
      // FSEvents can miss a write made right after the watcher starts, so the write is repeated until one is seen.
      const deadline = Date.now() + 10_000;
      for (let i = 0; seen.length === 0 && Date.now() < deadline; i++) {
        if (i % 10 === 0) fs.writeFileSync(file, write(i));
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      off();
    }
    return seen;
  }

  it('refreshes the tracker domain for a write to the resolved tracker and to the status log beside it', async () => {
    const elsewhere = tempDir('cc-tracker-elsewhere-');
    const tracker = path.join(elsewhere, 'applications.md');
    const statusLog = path.join(elsewhere, 'status-log.tsv');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    fs.writeFileSync(statusLog, '');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true });

    const trackerEvents = await reported(t, tracker, (i) => `# Applications Tracker ${i}\n`);
    expect(trackerEvents.map((e) => e.domain)).toContain('tracker');
    const logEvents = await reported(t, statusLog, (i) => `1\t2026-10-11\tEvaluated\tApplied\tcli\tround ${i}\n`);
    expect(logEvents.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('refreshes the tracker domain when the first status change creates the status log', async () => {
    const elsewhere = tempDir('cc-tracker-elsewhere-');
    const tracker = path.join(elsewhere, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true });

    const events = await reported(t, path.join(elsewhere, 'status-log.tsv'), (i) => `1\t2026-10-11\tEvaluated\tApplied\tcli\tround ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('watches only the tracker and its status log in the tracker folder', async () => {
    const elsewhere = tempDir('cc-tracker-elsewhere-');
    const tracker = path.join(elsewhere, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    fs.writeFileSync(path.join(elsewhere, 'status-log.tsv'), '');
    fs.writeFileSync(path.join(elsewhere, 'notes.md'), 'unrelated\n');
    const watcher = startWatcher(copyFixtureRoot(), { publish: () => undefined } as unknown as EventBus, 20, [tracker]);
    try {
      await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
      expect([...(watcher.getWatched()[elsewhere] ?? [])].sort()).toEqual(['applications.md', 'status-log.tsv']);
    } finally {
      await watcher.close();
    }
  });

  it('sees the status log created beside a tracker the data root\'s ignore rules would otherwise hide', async () => {
    // Realpathed, so the tracker has one spelling (macOS's /var is a symlink to /private/var).
    const root = fs.realpathSync(copyFixtureRoot());
    const folder = path.join(root, 'data', 'node_modules', 'career');
    fs.mkdirSync(folder, { recursive: true });
    const tracker = path.join(folder, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true, dataRoot: root });

    const events = await reported(t, path.join(folder, 'status-log.tsv'), (i) => `1\t2026-10-11\tEvaluated\tApplied\tcli\tround ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('refreshes the tracker domain for a tracker under the data root with a name the watcher does not otherwise know', async () => {
    const root = copyFixtureRoot();
    const tracker = path.join(root, 'data', 'my-apps.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true, dataRoot: root });

    const events = await reported(t, tracker, (i) => `# Applications Tracker ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('refreshes the tracker domain for the status log set-status.mjs writes beside a symlinked tracker\'s real file', async () => {
    const real = tempDir('cc-tracker-real-');
    const linkDir = tempDir('cc-tracker-link-');
    fs.writeFileSync(path.join(real, 'applications.md'), '# Applications Tracker\n');
    const link = path.join(linkDir, 'applications.md');
    fs.symlinkSync(path.join(real, 'applications.md'), link);
    process.env.CAREER_OPS_TRACKER = link;
    t = await makeTestApp({ watch: true });

    // set-status.mjs appends to dirname(resolveTrackerPath()), the realpath of the tracker.
    const events = await reported(t, path.join(real, 'status-log.tsv'), (i) => `1\t2026-10-11\tEvaluated\tApplied\tcli\tround ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('resolves a relative CAREER_OPS_TRACKER against the code root the tracker scripts run in', async () => {
    const elsewhere = tempDir('cc-tracker-elsewhere-');
    const tracker = path.join(elsewhere, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    const relative = path.relative(DEFAULT_CODE_ROOT, tracker);
    // Only meaningful while the server's cwd differs from the code root, as it does under vitest.
    expect(path.resolve(relative)).not.toBe(tracker);
    process.env.CAREER_OPS_TRACKER = relative;
    t = await makeTestApp({ watch: true });

    const events = await reported(t, tracker, (i) => `# Applications Tracker ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);

  it('keeps reporting the tracker across the temp-file-and-rename writes set-status.mjs and merge-tracker.mjs make', async () => {
    const elsewhere = tempDir('cc-tracker-elsewhere-');
    const tracker = path.join(elsewhere, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true });
    const atomic = (text: string) => {
      const tmp = path.join(elsewhere, `.applications.md.${process.pid}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, tracker);
      return fs.readFileSync(tracker, 'utf8');
    };

    for (const round of ['first', 'second']) {
      const events = await reported(t, tracker, (i) => atomic(`# Applications Tracker ${round} ${i}\n`));
      expect({ round, domains: events.map((e) => e.domain) }).toEqual({ round, domains: expect.arrayContaining(['tracker']) });
    }
  }, 30_000);

  it('sees the status log created beside a tracker whose folder sits under a node_modules folder outside the data root', async () => {
    const elsewhere = path.join(tempDir('cc-tracker-elsewhere-'), 'node_modules', 'career');
    fs.mkdirSync(elsewhere, { recursive: true });
    const tracker = path.join(elsewhere, 'applications.md');
    fs.writeFileSync(tracker, '# Applications Tracker\n');
    process.env.CAREER_OPS_TRACKER = tracker;
    t = await makeTestApp({ watch: true });

    const events = await reported(t, path.join(elsewhere, 'status-log.tsv'), (i) => `1\t2026-10-11\tEvaluated\tApplied\tcli\tround ${i}\n`);
    expect(events.map((e) => e.domain)).toContain('tracker');
  }, 30_000);
});
