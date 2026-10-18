import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { inputsKey, readInsight } from '../../server/domains/insightsCache.js';
import { copyFixtureRoot, FIXTURE_ROOT, testConfig } from '../helpers/app.js';
import { tempDir } from '../helpers/tmp.js';
import { execNoShell, type Exec } from '../../server/routes/system.js';
import { findAction } from '../../server/actions/registry.js';
import { childEnv } from '../../server/system/child-env.js';
import { DEFAULT_CODE_ROOT } from '../../server/config.js';

describe('the insights cache key', () => {
  // upskill leaves out skills cv.md already has and story provenance traces stories to cv.md and the digest.
  for (const rel of ['cv.md', 'article-digest.md']) {
    it(`changes when ${rel} is edited, so cached insights are recomputed`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache key covers every file the insights scripts read', () => {
  // assessment-log.mjs, salary-gap.mjs:39, process-quality.mjs:45 and rejection-latency.mjs:64 (data/ first, then the
  // root copy), funnel-velocity.mjs:251, detect-reposts.mjs:76.
  for (const rel of ['data/assessments.tsv', 'data/salary-observations.tsv', 'data/active-interviews.md', 'active-interviews.md', 'config/benchmarks.yml', 'portals.yml']) {
    it(`changes when ${rel} is added or edited`, () => {
      const root = copyFixtureRoot();
      const file = path.join(root, rel);
      fs.rmSync(file, { force: true });
      const before = inputsKey(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x\n');
      const added = inputsKey(root);
      expect(added).not.toBe(before);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(file, later, later);
      expect(inputsKey(root)).not.toBe(added);
    });
  }

  for (const rel of ['reports/001-acme-robotics.md', 'interview-prep/story-bank.md']) {
    it(`changes when ${rel} is edited in place (its folder's own time does not move)`, () => {
      const root = copyFixtureRoot();
      const dir = path.dirname(path.join(root, rel));
      const dirTime = fs.statSync(dir).mtime;
      const before = inputsKey(root);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(root, rel), later, later);
      fs.utimesSync(dir, dirTime, dirTime);
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache key on a root-layout tracker (R7-14)', () => {
  // set-status.mjs logs beside the tracker, so a tracker at the top keeps status-log.tsv at the top too.
  for (const rel of ['applications.md', 'status-log.tsv']) {
    it(`changes when the top-level ${rel} is added or edited`, () => {
      const root = copyFixtureRoot();
      const before = inputsKey(root);
      fs.writeFileSync(path.join(root, rel), 'x\n');
      expect(inputsKey(root)).not.toBe(before);
    });
  }
});

describe('the insights cache with CAREER_OPS_TRACKER outside the data root (R7-14 review)', () => {
  it('recomputes when that tracker or the status-log.tsv beside it changes', async () => {
    const outside = tempDir('cc-outside-tracker-');
    const tracker = path.join(outside, 'applications.md');
    fs.copyFileSync(path.join(FIXTURE_ROOT, 'data', 'applications.md'), tracker);
    fs.writeFileSync(path.join(outside, 'status-log.tsv'), '2\t2026-10-01\tEvaluated\tApplied\tweb\t\n');
    const before = process.env.CAREER_OPS_TRACKER;
    process.env.CAREER_OPS_TRACKER = tracker;
    let runs = 0;
    const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
    try {
      const cfg = testConfig();
      await readInsight(cfg, exec, 'funnelVelocity');
      await readInsight(cfg, exec, 'funnelVelocity');
      expect(runs).toBe(1);
      for (const file of [path.join(outside, 'status-log.tsv'), tracker]) {
        const later = new Date(Date.now() + 60_000 * (runs + 1));
        fs.utimesSync(file, later, later);
        const ran = runs;
        await readInsight(cfg, exec, 'funnelVelocity');
        expect(runs, `${file} changed`).toBe(ran + 1);
      }
      expect(runs).toBe(3);
    } finally {
      if (before === undefined) delete process.env.CAREER_OPS_TRACKER;
      else process.env.CAREER_OPS_TRACKER = before;
    }
  });
});

describe('the insights cache is best-effort (R27-srv-dom-a-L1-01)', () => {
  it('given a cache file that cannot be written, when a script runs cleanly, then its result is still returned and no temp file is left', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    const dir = path.join(cfg.dataRoot, 'data', 'control-center', 'insights');
    // A directory where the cache file goes: every write of it fails.
    fs.mkdirSync(path.join(dir, 'funnelVelocity.json'), { recursive: true });
    const read = await readInsight(cfg, exec, 'funnelVelocity', { recompute: true });
    expect(read).toMatchObject({ kind: 'ok', json: { ok: true }, fromCache: false });
    expect(fs.readdirSync(dir)).toEqual(['funnelVelocity.json']);
  });

  it('given a cache write that fails partway (a full disk), when a script runs cleanly, then its result is still returned and no partial file is left', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    const dir = path.join(cfg.dataRoot, 'data', 'control-center', 'insights');
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      if (!String(file).startsWith(dir)) return real(file, data, ...rest);
      real(file, String(data).slice(0, 5));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      const read = await readInsight(cfg, exec, 'funnelVelocity', { recompute: true });
      expect(read).toMatchObject({ kind: 'ok', json: { ok: true }, fromCache: false });
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('given a file where the cache folder goes, when a script runs cleanly, then its result is still returned', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    // mkdir fails with ENOTDIR, and so does removing the temp file under it.
    fs.mkdirSync(path.join(cfg.dataRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(cfg.dataRoot, 'data', 'control-center'), 'not a folder\n');
    const read = await readInsight(cfg, exec, 'funnelVelocity', { recompute: true });
    expect(read).toMatchObject({ kind: 'ok', json: { ok: true }, fromCache: false });
  });
});

describe('the insights cache across days (R8-09)', () => {
  // rejection-latency.mjs, weekly-digest.mjs, funnel-velocity.mjs and company-history.mjs all count from today, so a
  // result computed yesterday is stale even when no input file changed.
  it('serves the cached result for the rest of the local day and recomputes on the next one', async () => {
    let runs = 0;
    const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
    const cfg = testConfig();
    // Local time in America/Los_Angeles (vitest pins TZ): 08:00 and 23:30 on 2026-10-05, then 00:30 on 2026-10-06.
    const morning = Date.parse('2026-10-05T15:00:00.000Z');
    const night = Date.parse('2026-10-06T06:30:00.000Z');
    const nextDay = Date.parse('2026-10-06T07:30:00.000Z');
    await readInsight(cfg, exec, 'rejectionLatency', { now: () => morning });
    expect((await readInsight(cfg, exec, 'rejectionLatency', { now: () => night })).fromCache).toBe(true);
    expect(runs).toBe(1);
    const next = await readInsight(cfg, exec, 'rejectionLatency', { now: () => nextDay });
    expect(next.fromCache).toBe(false);
    expect(runs).toBe(2);
  });

  it('does not cache a failed run, so the next load retries it instead of serving the failure all day (R12-srv-dom-a-L1-02)', async () => {
    let runs = 0;
    let code = 1;
    const exec: Exec = async () => ((runs += 1), { code, stdout: code === 0 ? '{"ok":true}' : '', stderr: '' });
    const cfg = testConfig();
    expect((await readInsight(cfg, exec, 'funnelVelocity')).kind).toBe('failed');
    code = 0;
    const retry = await readInsight(cfg, exec, 'funnelVelocity');
    expect(retry).toMatchObject({ kind: 'ok', fromCache: false });
    expect(runs).toBe(2);
    expect((await readInsight(cfg, exec, 'funnelVelocity')).fromCache).toBe(true);
    // A failure an older build cached under today's key is not served either.
    const file = path.join(cfg.dataRoot, 'data', 'control-center', 'insights', 'funnelVelocity.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), kind: 'failed', exit: 1 }));
    expect(await readInsight(cfg, exec, 'funnelVelocity')).toMatchObject({ kind: 'ok', fromCache: false });
    expect(runs).toBe(3);
  });
});

describe('Company history reads the data root, wherever it is (SW7-server-01)', () => {
  it('the insight builds its cards from the data root\'s tracker, follow-ups and scan history, not the code checkout\'s', async () => {
    const root = copyFixtureRoot();
    const cfg = testConfig({ dataRoot: root });
    const read = await readInsight(cfg, execNoShell, 'companyHistory', { recompute: true });
    expect(read.kind, read.text).toBe('ok');
    const json = read.json as { metadata: { sources: Record<string, boolean> }; companies: Array<{ company: string }> };
    expect(json.metadata.sources).toMatchObject({ tracker: true, followups: true, scanHistory: true });
    expect(json.companies.map((c) => c.company)).toContain('Acme Robotics');
  });

  it('a tracker or portals file named in the environment wins, and the cache is keyed on the tracker the child reads (SW7-server-01 review)', async () => {
    const root = copyFixtureRoot();
    const elsewhere = path.join(tempDir('cc-tracker-elsewhere-'), 'applications.md');
    fs.copyFileSync(path.join(root, 'data', 'applications.md'), elsewhere);
    const portals = path.join(tempDir('cc-portals-elsewhere-'), 'portals.yml');
    fs.copyFileSync(path.join(root, 'portals.yml'), portals);
    const prior = { tracker: process.env.CAREER_OPS_TRACKER, portals: process.env.CAREER_OPS_PORTALS };
    process.env.CAREER_OPS_TRACKER = elsewhere;
    process.env.CAREER_OPS_PORTALS = portals;
    try {
      const seen: Array<Record<string, string | undefined>> = [];
      const capture: Exec = async (cmd, args, opts) => {
        seen.push({ ...(opts.env as Record<string, string | undefined>) });
        return execNoShell(cmd, args, opts);
      };
      const read = await readInsight(testConfig({ dataRoot: root }), capture, 'companyHistory', { recompute: true });
      expect(read.kind, read.text).toBe('ok');
      expect(seen[0]!.CAREER_OPS_TRACKER ?? process.env.CAREER_OPS_TRACKER).toBe(elsewhere);
      expect(seen[0]!.CAREER_OPS_PORTALS ?? process.env.CAREER_OPS_PORTALS).toBe(portals);
      expect(read.inputsKey.startsWith(`${inputsKey(root, fs.realpathSync(elsewhere))}|`)).toBe(true);
      const cmd = findAction('insights.companyHistory')!.build({}, { codeRoot: '/code', dataRoot: root, tmpInputs: [], trackerPath: elsewhere });
      expect(cmd.env?.CAREER_OPS_TRACKER ?? process.env.CAREER_OPS_TRACKER).toBe(elsewhere);
      expect(cmd.env?.CAREER_OPS_PORTALS ?? process.env.CAREER_OPS_PORTALS).toBe(portals);
    } finally {
      for (const [k, v] of [['CAREER_OPS_TRACKER', prior.tracker], ['CAREER_OPS_PORTALS', prior.portals]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('the Company history action is told the same files', () => {
    const root = copyFixtureRoot();
    const cmd = findAction('insights.companyHistory')!.build({}, { codeRoot: '/code', dataRoot: root, tmpInputs: [], trackerPath: path.join(root, 'data', 'applications.md') });
    expect(cmd.args).toEqual(expect.arrayContaining(['--followups', path.join(root, 'data', 'follow-ups.md'), '--scan-history', path.join(root, 'data', 'scan-history.tsv')]));
    expect(cmd.env).toMatchObject({ CAREER_OPS_TRACKER: path.join(root, 'data', 'applications.md'), CAREER_OPS_PORTALS: path.join(root, 'portals.yml') });
  });
});

describe('Company history with a second-lane CAREER_OPS_PORTALS in the server environment (R18-srv-dom-a-L2-01)', () => {
  it('the child really reads the lane file (the server blanks the inherited value), and the cache is keyed on it', async () => {
    const root = copyFixtureRoot();
    const lane = path.join(tempDir('cc-portals-lane-'), 'portals.yml');
    fs.copyFileSync(path.join(root, 'portals.yml'), lane);
    const prior = process.env.CAREER_OPS_PORTALS;
    process.env.CAREER_OPS_PORTALS = lane;
    try {
      const seen: NodeJS.ProcessEnv[] = [];
      // What the child sees: execNoShell starts it with childEnv(opts.env).
      const exec: Exec = async (_cmd, _args, opts) => (seen.push(childEnv(opts.env)), { code: 0, stdout: '{"ok":true}', stderr: '' });
      const cfg = testConfig({ dataRoot: root });
      await readInsight(cfg, exec, 'companyHistory');
      expect(seen[0]!.CAREER_OPS_PORTALS).toBe(lane);
      expect((await readInsight(cfg, exec, 'companyHistory')).fromCache).toBe(true);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(lane, later, later);
      expect((await readInsight(cfg, exec, 'companyHistory')).fromCache).toBe(false);
      expect(seen).toHaveLength(2);
    } finally {
      if (prior === undefined) delete process.env.CAREER_OPS_PORTALS;
      else process.env.CAREER_OPS_PORTALS = prior;
    }
  });
});

const CODE_FILES = ['funnel-velocity.mjs', 'tracker-utils.mjs', 'lib/local-today.mjs', 'templates/states.yml', 'templates/benchmarks.yml'];

// A checkout with only what readInsight loads itself; the scripts are never run (exec is a stub).
function stubCodeRoot(): string {
  const root = tempDir('cc-insights-code-');
  fs.copyFileSync(path.join(DEFAULT_CODE_ROOT, 'path-resolver.mjs'), path.join(root, 'path-resolver.mjs'));
  for (const rel of CODE_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '// v1\n');
  }
  return root;
}

describe('the insights cache after a code update (R18-srv-dom-a-L1-01)', () => {
  // funnel-velocity.mjs and company-history.mjs fall back to the shipped templates/benchmarks.yml.
  for (const rel of CODE_FILES) {
    it(`recomputes the same day with unchanged data when ${rel} in the code checkout changes`, async () => {
      let runs = 0;
      const exec: Exec = async () => ((runs += 1), { code: 0, stdout: '{"ok":true}', stderr: '' });
      const cfg = testConfig({ codeRoot: stubCodeRoot() });
      await readInsight(cfg, exec, 'funnelVelocity');
      expect((await readInsight(cfg, exec, 'funnelVelocity')).fromCache).toBe(true);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(cfg.codeRoot, rel), later, later);
      expect((await readInsight(cfg, exec, 'funnelVelocity')).fromCache).toBe(false);
      expect(runs).toBe(2);
    });
  }
});

describe('Company history with a relative CAREER_OPS_PORTALS (R18-srv-dom-a-L2-01 review)', () => {
  it('keys the cache on the file the child reads, relative to the code checkout it runs in', async () => {
    const codeRoot = stubCodeRoot();
    const rel = path.join('lanes', 'b', 'portals.yml');
    fs.mkdirSync(path.dirname(path.join(codeRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, rel), 'tracked_companies: []\n');
    const prior = process.env.CAREER_OPS_PORTALS;
    process.env.CAREER_OPS_PORTALS = rel;
    try {
      const cwds: Array<string | undefined> = [];
      const exec: Exec = async (_cmd, _args, opts) => (cwds.push(opts.cwd), { code: 0, stdout: '{"ok":true}', stderr: '' });
      const cfg = testConfig({ codeRoot });
      await readInsight(cfg, exec, 'companyHistory');
      expect(cwds[0]).toBe(codeRoot);
      expect((await readInsight(cfg, exec, 'companyHistory')).fromCache).toBe(true);
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(codeRoot, rel), later, later);
      expect((await readInsight(cfg, exec, 'companyHistory')).fromCache).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CAREER_OPS_PORTALS;
      else process.env.CAREER_OPS_PORTALS = prior;
    }
  });
});

describe('concurrent loads of one insight share a single run (R32-srv-dom-a-X-02)', () => {
  const gated = () => {
    let runs = 0;
    const gates: Array<{ resolve: (r: { code: number; stdout: string; stderr: string }) => void; reject: (e: Error) => void }> = [];
    const exec: Exec = () => {
      runs += 1;
      return new Promise((resolve, reject) => gates.push({ resolve, reject }));
    };
    return { exec, gates, runs: () => runs };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('given no cache, when two loads arrive while the script runs, then the script runs once and both get its result', async () => {
    const cfg = testConfig();
    const g = gated();
    const a = readInsight(cfg, g.exec, 'funnelVelocity');
    const b = readInsight(cfg, g.exec, 'funnelVelocity');
    await settle();
    expect(g.runs()).toBe(1);
    g.gates[0]!.resolve({ code: 0, stdout: '{"n":1}', stderr: '' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toMatchObject({ kind: 'ok', json: { n: 1 } });
    expect(rb).toMatchObject({ kind: 'ok', json: { n: 1 } });
  });

  it('given a run in flight, when a recompute is asked for, then it joins that run instead of starting another', async () => {
    const cfg = testConfig();
    const g = gated();
    const a = readInsight(cfg, g.exec, 'funnelVelocity');
    const b = readInsight(cfg, g.exec, 'funnelVelocity', { recompute: true });
    await settle();
    expect(g.runs()).toBe(1);
    g.gates[0]!.resolve({ code: 0, stdout: '{"n":2}', stderr: '' });
    expect((await b).json).toEqual({ n: 2 });
    await a;
  });

  it('given a shared run that throws, when the next load arrives, then the script runs again', async () => {
    const cfg = testConfig();
    const g = gated();
    const a = readInsight(cfg, g.exec, 'funnelVelocity');
    const b = readInsight(cfg, g.exec, 'funnelVelocity');
    await settle();
    g.gates[0]!.reject(new Error('spawn failed'));
    await expect(a).rejects.toThrow('spawn failed');
    await expect(b).rejects.toThrow('spawn failed');
    const c = readInsight(cfg, g.exec, 'funnelVelocity');
    await settle();
    expect(g.runs()).toBe(2);
    g.gates[1]!.resolve({ code: 0, stdout: '{"n":3}', stderr: '' });
    expect((await c).json).toEqual({ n: 3 });
  });

  it('given a shared run that fails, when the next load arrives, then the script runs again', async () => {
    const cfg = testConfig();
    const g = gated();
    const a = readInsight(cfg, g.exec, 'funnelVelocity');
    await settle();
    g.gates[0]!.resolve({ code: 1, stdout: '', stderr: 'boom' });
    expect((await a).kind).toBe('failed');
    const b = readInsight(cfg, g.exec, 'funnelVelocity');
    await settle();
    expect(g.runs()).toBe(2);
    g.gates[1]!.resolve({ code: 0, stdout: '{}', stderr: '' });
    await b;
  });
});

describe('the insights cache under overlapping runs for changed inputs (R35-srv-dom-a-X-01)', () => {
  it('given a run for older inputs that ends after the run for newer ones, when both settle, then the cache keeps the newer run', async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const exec: Exec = () =>
      new Promise((resolve) => {
        const n = (started += 1);
        const done = () => resolve({ code: 0, stdout: JSON.stringify({ run: n }), stderr: '' });
        // Only the two overlapping runs wait to be released; a rerun after them answers at once.
        if (n > 2) done();
        else releases.push(done);
      });
    const cfg = testConfig();
    const older = readInsight(cfg, exec, 'funnelVelocity');
    await vi.waitFor(() => expect(started).toBe(1));
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(cfg.dataRoot, 'data', 'applications.md'), later, later);
    const newer = readInsight(cfg, exec, 'funnelVelocity');
    await vi.waitFor(() => expect(started).toBe(2));
    releases[1]!();
    expect((await newer).json).toEqual({ run: 2 });
    releases[0]!();
    expect((await older).json).toEqual({ run: 1 });
    const again = await readInsight(cfg, exec, 'funnelVelocity');
    expect(again).toMatchObject({ fromCache: true, json: { run: 2 } });
    expect(started).toBe(2);
    expect(fs.readdirSync(path.join(cfg.dataRoot, 'data', 'control-center', 'insights'))).toEqual(['funnelVelocity.json']);
  });
});
